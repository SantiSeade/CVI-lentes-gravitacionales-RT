// =============================================================================
//  shader.wgsl  -  PROOF OF CONCEPT: lente gravitacional (métrica de Schwarzschild)
// =============================================================================
//  Este archivo contiene las 3 etapas del pipeline descrito en el proyecto:
//
//    1) INTEGRADOR GEODÉSICO (compute)  -> curva cada rayo paso a paso con RK4
//    2) MOTOR DE INTERSECCIÓN (compute) -> prueba cada micro-segmento contra la esfera
//    3) SOMBREADOR (compute)            -> calcula el color final del píxel
//
//  Más un pequeño vertex/fragment shader que solo "pega" el resultado en pantalla.
//
//  UNIDADES: usamos el radio de Schwarzschild  rs = 2GM/c² = 1.
//            El agujero negro está en el origen (0,0,0) y su horizonte es r = 1.
//            La velocidad de la luz es c = 1.
// =============================================================================

// ----------------------------- Constantes ------------------------------------
const RS: f32          = 1.0;    // radio del horizonte de eventos
const MAX_STEPS: i32   = 500;    // máximo de pasos de integración por rayo
const ESCAPE_R: f32    = 30.0;   // si el rayo se aleja más que esto, "escapó al infinito"
const SPHERE_RADIUS: f32 = 1.2;  // radio de nuestra esfera de prueba
const ORBIT_RADIUS: f32  = 7.0;  // la esfera orbita el agujero negro a esta distancia

// ----------------------------- Datos compartidos -----------------------------
// Parámetros que llegan desde JavaScript cada fotograma (uniform buffer).
struct Params {
  res: vec2f,     // resolución de la imagen en píxeles (ancho, alto)
  time: f32,      // tiempo en segundos (para animar la órbita)
  gravity: f32,   // 1.0 = gravedad activada, 0.0 = luz recta (para comparar)
}

@group(0) @binding(0) var<uniform> params: Params;
// Buffer donde el compute shader escribe un color (rgba) por píxel.
@group(0) @binding(1) var<storage, read_write> image: array<vec4f>;
// El mismo buffer, visto como solo-lectura desde el fragment shader.
// (WGSL no permite read_write en el fragment stage, por eso hay dos vistas.)
@group(0) @binding(2) var<storage, read> imageRO: array<vec4f>;

// =============================================================================
//  1) FÍSICA: aceleración de un fotón en la métrica de Schwarzschild
// =============================================================================
//  En espacio plano la luz sigue  P = O + t·D  (aceleración = 0).
//  Cerca de un agujero negro, la ecuación de la órbita de un fotón (Binet) es:
//
//        u'' + u = (3/2)·rs·u²        con u = 1/r
//
//  Se puede reescribir en coordenadas cartesianas como una "fuerza" que tira
//  del fotón hacia el centro:
//
//        a = -(3/2) · rs · h² · P / |P|⁵
//
//  donde h = |P × V| es el momento angular del fotón (constante a lo largo
//  del rayo, por eso lo calculamos una sola vez antes del bucle).
//
//  Esto reproduce correctamente: la esfera de fotones (r = 1.5·rs), el anillo
//  de Einstein y la deflexión de 1.5·rs/b ·2 para rayos lejanos.
fn acceleration(p: vec3f, h2: f32) -> vec3f {
  let r2 = dot(p, p);
  let r5 = r2 * r2 * sqrt(r2);
  return -1.5 * RS * h2 * p / r5 * params.gravity;
}

// Estado del fotón: posición y velocidad (dirección).
struct State { p: vec3f, v: vec3f }

