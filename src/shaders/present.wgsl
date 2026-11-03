// =============================================================================
//  present.wgsl — Vertex + Fragment shader que muestran el buffer de imagen.
// =============================================================================
//  ¿Por qué una pasada separada de presentación?
//    El compute shader escribe colores RGBA en un storage buffer (`image`). En
//    el fragment stage de WebGPU los storage buffers son de SOLO LECTURA, así
//    que aquí vinculamos ese mismo buffer como `var<storage, read> image_ro` y
//    dibujamos un único triángulo a pantalla completa.
//
//    Si la bandera `FLAG_MORTON` está activa, el compute shader escribió los
//    píxeles en orden Z de bloques 8×8; el fragment shader convierte `(x, y)`
//    al mismo índice Morton para reconstruir la imagen exacta en pantalla.
// =============================================================================

const PRESENT_FLAG_MORTON: u32 = 4u;

struct PresentUniforms {
  image_size: vec2u,
  canvas_size: vec2u,
  flags: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
}

@group(0) @binding(0) var<uniform> present: PresentUniforms;
@group(0) @binding(1) var<storage, read> image_ro: array<vec4f>;

fn expand_bits_2d_fs(v_in: u32) -> u32 {
  var x = v_in & 0x0000ffffu;
  x = (x | (x << 8u)) & 0x00ff00ffu;
  x = (x | (x << 4u)) & 0x0f0f0f0fu;
  x = (x | (x << 2u)) & 0x33333333u;
  x = (x | (x << 1u)) & 0x55555555u;
  return x;
}

fn morton_2d_fs(x: u32, y: u32) -> u32 {
  return expand_bits_2d_fs(x) | (expand_bits_2d_fs(y) << 1u);
}

fn present_pixel_index(x: u32, y: u32, w: u32, h: u32, use_morton: bool) -> u32 {
  if (!use_morton) {
    return y * w + x;
  }
  let tiles_x = (w + 7u) / 8u;
  let tile_x = x >> 3u;
  let tile_y = y >> 3u;
  let in_tile = morton_2d_fs(x & 7u, y & 7u);
  let tile_id = tile_y * tiles_x + tile_x;
  let candidate = tile_id * 64u + in_tile;
  if (candidate < w * h && (tile_x * 8u + 7u) < w && (tile_y * 8u + 7u) < h) {
    return candidate;
  }
  return y * w + x;
}

@vertex
fn vs(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0),
  );
  return vec4f(positions[vertex_index], 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) frag_coord: vec4f) -> @location(0) vec4f {
  let w = present.image_size.x;
  let h = present.image_size.y;
  let cw = max(present.canvas_size.x, 1u);
  let ch = max(present.canvas_size.y, 1u);

  let x = min(u32(frag_coord.x * f32(w) / f32(cw)), w - 1u);
  let y = min(u32(frag_coord.y * f32(h) / f32(ch)), h - 1u);
  let use_morton = (present.flags & PRESENT_FLAG_MORTON) != 0u;
  let idx = present_pixel_index(x, y, w, h, use_morton);
  return image_ro[idx];
}

