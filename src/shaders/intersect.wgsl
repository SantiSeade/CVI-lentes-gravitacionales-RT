// =============================================================================
//  intersect.wgsl — Intersección micro-segmento vs escena (BVH TLAS/BLAS y fuerza bruta).
// =============================================================================
//  ¿Cómo choca un rayo curvo con una malla de triángulos?
//    Cada paso del integrador RK4 mueve el fotón de `p0` a `p1`. Entre esos dos
//    puntos tan cercanos aproximamos el trayecto por el MICRO-SEGMENTO recto:
//
//        P(t) = p0 + t · d,     con d = p1 - p0   y   t ∈ [0, 1]
//
//  Propiedad clave de las transformaciones afines (sección 4.4):
//    Si transformamos `p0` y `d` al espacio local de una instancia con su
//    matriz `local_from_world` SIN normalizar `d`:
//
//        p0_local = (M⁻¹ · (p0, 1)).xyz
//        d_local  = (M⁻¹ · (d,  0)).xyz
//
//    entonces cualquier impacto a parámetro `t` en espacio local corresponde
//    EXACTAMENTE al mismo `t ∈ [0, 1]` en espacio de mundo. Así podemos
//    comparar directamente impactos entre distintas instancias con escalas y
//    rotaciones diferentes.
// =============================================================================

struct HitInfo {
  hit: bool,
  t: f32,
  world_pos: vec3f,
  world_normal: vec3f,
  local_pos: vec3f,
  material_id: u32,
  bvh_nodes_visited: u32,
}

// -----------------------------------------------------------------------------
//  1. Método de las losas (slab test): segmento P(t) = p0 + t·d vs AABB
// -----------------------------------------------------------------------------
//  Una AABB es la intersección de 3 intervalos [min_x, max_x], [min_y, max_y],
//  [min_z, max_z]. Para cada eje calculamos en qué intervalo [t1, t2] el
//  segmento está dentro de esas dos "losas" paralelas y tomamos la intersección
//  de los 3 intervalos con [0, t_max]. Si el intervalo resultante no es vacío,
//  devolvemos su extremo inferior `t_enter`; si no corta, devolvemos 1e30.
fn intersect_aabb(p0: vec3f, inv_d: vec3f, bmin: vec3f, bmax: vec3f, t_max: f32) -> f32 {
  let t0 = (bmin - p0) * inv_d;
  let t1 = (bmax - p0) * inv_d;
  let t_smaller = min(t0, t1);
  let t_bigger = max(t0, t1);
  let t_enter = max(max(t_smaller.x, t_smaller.y), max(t_smaller.z, 0.0));
  let t_exit = min(min(t_bigger.x, t_bigger.y), min(t_bigger.z, t_max));
  if (t_enter <= t_exit) {
    return t_enter;
  }
  return 1e30;
}

// Invierte cada componente de `d` protegiendo contra divisiones por cero.
fn safe_inv_dir(d: vec3f) -> vec3f {
  let eps = 1e-9;
  let sx = select(-1.0, 1.0, d.x >= 0.0);
  let sy = select(-1.0, 1.0, d.y >= 0.0);
  let sz = select(-1.0, 1.0, d.z >= 0.0);
  return vec3f(
    1.0 / select(d.x, sx * eps, abs(d.x) < eps),
    1.0 / select(d.y, sy * eps, abs(d.y) < eps),
    1.0 / select(d.z, sz * eps, abs(d.z) < eps),
  );
}

