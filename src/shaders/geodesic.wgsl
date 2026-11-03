// =============================================================================
//  geodesic.wgsl — Física de Schwarzschild, integrador RK4 y paso adaptativo.
// =============================================================================
//  ¿Qué calcula este archivo?
//    Avanza un fotón paso a paso a través del espacio-tiempo curvado por uno o
//    varios agujeros negros.
//
//  1. Aceleración geodésica (ecuación de Binet en cartesianas):
//     En la métrica de Schwarzschild de un agujero negro con radio de
//     Schwarzschild `rs = 2GM/c²`, la órbita de un fotón cumple:
//
//         d²u/dφ² + u = (3/2) · rs · u²        con u = 1/r
//
//     Escrita como ecuación de segundo orden respecto al parámetro afín `t` en
//     coordenadas cartesianas centradas en el agujero negro `C_i`:
//
//         a_i(P, V) = -(3/2) · rs_i · h_i² · (P - C_i) / |P - C_i|⁵
//
//     donde `h_i² = |(P - C_i) × V|²` es el cuadrado del momento angular
//     específico del fotón respecto a ese agujero negro.
//
//     - Para UN solo agujero negro, `h²` se conserva exactamente a lo largo de
//       todo el rayo y esta expresión es matemáticamente idéntica a la del PoC.
//     - Para VARIOS agujeros negros, sumamos la contribución `a_i` de cada uno
//       evaluando `h_i²` con el estado actual `(P, V)`. Esto es una
//       APROXIMACIÓN de superposición (las métricas de Einstein no son
//       lineales), documentada en `docs/FISICA_E_INTEGRADORES.md`.
//
//  2. Integrador intercambiable (`integrate_step`):
//     El bucle principal en `trace.wgsl` solo llama a `integrate_step(s, dt)`.
//     Aquí se implementa con Runge-Kutta de 4.º orden (RK4, 4 evaluaciones por
//     paso). Cambiar de integrador (por ejemplo a RK45 Dormand-Prince) solo
//     requiere cambiar el cuerpo de `integrate_step`.
// =============================================================================

// Estado instantáneo del fotón: posición `p` y dirección/velocidad `v` (|v| ≈ 1).
struct PhotonState {
  p: vec3f,
  v: vec3f,
}

// Resultado de consultar la distancia a los agujeros negros de la escena.
struct BlackHoleProximity {
  // Distancia `d - rs` al horizonte más cercano (< 0 si ya cayó dentro).
  min_dist_to_horizon: f32,
  // Distancia radial `d` al centro de ese agujero negro.
  nearest_r: f32,
  // Radio de Schwarzschild `rs` de ese agujero negro.
  nearest_rs: f32,
  // true si el fotón entró dentro del horizonte (`d <= rs`) de algún agujero negro.
  captured: bool,
}

// Evalúa la proximidad del punto `p` a todos los agujeros negros activos.
fn query_black_holes(p: vec3f) -> BlackHoleProximity {
  var info: BlackHoleProximity;
  info.min_dist_to_horizon = 1e30;
  info.nearest_r = 1e30;
  info.nearest_rs = 1.0;
  info.captured = false;

  let count = min(frame.bh_count, MAX_BLACK_HOLES);
  for (var i = 0u; i < count; i = i + 1u) {
    let bh = frame.black_holes[i];
    let d = length(p - bh.xyz);
    let dist_h = d - bh.w;
    if (d <= bh.w) {
      info.captured = true;
    }
    if (dist_h < info.min_dist_to_horizon) {
      info.min_dist_to_horizon = dist_h;
      info.nearest_r = d;
      info.nearest_rs = bh.w;
    }
  }
  return info;
}

// Suma la aceleración gravitacional que ejercen todos los agujeros negros sobre
// un fotón en la posición `p` con velocidad `v`.
fn photon_acceleration(p: vec3f, v: vec3f) -> vec3f {
  if ((frame.flags & FLAG_GRAVITY) == 0u) {
    return vec3f(0.0);
  }
  var total = vec3f(0.0);
  let count = min(frame.bh_count, MAX_BLACK_HOLES);
  for (var i = 0u; i < count; i = i + 1u) {
    let bh = frame.black_holes[i];
    let rel = p - bh.xyz;
    let r2 = max(dot(rel, rel), 1e-6);
    let r5 = r2 * r2 * sqrt(r2);
    let ang_mom = cross(rel, v);
    let h2 = dot(ang_mom, ang_mom);
    total = total - (1.5 * bh.w * h2 / r5) * rel;
  }
  return total;
}

// Paso adaptativo heurístico (sección 5):
//   - Cerca del horizonte (`d ≈ rs`) el paso se reduce hasta `dt_min` para
//     resolver con precisión la esfera de fotones (`r = 1.5·rs`).
//   - Lejos del agujero negro el paso crece proporcionalmente a `d - rs`, con
//     un tope que escala con `d` (`dt_max_rel * d`) y un tope absoluto
//     (`dt_max_abs`) para cubrir escenas de 500-1000 unidades en pocos pasos.
fn adaptive_step_size(prox: BlackHoleProximity) -> f32 {
  let raw_dt = frame.step_k * max(prox.min_dist_to_horizon, 0.0) + frame.dt_min;
  let scaled_max = clamp(frame.dt_max_rel * prox.nearest_r, frame.dt_min, frame.dt_max_abs);
  return clamp(raw_dt, frame.dt_min, scaled_max);
}

// -----------------------------------------------------------------------------
//  Interfaz única del integrador geodésico: `integrate_step(state, dt)`
// -----------------------------------------------------------------------------
//  Implementación actual: Runge-Kutta clásico de 4.º orden (RK4).
//  Evalúa la pendiente 4 veces (inicio, dos puntos medios y final) y las
//  combina con pesos (1, 2, 2, 1)/6. Al final renormaliza `v` a longitud 1
//  para evitar deriva numérica acumulada tras cientos de pasos.
//
//  TODO(ext): versión alternativa RK45 Dormand-Prince con control de error
//  local y propiedad FSAL (First Same As Last), reutilizando los coeficientes
//  del PoC `poc-lente-gravitacional-rk45` para comparar coste vs precisión en
//  el informe final (ver docs/FISICA_E_INTEGRADORES.md y docs/ROADMAP.md).
fn integrate_step(s: PhotonState, dt: f32) -> PhotonState {
  // Con la gravedad apagada, el fotón viaja en línea recta exacta.
  if ((frame.flags & FLAG_GRAVITY) == 0u) {
    return PhotonState(s.p + s.v * dt, s.v);
  }

  let k1p = s.v;
  let k1v = photon_acceleration(s.p, s.v);

  let p2 = s.p + 0.5 * dt * k1p;
  let v2 = s.v + 0.5 * dt * k1v;
  let k2p = v2;
  let k2v = photon_acceleration(p2, v2);

  let p3 = s.p + 0.5 * dt * k2p;
  let v3 = s.v + 0.5 * dt * k2v;
  let k3p = v3;
  let k3v = photon_acceleration(p3, v3);

  let p4 = s.p + dt * k3p;
  let v4 = s.v + dt * k3v;
  let k4p = v4;
  let k4v = photon_acceleration(p4, v4);

  var next: PhotonState;
  next.p = s.p + (dt / 6.0) * (k1p + 2.0 * k2p + 2.0 * k3p + k4p);
  next.v = normalize(s.v + (dt / 6.0) * (k1v + 2.0 * k2v + 2.0 * k3v + k4v));
  return next;
}