// -----------------------------------------------------------------------------
//  Integrador Runge-Kutta de 4.º orden (RK4)
// -----------------------------------------------------------------------------
//  El sistema es:   dP/dt = V      dV/dt = a(P)
//  RK4 evalúa la pendiente 4 veces (k1..k4) dentro del paso y las promedia
//  con pesos 1-2-2-1. Es mucho más preciso que Euler con el mismo paso.
fn rk4_step(s: State, dt: f32, h2: f32) -> State {
  let k1p = s.v;
  let k1v = acceleration(s.p, h2);

  let k2p = s.v + 0.5 * dt * k1v;
  let k2v = acceleration(s.p + 0.5 * dt * k1p, h2);

  let k3p = s.v + 0.5 * dt * k2v;
  let k3v = acceleration(s.p + 0.5 * dt * k2p, h2);

  let k4p = s.v + dt * k3v;
  let k4v = acceleration(s.p + dt * k3p, h2);

  var out: State;
  out.p = s.p + (dt / 6.0) * (k1p + 2.0 * k2p + 2.0 * k3p + k4p);
  out.v = s.v + (dt / 6.0) * (k1v + 2.0 * k2v + 2.0 * k3v + k4v);
  return out;
}

// =============================================================================
//  2) INTERSECCIÓN: segmento de recta  vs  esfera
// =============================================================================
//  Idea clave del proyecto: el rayo curvo se aproxima como una cadena de
//  micro-segmentos RECTOS. Cada segmento se prueba con la geometría usando
//  la intersección clásica rayo-esfera (ecuación cuadrática).
//
//  Devuelve t ∈ [0,1] (posición del impacto dentro del segmento) o -1 si no hay.
//
//  NOTA PARA EL PROYECTO FINAL: aquí es donde se reemplazaría la esfera por
//  un recorrido del BVH + intersección rayo-triángulo sobre las mallas 3D.
fn hit_segment_sphere(p0: vec3f, p1: vec3f, c: vec3f, r: f32) -> f32 {
  let d  = p1 - p0;            // vector del segmento (no normalizado)
  let oc = p0 - c;
  let a  = dot(d, d);
  let b  = dot(oc, d);
  let cc = dot(oc, oc) - r * r;
  let disc = b * b - a * cc;   // discriminante de la cuadrática
  if (disc < 0.0) { return -1.0; }
  let t = (-b - sqrt(disc)) / a;   // raíz más cercana
  if (t >= 0.0 && t <= 1.0) { return t; }
  return -1.0;
}

// =============================================================================
//  3) SOMBREADO
// =============================================================================

// Fondo procedural: rejilla de latitud/longitud + estrellas.
// Sirve para que se VEA la deformación del espacio (un fondo liso no mostraría nada).
fn hash31(p: vec3f) -> f32 {
  return fract(sin(dot(p, vec3f(12.9898, 78.233, 37.719))) * 43758.5453);
}

fn background(dir: vec3f) -> vec3f {
  let d = normalize(dir);
  let az = atan2(d.z, d.x);   // "longitud"
  let el = asin(d.y);         // "latitud"

    // Líneas de rejilla cada 15° (π/12 rad).
  let grid_step = 3.14159265 / 12.0;
  let ga = abs(fract(az / grid_step + 0.5) - 0.5) * grid_step;
  let ge = abs(fract(el / grid_step + 0.5) - 0.5) * grid_step;
  let line = 1.0 - smoothstep(0.0, 0.012, min(ga * cos(el), ge));
  var col = vec3f(0.02, 0.03, 0.07) + line * vec3f(0.10, 0.30, 0.55);

  // Estrellas: celdas 3D aleatorias; unas pocas se encienden.
  let cell = floor(d * 90.0);
  let star = step(0.985, hash31(cell));
  col += star * vec3f(1.0, 0.95, 0.85);
  return col;
}

// Color de la esfera: tablero de ajedrez sobre la normal + luz difusa simple.
fn shade_sphere(hit: vec3f, center: vec3f) -> vec3f {
  let n = normalize(hit - center);                       // normal de la superficie
  let l = normalize(vec3f(0.5, 0.8, -0.4));              // dirección de la luz
  let diffuse = max(dot(n, l), 0.0) * 0.8 + 0.2;         // Lambert + ambiente
  let q = floor(n * 3.0);
  let checker = abs((q.x + q.y + q.z) % 2.0);            // 0 o 1
  let base = mix(vec3f(1.0, 0.45, 0.1), vec3f(1.0, 0.9, 0.7), checker);
  return base * diffuse;
}

