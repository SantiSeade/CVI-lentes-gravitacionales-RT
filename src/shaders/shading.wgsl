// =============================================================================
//  shading.wgsl — Iluminación Lambert, fondo celeste procedural y mapas de calor.
// =============================================================================
//  ¿Qué calcula este archivo?
//    1. `background(dir)`: la esfera celeste con rejilla de latitud/longitud
//       cada 15° y estrellas puntuales (adaptada del PoC). La rejilla hace
//       evidente la curvatura del espacio y el anillo de Einstein alrededor del
//       agujero negro.
//    2. `shade_surface(hit, ray_dir)`: evalúa el material de la instancia
//       impactada (patrón procedural en coordenadas locales para que gire con
//       el planeta + difusión Lambert hacia la estrella + luz ambiente, o color
//       emisivo directo si es la propia estrella).
//    3. `heatmap_color(value, max_value)`: rampa térmica (azul → cian → verde →
//       amarillo → rojo → blanco) para visualizar el coste por píxel (pasos del
//       integrador RK4 o nodos BVH visitados).
//
//  TODO(ext):
//    - Sombras curvas (disparar un rayo geodésico secundario hacia la estrella).
//    - Disco de acreción volumétrico/planar en el plano ecuatorial del agujero
//      negro con corrimiento al rojo Doppler + gravitacional.
// =============================================================================

fn hash31(p: vec3f) -> f32 {
  return fract(sin(dot(p, vec3f(12.9898, 78.233, 37.719))) * 43758.5453);
}

// Ruido 3D suave barato para dar textura de continentes/nubes a los planetas.
fn value_noise(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let n000 = hash31(i + vec3f(0.0, 0.0, 0.0));
  let n100 = hash31(i + vec3f(1.0, 0.0, 0.0));
  let n010 = hash31(i + vec3f(0.0, 1.0, 0.0));
  let n110 = hash31(i + vec3f(1.0, 1.0, 0.0));
  let n001 = hash31(i + vec3f(0.0, 0.0, 1.0));
  let n101 = hash31(i + vec3f(1.0, 0.0, 1.0));
  let n011 = hash31(i + vec3f(0.0, 1.0, 1.0));
  let n111 = hash31(i + vec3f(1.0, 1.0, 1.0));
  let nx00 = mix(n000, n100, u.x);
  let nx10 = mix(n010, n110, u.x);
  let nx01 = mix(n001, n101, u.x);
  let nx11 = mix(n011, n111, u.x);
  let nxy0 = mix(nx00, nx10, u.y);
  let nxy1 = mix(nx01, nx11, u.y);
  return mix(nxy0, nxy1, u.z);
}

// Fondo procedural: rejilla de latitud/longitud tenue + campo de estrellas.
fn shade_background(dir: vec3f) -> vec3f {
  let d = normalize(dir);
  let az = atan2(d.z, d.x);
  let el = asin(clamp(d.y, -1.0, 1.0));

  let grid_step = PI / 12.0; // cada 15°
  let ga = abs(fract(az / grid_step + 0.5) - 0.5) * grid_step;
  let ge = abs(fract(el / grid_step + 0.5) - 0.5) * grid_step;
  let line = 1.0 - smoothstep(0.0, 0.011, min(ga * cos(el), ge));

  var col = vec3f(0.015, 0.025, 0.06) + line * vec3f(0.09, 0.26, 0.48);

  // Banda galáctica suave + estrellas puntuales.
  let galaxy = exp(-6.0 * d.y * d.y) * 0.06;
  col = col + galaxy * vec3f(0.35, 0.45, 0.8);

  let cell = floor(d * 115.0);
  let h = hash31(cell);
  if (h > 0.986) {
    let brightness = (h - 0.986) / 0.014;
    col = col + brightness * vec3f(1.0, 0.96, 0.88);
  }
  return col;
}

// Sombreado Lambert + patrón procedural en espacio local.
fn shade_surface(hit: HitInfo, ray_dir: vec3f) -> vec3f {
  let mat = materials[min(hit.material_id, MAX_MATERIALS - 1u)];
  let base_a = mat.base_color.xyz;
  let base_b = mat.secondary_color.xyz;
  let pattern = u32(mat.base_color.w + 0.5);
  let scale = mat.secondary_color.w;

  let n_local = normalize(hit.local_pos);
  var albedo = base_a;
  if (pattern == 1u) {
    // Bandas latitudinales (gigantes gaseosos) con una ligera ondulación.
    let wave = 0.5 + 0.5 * sin(n_local.y * scale * PI + 1.6 * value_noise(n_local * 4.0));
    albedo = mix(base_a, base_b, wave);
  } else if (pattern == 2u) {
    // Ruido fractal de 2 octavas (continentes / manchas volcánicas / granulación solar).
    let n = 0.65 * value_noise(n_local * scale) + 0.35 * value_noise(n_local * scale * 2.3);
    albedo = mix(base_b, base_a, smoothstep(0.38, 0.62, n));
  }

  // Si el material es emisivo (estrella), brilla por sí mismo con oscurecimiento al limbo.
  if (mat.emission.w > 0.0) {
    let view_cos = max(dot(hit.world_normal, -ray_dir), 0.15);
    return albedo * mat.emission.xyz * (0.65 + 0.55 * view_cos) * mat.emission.w;
  }

  // Iluminación difusa de Lambert hacia la estrella emisiva (dirección recta) + ambiente.
  // TODO(ext): reemplazar por visibilidad curva a lo largo de una geodésica hacia la luz.
  let to_light = normalize(frame.light_pos - hit.world_pos);
  let ndotl = max(dot(hit.world_normal, to_light), 0.0);
  let rim = pow(1.0 - max(dot(hit.world_normal, -ray_dir), 0.0), 3.0) * 0.12;
  let lighting = frame.ambient + (1.0 - frame.ambient) * ndotl * frame.light_color + rim;
  return albedo * lighting;
}

// Rampa de falso color para los dos modos de mapa de calor (`H`).
fn heatmap_color(val: f32, max_val: f32) -> vec3f {
  let t = clamp(val / max(max_val, 1.0), 0.0, 1.0);
  let c0 = vec3f(0.05, 0.08, 0.35);
  let c1 = vec3f(0.0, 0.65, 0.85);
  let c2 = vec3f(0.15, 0.85, 0.25);
  let c3 = vec3f(0.98, 0.82, 0.1);
  let c4 = vec3f(0.95, 0.15, 0.1);
  if (t < 0.25) { return mix(c0, c1, t * 4.0); }
  if (t < 0.50) { return mix(c1, c2, (t - 0.25) * 4.0); }
  if (t < 0.75) { return mix(c2, c3, (t - 0.50) * 4.0); }
  return mix(c3, c4, (t - 0.75) * 4.0);
}