// -----------------------------------------------------------------------------
//  2. Algoritmo de Möller-Trumbore: segmento P(t) = p0 + t·d vs triángulo
// -----------------------------------------------------------------------------
//  Expresa el punto sobre el triángulo en coordenadas baricéntricas (u, v):
//      T(u, v) = v0 + u·(v1 - v0) + v·(v2 - v0),   con u ≥ 0, v ≥ 0, u + v ≤ 1
//  e iguala P(t) = T(u, v). Esto da un sistema lineal 3×3 en (t, u, v) que se
//  resuelve con la regla de Cramer usando un producto vectorial y dos triples
//  productos escalares. Devuelve (t, u, v), o t = 1e30 si no hay impacto.
fn intersect_triangle(p0: vec3f, d: vec3f, v0: vec3f, v1: vec3f, v2: vec3f, t_max: f32) -> vec3f {
  let e1 = v1 - v0;
  let e2 = v2 - v0;
  let h = cross(d, e2);
  let det = dot(e1, h);
  if (abs(det) < 1e-8) {
    return vec3f(1e30, 0.0, 0.0);
  }
  let inv_det = 1.0 / det;
  let s = p0 - v0;
  let u = dot(s, h) * inv_det;
  if (u < 0.0 || u > 1.0) {
    return vec3f(1e30, 0.0, 0.0);
  }
  let q = cross(s, e1);
  let v = dot(d, q) * inv_det;
  if (v < 0.0 || (u + v) > 1.0) {
    return vec3f(1e30, 0.0, 0.0);
  }
  let t = dot(e2, q) * inv_det;
  if (t > 1e-5 && t < t_max) {
    return vec3f(t, u, v);
  }
  return vec3f(1e30, 0.0, 0.0);
}

// Rellena los datos geométricos del impacto (posición local/mundo y normal suavizada).
fn finalize_hit(
  inst: Instance,
  mesh: MeshInfo,
  tri_idx: u32,
  t: f32,
  u: f32,
  v: f32,
  p0_local: vec3f,
  d_local: vec3f,
  visited: u32,
) -> HitInfo {
  let i0 = mesh.vertex_offset + indices[tri_idx * 3u + 0u];
  let i1 = mesh.vertex_offset + indices[tri_idx * 3u + 1u];
  let i2 = mesh.vertex_offset + indices[tri_idx * 3u + 2u];
  let n0 = vertices[i0].normal.xyz;
  let n1 = vertices[i1].normal.xyz;
  let n2 = vertices[i2].normal.xyz;
  let w = 1.0 - u - v;
  let n_local = normalize(w * n0 + u * n1 + v * n2);
  let local_pos = p0_local + t * d_local;
  let world_pos = (inst.world_from_local * vec4f(local_pos, 1.0)).xyz;
  // Para transformaciones con rotación y escala uniforme (planetas/lunas),
  // transformar la normal con la parte lineal 3×3 y normalizar es exacto.
  let world_normal = normalize((inst.world_from_local * vec4f(n_local, 0.0)).xyz);

  var out: HitInfo;
  out.hit = true;
  out.t = t;
  out.world_pos = world_pos;
  out.world_normal = world_normal;
  out.local_pos = local_pos;
  out.material_id = inst.material_id;
  out.bvh_nodes_visited = visited;
  return out;
}

