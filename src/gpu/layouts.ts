// =============================================================================
//  layouts.ts — Fuente única de verdad del layout en memoria de los structs GPU.
// =============================================================================
//  ¿Por qué existe?
//    CPU (TypeScript) y GPU (WGSL) comparten bytes, no objetos. Si el
//    TypeScript escribe un campo en el byte 28 pero el shader lo lee en el 32,
//    la imagen sale mal SIN ningún error. Las reglas de alineamiento de WGSL
//    hacen que esto sea fácil de equivocar:
//
//        tipo       tamaño  alineamiento
//        f32/u32       4        4
//        vec2f         8        8
//        vec3f        12       16   ← ¡el caso traicionero!
//        vec4f        16       16
//        mat4x4f      64       16
//        struct    redondeado al mayor alineamiento de sus campos
//
//    Por eso TODOS los offsets usados para empaquetar datos salen de aquí, y la
//    prueba tests/layout.test.ts analiza el WGSL real (common.wgsl,
//    present.wgsl), recalcula los offsets con las reglas de arriba y exige que
//    coincidan con estas tablas. Además, `minBindingSize` en los bind group
//    layouts (pipelines.ts) hace que WebGPU valide el tamaño en tiempo de
//    ejecución.
//
//  Estructura del proyecto: capa GPU; documentado en docs/ESTRUCTURAS_DE_DATOS.md.
// =============================================================================

/** Descripción de un struct: tamaño total y offset (en bytes) de cada campo. */
export interface StructLayout<F extends string> {
  name: string;
  size: number;
  offsets: Record<F, number>;
}

// ---------------------------------------------------------------------------
//  Constantes compartidas con common.wgsl (la prueba de layout las compara).
// ---------------------------------------------------------------------------
export const MAX_BLACK_HOLES = 4;
export const MAX_MATERIALS = 64;
export const BVH_STACK_SIZE = 32;
export const WORKGROUP_SIZE = 64;

/** Bits del campo `flags` de FrameUniforms / PresentUniforms. */
export const FLAG_GRAVITY = 1;
export const FLAG_BVH = 2;
export const FLAG_MORTON = 4;

/** Valores de `view_mode`. */
export const VIEW_NORMAL = 0;
export const VIEW_HEAT_STEPS = 1;
export const VIEW_HEAT_BVH = 2;

// ---------------------------------------------------------------------------
//  FrameUniforms (uniform, 224 bytes): todo lo que cambia cada fotograma.
// ---------------------------------------------------------------------------
export const FRAME_UNIFORMS: StructLayout<
  | 'cam_pos' | 'tan_half_fov' | 'cam_right' | 'aspect' | 'cam_up' | 'escape_r' | 'cam_fwd' | 'time'
  | 'light_pos' | 'ambient' | 'light_color' | 'heat_max'
  | 'width' | 'height' | 'max_steps' | 'flags'
  | 'step_k' | 'dt_min' | 'dt_max_rel' | 'dt_max_abs'
  | 'bh_count' | 'view_mode' | 'instance_count' | 'thread_offset'
  | 'thread_count' | '_pad0' | '_pad1' | '_pad2'
  | 'black_holes'
> = {
  name: 'FrameUniforms',
  size: 224,
  offsets: {
    cam_pos: 0, tan_half_fov: 12,
    cam_right: 16, aspect: 28,
    cam_up: 32, escape_r: 44,
    cam_fwd: 48, time: 60,
    light_pos: 64, ambient: 76,
    light_color: 80, heat_max: 92,
    width: 96, height: 100, max_steps: 104, flags: 108,
    step_k: 112, dt_min: 116, dt_max_rel: 120, dt_max_abs: 124,
    bh_count: 128, view_mode: 132, instance_count: 136, thread_offset: 140,
    thread_count: 144, _pad0: 148, _pad1: 152, _pad2: 156,
    black_holes: 160, // array<vec4f, MAX_BLACK_HOLES>: xyz = centro, w = rs
  },
};

// ---------------------------------------------------------------------------
//  PresentUniforms (uniform, 32 bytes): lo que necesita el fragment shader.
// ---------------------------------------------------------------------------
export const PRESENT_UNIFORMS: StructLayout<'image_size' | 'canvas_size' | 'flags' | '_pad0' | '_pad1' | '_pad2'> = {
  name: 'PresentUniforms',
  size: 32,
  offsets: { image_size: 0, canvas_size: 8, flags: 16, _pad0: 20, _pad1: 24, _pad2: 28 },
};

// ---------------------------------------------------------------------------
//  Material (uniform array<Material, MAX_MATERIALS>, 48 bytes por elemento).
// ---------------------------------------------------------------------------
export const MATERIAL: StructLayout<'base_color' | 'secondary_color' | 'emission'> = {
  name: 'Material',
  size: 48,
  offsets: { base_color: 0, secondary_color: 16, emission: 32 },
};

// ---------------------------------------------------------------------------
//  Vertex (storage, 32 bytes) — ver geometry/mesh.ts.
// ---------------------------------------------------------------------------
export const VERTEX: StructLayout<'position' | 'normal'> = {
  name: 'Vertex',
  size: 32,
  offsets: { position: 0, normal: 16 },
};

// ---------------------------------------------------------------------------
//  BvhNode (storage, 32 bytes) — ver accel/bvhFlatten.ts.
// ---------------------------------------------------------------------------
export const BVH_NODE: StructLayout<'aabb_min' | 'right_or_first' | 'aabb_max' | 'count'> = {
  name: 'BvhNode',
  size: 32,
  offsets: { aabb_min: 0, right_or_first: 12, aabb_max: 16, count: 28 },
};

// ---------------------------------------------------------------------------
//  Instance (storage, 144 bytes) — ver scene/instances.ts.
// ---------------------------------------------------------------------------
export const INSTANCE: StructLayout<'world_from_local' | 'local_from_world' | 'mesh_id' | 'material_id' | '_pad0' | '_pad1'> = {
  name: 'Instance',
  size: 144,
  offsets: { world_from_local: 0, local_from_world: 64, mesh_id: 128, material_id: 132, _pad0: 136, _pad1: 140 },
};

// ---------------------------------------------------------------------------
//  MeshInfo (storage, 16 bytes): dónde empieza cada malla en los buffers globales.
// ---------------------------------------------------------------------------
export const MESH_INFO: StructLayout<'vertex_offset' | 'triangle_offset' | 'blas_offset' | 'triangle_count'> = {
  name: 'MeshInfo',
  size: 16,
  offsets: { vertex_offset: 0, triangle_offset: 4, blas_offset: 8, triangle_count: 12 },
};

/** Todos los layouts, para recorrerlos en la prueba de layout. */
export const ALL_LAYOUTS: StructLayout<string>[] = [
  FRAME_UNIFORMS, PRESENT_UNIFORMS, MATERIAL, VERTEX, BVH_NODE, INSTANCE, MESH_INFO,
];

