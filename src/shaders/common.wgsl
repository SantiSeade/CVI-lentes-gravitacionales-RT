// =============================================================================
//  common.wgsl — Constantes, structs compartidos y funciones de orden Morton.
// =============================================================================
//  ¿Por qué existe?
//    WGSL no tiene `#include`. `src/shaders/index.ts` concatena este archivo al
//    principio del módulo de cómputo para que `geodesic.wgsl`, `intersect.wgsl`,
//    `shading.wgsl` y `trace.wgsl` compartan exactamente las mismas definiciones
//    de estructuras, bindings y constantes.
//
//    IMPORTANTE sobre alineamiento en WGSL:
//      En WGSL `vec3f` mide 12 bytes pero se alinea a 16 bytes. Por eso en todos
//      los structs colocamos un escalar (`f32` o `u32`) inmediatamente después
//      de cada `vec3f` (o usamos `vec4f`), de modo que no queden huecos
//      implícitos y el layout coincida byte a byte con `src/gpu/layouts.ts`.
// =============================================================================

const PI: f32 = 3.141592653589793;
const MAX_BLACK_HOLES: u32 = 4u;
const MAX_MATERIALS: u32 = 64u;
const BVH_STACK_SIZE: u32 = 32u;
const WORKGROUP_SIZE: u32 = 64u;

// Bits del campo `flags` de FrameUniforms / PresentUniforms.
const FLAG_GRAVITY: u32 = 1u;
const FLAG_BVH: u32 = 2u;
const FLAG_MORTON: u32 = 4u;

// Modos de visualización (`view_mode`).
const VIEW_NORMAL: u32 = 0u;
const VIEW_HEAT_STEPS: u32 = 1u;
const VIEW_HEAT_BVH: u32 = 2u;

// -----------------------------------------------------------------------------
//  FrameUniforms (224 bytes): parámetros por fotograma subidos desde CPU.
// -----------------------------------------------------------------------------
struct FrameUniforms {
  cam_pos: vec3f,
  tan_half_fov: f32,
  cam_right: vec3f,
  aspect: f32,
  cam_up: vec3f,
  escape_r: f32,
  cam_fwd: vec3f,
  time: f32,
  light_pos: vec3f,
  ambient: f32,
  light_color: vec3f,
  heat_max: f32,
  width: u32,
  height: u32,
  max_steps: u32,
  flags: u32,
  step_k: f32,
  dt_min: f32,
  dt_max_rel: f32,
  dt_max_abs: f32,
  bh_count: u32,
  view_mode: u32,
  instance_count: u32,
  thread_offset: u32,
  thread_count: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  // Cada elemento: xyz = posición de mundo del agujero negro, w = radio rs.
  black_holes: array<vec4f, 4>,
}

// -----------------------------------------------------------------------------
//  Material (48 bytes): colores, patrón procedural y emisión.
// -----------------------------------------------------------------------------
struct Material {
  base_color: vec4f,      // rgb = color primario,  w = tipo de patrón (0, 1, 2)
  secondary_color: vec4f, // rgb = color secundario, w = frecuencia del patrón
  emission: vec4f,        // rgb = color emisivo,   w = intensidad (>0 si es estrella)
}

// -----------------------------------------------------------------------------
//  Vertex (32 bytes): posición y normal en el espacio local de la malla.
// -----------------------------------------------------------------------------
struct Vertex {
  position: vec4f,
  normal: vec4f,
}

// -----------------------------------------------------------------------------
//  BvhNode (32 bytes): nodo linealizado en orden pre-orden (depth-first).
//  - Si `count == 0u`: es nodo interno; hijo izquierdo = `nodo + 1u`,
//    hijo derecho = `right_or_first`.
//  - Si `count > 0u`: es hoja con `count` primitivas consecutivas a partir de
//    `right_or_first`.
// -----------------------------------------------------------------------------
struct BvhNode {
  aabb_min: vec3f,
  right_or_first: u32,
  aabb_max: vec3f,
  count: u32,
}