// -----------------------------------------------------------------------------
//  3. Recorrido del BLAS de una instancia con pila explícita (sin recursión)
// -----------------------------------------------------------------------------
fn traverse_blas(
  p0_local: vec3f,
  d_local: vec3f,
  mesh: MeshInfo,
  t_max_in: f32,
) -> vec4f {
  // Devuelve (best_t, best_u, best_v, bitcast<f32>(best_tri)), más el conteo de
  // nodos en una variable global al hilo (se suma en el llamador).
  let inv_d = safe_inv_dir(d_local);
  var stack: array<u32, 32>;
  var sp: u32 = 0u;
  stack[sp] = mesh.blas_offset;
  sp = sp + 1u;

  var best_t = t_max_in;
  var best_u = 0.0;
  var best_v = 0.0;
  var best_tri: u32 = 0xffffffffu;

  while (sp > 0u) {
    sp = sp - 1u;
    let node_idx = stack[sp];
    let node = blas_nodes[node_idx];

    if (intersect_aabb(p0_local, inv_d, node.aabb_min, node.aabb_max, best_t) >= 1e29) {
      continue;
    }

    if (node.count > 0u) {
      for (var i = 0u; i < node.count; i = i + 1u) {
        let tri = node.right_or_first + i;
        let v0 = vertices[mesh.vertex_offset + indices[tri * 3u + 0u]].position.xyz;
        let v1 = vertices[mesh.vertex_offset + indices[tri * 3u + 1u]].position.xyz;
        let v2 = vertices[mesh.vertex_offset + indices[tri * 3u + 2u]].position.xyz;
        let tuv = intersect_triangle(p0_local, d_local, v0, v1, v2, best_t);
        if (tuv.x < best_t) {
          best_t = tuv.x;
          best_u = tuv.y;
          best_v = tuv.z;
          best_tri = tri;
        }
      }
    } else if (sp + 2u <= BVH_STACK_SIZE) {
      let left_idx = node_idx + 1u;
      let right_idx = node.right_or_first;
      let left_node = blas_nodes[left_idx];
      let right_node = blas_nodes[right_idx];
      let t_left = intersect_aabb(p0_local, inv_d, left_node.aabb_min, left_node.aabb_max, best_t);
      let t_right = intersect_aabb(p0_local, inv_d, right_node.aabb_min, right_node.aabb_max, best_t);

      // Empujar primero el hijo más lejano para extraer primero el más cercano.
      if (t_left < t_right) {
        if (t_right < 1e29) { stack[sp] = right_idx; sp = sp + 1u; }
        if (t_left < 1e29)  { stack[sp] = left_idx;  sp = sp + 1u; }
      } else {
        if (t_left < 1e29)  { stack[sp] = left_idx;  sp = sp + 1u; }
        if (t_right < 1e29) { stack[sp] = right_idx; sp = sp + 1u; }
      }
    }
  }
  return vec4f(best_t, best_u, best_v, bitcast<f32>(best_tri));
}

