// =============================================================================
//  trace.wgsl — Compute shader principal: un hilo = un píxel = un rayo curvo.
// =============================================================================
//  Flujo por hilo:
//    1. Determinar qué píxel `(px, py)` le toca a este hilo (lineal o en orden
//       Z de Morton por bloques de 8×8 si `FLAG_MORTON` está activo).
//    2. Construir el rayo primario desde la cámara orbital (`cam_pos`, `dir0`).
//    3. En cada iteración (hasta `frame.max_steps`):
//         a) Consultar la distancia a los agujeros negros (`query_black_holes`).
//         b) Si cayó dentro de algún horizonte (`r <= rs`), el píxel queda negro.
//         c) Si superó el radio de escape (`r > escape_r`) alejándose, muestrear
//            el fondo procedural con la dirección actual `s.v`.
//         d) Calcular el paso adaptativo `dt` y avanzar el estado con
//            `integrate_step(s, dt)` (RK4).
//         e) Probar el micro-segmento `[s.p, next.p]` contra la escena 3D
//            (`intersect_scene_segment`, usando TLAS+BLAS o fuerza bruta).
//    4. Escribir el color final (o el mapa de calor de pasos / nodos BVH) en el
//       buffer `image` en el índice lineal o Morton según `FLAG_MORTON`.
// =============================================================================

@compute @workgroup_size(64, 1, 1)
fn trace(@builtin(global_invocation_id) gid: vec3u) {
  let w = frame.width;
  let h = frame.height;
  let thread_id = gid.x + frame.thread_offset;
  if (thread_id >= frame.thread_count) {
    return;
  }

  let use_morton = (frame.flags & FLAG_MORTON) != 0u;
  var px: u32 = 0u;
  var py: u32 = 0u;
  if (use_morton) {
    // Cada workgroup de 64 hilos cubre un bloque 8×8 siguiendo la curva Z 2D.
    let tiles_x = (w + 7u) / 8u;
    let tile_id = thread_id >> 6u;
    let in_tile = thread_id & 63u;
    let local_xy = decode_morton_2d(in_tile);
    px = (tile_id % tiles_x) * 8u + local_xy.x;
    py = (tile_id / tiles_x) * 8u + local_xy.y;
  } else {
    px = thread_id % w;
    py = thread_id / w;
  }

  if (px >= w || py >= h) {
    return;
  }

  // ---- 1. Rayo inicial desde la cámara orbital ------------------------------
  let ndc = vec2f(
    (2.0 * (f32(px) + 0.5) / f32(w) - 1.0) * frame.aspect,
    1.0 - 2.0 * (f32(py) + 0.5) / f32(h),
  );
  let dir0 = normalize(
    frame.cam_fwd + (ndc.x * frame.cam_right + ndc.y * frame.cam_up) * frame.tan_half_fov,
  );

  var s = PhotonState(frame.cam_pos, dir0);
  var color = vec3f(0.0);
  var steps_taken: u32 = 0u;
  var total_bvh_visited: u32 = 0u;

  // ---- 2. Bucle de integración geodésica + intersección de micro-segmentos --
  for (var step_idx = 0u; step_idx < frame.max_steps; step_idx = step_idx + 1u) {
    steps_taken = step_idx + 1u;

    let prox = query_black_holes(s.p);
    if (prox.captured) {
      // Capturado por el horizonte de eventos: sombra negra del agujero negro.
      color = vec3f(0.0);
      break;
    }

    let r_origin = length(s.p);
    if (r_origin > frame.escape_r && dot(s.p, s.v) > 0.0) {
      color = shade_background(s.v);
      break;
    }

    let dt = adaptive_step_size(prox);
    let next_s = integrate_step(s, dt);

    // Probar el micro-segmento recto [s.p, next_s.p] contra las mallas 3D.
    let hit = intersect_scene_segment(s.p, next_s.p);
    total_bvh_visited = total_bvh_visited + hit.bvh_nodes_visited;
    if (hit.hit) {
      color = shade_surface(hit, s.v);
      break;
    }

    s = next_s;

    // Si agotamos los pasos sin ser capturados por el horizonte, mostramos el fondo
    // en la última dirección del rayo.
    if (step_idx + 1u == frame.max_steps) {
      color = shade_background(s.v);
    }
  }

  // ---- 3. Modos de depuración: mapas de calor (`H`) -------------------------
  if (frame.view_mode == VIEW_HEAT_STEPS) {
    color = heatmap_color(f32(steps_taken), f32(frame.max_steps));
  } else if (frame.view_mode == VIEW_HEAT_BVH) {
    color = heatmap_color(f32(total_bvh_visited), frame.heat_max);
  }

  let out_idx = pixel_buffer_index(px, py, w, h, use_morton);
  image[out_idx] = vec4f(color, 1.0);
}