// -----------------------------------------------------------------------------
//  Instance (144 bytes): transformación local↔mundo e identificadores.
// -----------------------------------------------------------------------------
struct Instance {
  world_from_local: mat4x4f,
  local_from_world: mat4x4f,
  mesh_id: u32,
  material_id: u32,
  _pad0: u32,
  _pad1: u32,
}

// -----------------------------------------------------------------------------
//  MeshInfo (16 bytes): rangos de una malla dentro de los buffers globales.
// -----------------------------------------------------------------------------
struct MeshInfo {
  vertex_offset: u32,
  triangle_offset: u32,
  blas_offset: u32,
  triangle_count: u32,
}

// -----------------------------------------------------------------------------
//  Bindings del compute shader (2 uniform buffers + 7 storage buffers ≤ 8).
// -----------------------------------------------------------------------------
@group(0) @binding(0) var<uniform> frame: FrameUniforms;
@group(0) @binding(1) var<uniform> materials: array<Material, 64>;
@group(0) @binding(2) var<storage, read_write> image: array<vec4f>;
@group(0) @binding(3) var<storage, read> vertices: array<Vertex>;
@group(0) @binding(4) var<storage, read> indices: array<u32>;
@group(0) @binding(5) var<storage, read> blas_nodes: array<BvhNode>;
@group(0) @binding(6) var<storage, read> mesh_infos: array<MeshInfo>;
@group(0) @binding(7) var<storage, read> tlas_nodes: array<BvhNode>;
@group(0) @binding(8) var<storage, read> instances: array<Instance>;

// -----------------------------------------------------------------------------
//  Código de Morton 2D en GPU (idéntico a src/accel/morton.ts).
//  Se usa cuando la bandera FLAG_MORTON está activa para mapear el índice del
//  hilo a coordenadas (x, y) siguiendo una curva Z dentro de cada bloque 8×8 y
//  también para direccionar el buffer `image`.
// -----------------------------------------------------------------------------
fn expand_bits_2d(v_in: u32) -> u32 {
  var x = v_in & 0x0000ffffu;
  x = (x | (x << 8u)) & 0x00ff00ffu;
  x = (x | (x << 4u)) & 0x0f0f0f0fu;
  x = (x | (x << 2u)) & 0x33333333u;
  x = (x | (x << 1u)) & 0x55555555u;
  return x;
}

fn compact_bits_2d(v_in: u32) -> u32 {
  var x = v_in & 0x55555555u;
  x = (x | (x >> 1u)) & 0x33333333u;
  x = (x | (x >> 2u)) & 0x0f0f0f0fu;
  x = (x | (x >> 4u)) & 0x00ff00ffu;
  x = (x | (x >> 8u)) & 0x0000ffffu;
  return x;
}

fn morton_2d(x: u32, y: u32) -> u32 {
  return expand_bits_2d(x) | (expand_bits_2d(y) << 1u);
}

fn decode_morton_2d(code: u32) -> vec2u {
  return vec2u(compact_bits_2d(code), compact_bits_2d(code >> 1u));
}

// Índice en el buffer `image` para el píxel (x, y) según esté activo o no el
// orden Z por bloques de 8×8 píxeles.
fn pixel_buffer_index(x: u32, y: u32, w: u32, h: u32, use_morton: bool) -> u32 {
  if (!use_morton) {
    return y * w + x;
  }
  let tiles_x = (w + 7u) / 8u;
  let tile_x = x >> 3u;
  let tile_y = y >> 3u;
  let in_tile = morton_2d(x & 7u, y & 7u);
  let tile_id = tile_y * tiles_x + tile_x;
  let candidate = tile_id * 64u + in_tile;
  // Si la resolución no es múltiplo exacto de 8, los píxeles del borde usan el
  // índice lineal de respaldo para no salirse de `w * h`.
  if (candidate < w * h && (tile_x * 8u + 7u) < w && (tile_y * 8u + 7u) < h) {
    return candidate;
  }
  return y * w + x;
}