// -----------------------------------------------------------------------------
//  4. Recorrido completo del segmento [p0_world, p1_world] (BVH vs Fuerza Bruta)
// -----------------------------------------------------------------------------
fn intersect_scene_segment(p0_world: vec3f, p1_world: vec3f) -> HitInfo {
  var result: HitInfo;
  result.hit = false;
  result.t = 1.0;
  result.bvh_nodes_visited = 0u;

  if (frame.instance_count == 0u) {
    return result;
  }

  let d_world = p1_world - p0_world;
  var best_t = 1.0;
  var best_u = 0.0;
  var best_v = 0.0;
  var best_tri: u32 = 0xffffffffu;
  var best_inst: u32 = 0xffffffffu;
  var best_p0_local = vec3f(0.0);
  var best_d_local = vec3f(0.0);
  var visited: u32 = 0u;

  // ---- Camino A: Fuerza bruta (bandera B desactivada) -----------------------
  if ((frame.flags & FLAG_BVH) == 0u) {
    for (var inst_idx = 0u; inst_idx < frame.instance_count; inst_idx = inst_idx + 1u) {
      let inst = instances[inst_idx];
      let mesh = mesh_infos[inst.mesh_id];
      let p0_local = (inst.local_from_world * vec4f(p0_world, 1.0)).xyz;
      let d_local = (inst.local_from_world * vec4f(d_world, 0.0)).xyz;
      for (var t_idx = 0u; t_idx < mesh.triangle_count; t_idx = t_idx + 1u) {
        visited = visited + 1u;
        let tri = mesh.triangle_offset + t_idx;
        let v0 = vertices[mesh.vertex_offset + indices[tri * 3u + 0u]].position.xyz;
        let v1 = vertices[mesh.vertex_offset + indices[tri * 3u + 1u]].position.xyz;
        let v2 = vertices[mesh.vertex_offset + indices[tri * 3u + 2u]].position.xyz;
        let tuv = intersect_triangle(p0_local, d_local, v0, v1, v2, best_t);
        if (tuv.x < best_t) {
          best_t = tuv.x;
          best_u = tuv.y;
          best_v = tuv.z;
          best_tri = tri;
          best_inst = inst_idx;
          best_p0_local = p0_local;
          best_d_local = d_local;
        }
      }
    }
  } else {
    // ---- Camino B: Recorrido de dos niveles TLAS + BLAS ---------------------
    let inv_d_world = safe_inv_dir(d_world);
    var tlas_stack: array<u32, 32>;
    var sp: u32 = 0u;
    tlas_stack[sp] = 0u;
    sp = sp + 1u;

    while (sp > 0u) {
      sp = sp - 1u;
      let node_idx = tlas_stack[sp];
      visited = visited + 1u;
      let node = tlas_nodes[node_idx];

      if (intersect_aabb(p0_world, inv_d_world, node.aabb_min, node.aabb_max, best_t) >= 1e29) {
        continue;
      }

      if (node.count > 0u) {
        for (var k = 0u; k < node.count; k = k + 1u) {
          let inst_idx = node.right_or_first + k;
          let inst = instances[inst_idx];
          let mesh = mesh_infos[inst.mesh_id];
          let p0_local = (inst.local_from_world * vec4f(p0_world, 1.0)).xyz;
          let d_local = (inst.local_from_world * vec4f(d_world, 0.0)).xyz;

          // Contamos los nodos del BLAS visitados para el mapa de calor.
          let inv_d_local = safe_inv_dir(d_local);
          var blas_stack: array<u32, 32>;
          var bsp: u32 = 0u;
          blas_stack[bsp] = mesh.blas_offset;
          bsp = bsp + 1u;

          while (bsp > 0u) {
            bsp = bsp - 1u;
            let b_idx = blas_stack[bsp];
            visited = visited + 1u;
            let b_node = blas_nodes[b_idx];

            if (intersect_aabb(p0_local, inv_d_local, b_node.aabb_min, b_node.aabb_max, best_t) >= 1e29) {
              continue;
            }

            if (b_node.count > 0u) {
              for (var i = 0u; i < b_node.count; i = i + 1u) {
                let tri = b_node.right_or_first + i;
                let v0 = vertices[mesh.vertex_offset + indices[tri * 3u + 0u]].position.xyz;
                let v1 = vertices[mesh.vertex_offset + indices[tri * 3u + 1u]].position.xyz;
                let v2 = vertices[mesh.vertex_offset + indices[tri * 3u + 2u]].position.xyz;
                let tuv = intersect_triangle(p0_local, d_local, v0, v1, v2, best_t);
                if (tuv.x < best_t) {
                  best_t = tuv.x;
                  best_u = tuv.y;
                  best_v = tuv.z;
                  best_tri = tri;
                  best_inst = inst_idx;
                  best_p0_local = p0_local;
                  best_d_local = d_local;
                }
              }
            } else if (bsp + 2u <= BVH_STACK_SIZE) {
              let l_idx = b_idx + 1u;
              let r_idx = b_node.right_or_first;
              let l_node = blas_nodes[l_idx];
              let r_node = blas_nodes[r_idx];
              let t_l = intersect_aabb(p0_local, inv_d_local, l_node.aabb_min, l_node.aabb_max, best_t);
              let t_r = intersect_aabb(p0_local, inv_d_local, r_node.aabb_min, r_node.aabb_max, best_t);
              if (t_l < t_r) {
                if (t_r < 1e29) { blas_stack[bsp] = r_idx; bsp = bsp + 1u; }
                if (t_l < 1e29) { blas_stack[bsp] = l_idx; bsp = bsp + 1u; }
              } else {
                if (t_l < 1e29) { blas_stack[bsp] = l_idx; bsp = bsp + 1u; }
                if (t_r < 1e29) { blas_stack[bsp] = r_idx; bsp = bsp + 1u; }
              }
            }
          }
        }
      } else if (sp + 2u <= BVH_STACK_SIZE) {
        tlas_stack[sp] = node.right_or_first;
        sp = sp + 1u;
        tlas_stack[sp] = node_idx + 1u;
        sp = sp + 1u;
      }
    }
  }

  if (best_tri != 0xffffffffu) {
    let inst = instances[best_inst];
    let mesh = mesh_infos[inst.mesh_id];
    return finalize_hit(inst, mesh, best_tri, best_t, best_u, best_v, best_p0_local, best_d_local, visited);
  }

  result.bvh_nodes_visited = visited;
  return result;
}