// =============================================================================
//  COMPUTE SHADER: un hilo = un píxel = un rayo
// =============================================================================
@compute @workgroup_size(8, 8)
fn trace(@builtin(global_invocation_id) gid: vec3u) {
  let w = u32(params.res.x);
  let h = u32(params.res.y);
  if (gid.x >= w || gid.y >= h) { return; }   // hilos sobrantes del último workgroup

  // ---- Cámara fija mirando al agujero negro -------------------------------
  let cam_pos = vec3f(0.0, 2.0, -14.0);
  let fwd   = normalize(-cam_pos);                         // mira al origen
  let right = normalize(cross(vec3f(0.0, 1.0, 0.0), fwd));
  let up    = cross(fwd, right);
  let aspect = params.res.x / params.res.y;
  let fov_tan = 0.5;                                       // tan(FOV vertical / 2)

  // Coordenadas de pantalla normalizadas en [-1, 1] (y hacia arriba).
  let ndc = vec2f(
    (2.0 * (f32(gid.x) + 0.5) / params.res.x - 1.0) * aspect,
    1.0 - 2.0 * (f32(gid.y) + 0.5) / params.res.y
  );
  let dir0 = normalize(fwd + (ndc.x * right + ndc.y * up) * fov_tan);

  // ---- Posición de la esfera en este fotograma (órbita circular) ----------
  let ang = params.time * 0.4;
  let sphere_c = vec3f(ORBIT_RADIUS * cos(ang), 0.0, ORBIT_RADIUS * sin(ang));

  // ---- Estado inicial del fotón -------------------------------------------
  var s: State;
  s.p = cam_pos;
  s.v = dir0;                       // |v| = 1  (velocidad de la luz)
  let L  = cross(s.p, s.v);
  let h2 = dot(L, L);               // h² constante a lo largo de todo el rayo

  var color = vec3f(0.0);           // por defecto negro (rayo capturado / sin terminar)

  // ---- Bucle principal: caminar a lo largo del rayo curvo -----------------
  for (var i = 0; i < MAX_STEPS; i++) {
    let r = length(s.p);

    // (a) Cayó dentro del horizonte de eventos -> píxel negro, fin.
    if (r < RS) { break; }

    // (b) Escapó al infinito (lejos y alejándose) -> mostrar el fondo.
    if (r > ESCAPE_R && dot(s.p, s.v) > 0.0) {
      color = background(s.v);
      break;
    }

    // (c) PASO ADAPTATIVO: pasos grandes lejos, minúsculos cerca del horizonte
    //     (donde la curvatura es fuerte y la esfera de fotones está en r=1.5).
    let dt = clamp(0.08 * (r - RS) + 0.01, 0.01, 0.5);

    // (d) Avanzar un paso con RK4.
    let next = rk4_step(s, dt, h2);

    // (e) Probar el micro-segmento [s.p, next.p] contra la esfera.
    let t = hit_segment_sphere(s.p, next.p, sphere_c, SPHERE_RADIUS);
    if (t >= 0.0) {
      let hit_point = mix(s.p, next.p, t);
      color = shade_sphere(hit_point, sphere_c);
      break;
    }

    s = next;
  }

  image[gid.y * w + gid.x] = vec4f(color, 1.0);
}

// =============================================================================
//  PRESENTACIÓN: triángulo de pantalla completa que muestra el buffer
// =============================================================================
@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  // Un solo triángulo gigante que cubre toda la pantalla (sin buffers de vértices).
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[i], 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let x = u32(frag.x);
  let y = u32(frag.y);
  return imageRO[y * u32(params.res.x) + x];
}
