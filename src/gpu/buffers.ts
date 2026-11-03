// =============================================================================
//  buffers.ts — Creación, empaquetado estático y actualización por fotograma de buffers GPU.
// =============================================================================
//  ¿Por qué dividimos los buffers en ESTÁTICOS y DINÁMICOS?
//    Requisito de la sección 11:
//      "Sube la malla una vez; por fotograma solo se actualizan instancias,
//       TLAS y uniforms."
//
//    1. Buffers estáticos (se crean y suben UNA sola vez al iniciar):
//         - `vertexBuffer`: vértices de todas las mallas únicas concatenadas.
//         - `indexBuffer`: índices de triángulos (ya reordenados por Morton).
//         - `blasBuffer`: todos los nodos BLAS concatenados.
//         - `meshInfoBuffer`: tabla `MeshInfo` con los offsets de cada malla.
//         - `materialBuffer`: tabla de materiales (`array<Material, 64>`).
//
//    2. Buffers dinámicos (se actualizan cada fotograma con `queue.writeBuffer`):
//         - `frameUniformBuffer`: cámara, luz, banderas, parámetros RK4 y agujeros negros.
//         - `presentUniformBuffer`: dimensiones de imagen/canvas y bandera Morton.
//         - `tlasBuffer`: nodos del TLAS reconstruido para las posiciones actuales.
//         - `instanceBuffer`: matrices `worldFromLocal` y `localFromWorld` de cada instancia.
// =============================================================================
import { buildBlas, buildTlas } from '../accel/bvhBuilder';
import { BVH_NODE_WORDS, flattenBvh } from '../accel/bvhFlatten';
import { VERTEX_FLOATS, type Aabb, type Mesh, type Vec3 } from '../geometry/mesh';
import type { CameraBasis } from '../scene/camera';
import { instanceWorldBounds, packInstances, packMaterials, type Instance } from '../scene/instances';
import type { BlackHoleInstance, SceneGraph } from '../scene/sceneGraph';
import {
  BVH_NODE,
  FLAG_BVH,
  FLAG_GRAVITY,
  FLAG_MORTON,
  FRAME_UNIFORMS,
  INSTANCE,
  MATERIAL,
  MAX_BLACK_HOLES,
  MAX_MATERIALS,
  MESH_INFO,
  PRESENT_UNIFORMS,
  VERTEX,
} from './layouts';

/** Geometría estática ya empaquetada en CPU (útil también para pruebas unitarias). */
export interface PackedStaticGeometry {
  vertices: Float32Array;
  indices: Uint32Array;
  blasNodes: ArrayBuffer;
  meshInfos: Uint32Array;
  meshLocalBounds: Aabb[];
  totalTriangles: number;
  totalBlasNodes: number;
}

/**
 * Construye el BLAS de cada malla única del `SceneGraph` y concatena sus
 * vértices, índices (ordenados por Morton) y nodos BLAS en buffers contiguos.
 */
export function packStaticGeometry(meshes: Mesh[]): PackedStaticGeometry {
  let totalVertices = 0;
  let totalIndices = 0;
  let totalBlasNodes = 0;

  const built = meshes.map((m) => {
    const { bvh, orderedIndices } = buildBlas(m);
    const flat = flattenBvh(bvh, totalBlasNodes, totalIndices / 3);
    const entry = {
      mesh: m,
      bvh,
      orderedIndices,
      flat,
      vertexOffset: totalVertices,
      triangleOffset: totalIndices / 3,
      blasOffset: totalBlasNodes,
      bounds: m.computeBounds(),
    };
    totalVertices += m.vertexCount;
    totalIndices += orderedIndices.length;
    totalBlasNodes += bvh.nodeCount;
    return entry;
  });

  const vertices = new Float32Array(Math.max(1, totalVertices) * VERTEX_FLOATS);
  const indices = new Uint32Array(Math.max(3, totalIndices));
  const blasNodes = new ArrayBuffer(Math.max(1, totalBlasNodes) * BVH_NODE.size);
  const blasU32 = new Uint32Array(blasNodes);
  const meshInfos = new Uint32Array(Math.max(1, meshes.length) * (MESH_INFO.size / 4));

  built.forEach((b, meshId) => {
    vertices.set(b.mesh.vertices, b.vertexOffset * VERTEX_FLOATS);
    indices.set(b.orderedIndices, b.triangleOffset * 3);
    blasU32.set(new Uint32Array(b.flat), b.blasOffset * BVH_NODE_WORDS);

    const infoBase = meshId * 4;
    meshInfos[infoBase + 0] = b.vertexOffset;
    meshInfos[infoBase + 1] = b.triangleOffset;
    meshInfos[infoBase + 2] = b.blasOffset;
    meshInfos[infoBase + 3] = b.mesh.triangleCount;
  });

  return {
    vertices,
    indices,
    blasNodes,
    meshInfos,
    meshLocalBounds: built.map((b) => b.bounds),
    totalTriangles: totalIndices / 3,
    totalBlasNodes,
  };
}

export interface SceneGpuBuffers {
  frameUniformBuffer: GPUBuffer;
  presentUniformBuffer: GPUBuffer;
  materialBuffer: GPUBuffer;
  imageBuffer: GPUBuffer;
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  blasBuffer: GPUBuffer;
  meshInfoBuffer: GPUBuffer;
  tlasBuffer: GPUBuffer;
  instanceBuffer: GPUBuffer;
  staticStats: {
    uniqueMeshes: number;
    trianglesPerMesh: number;
    blasNodeCount: number;
  };
  meshLocalBounds: Aabb[];
  imageWidth: number;
  imageHeight: number;
  maxInstancesCapacity: number;
}

function createBufferWithData(
  device: GPUDevice,
  label: string,
  data: ArrayBuffer | ArrayBufferView,
  usage: GPUBufferUsageFlags,
): GPUBuffer {
  const byteLength = data instanceof ArrayBuffer ? data.byteLength : data.byteLength;
  const alignedSize = Math.max(16, (byteLength + 3) & ~3);
  const buffer = device.createBuffer({ label, size: alignedSize, usage: usage | GPUBufferUsage.COPY_DST });
  const src =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  device.queue.writeBuffer(buffer, 0, src);
  return buffer;
}

/**
 * Crea todos los buffers de la escena y sube por única vez las mallas, sus BLAS
 * y los materiales.
 */
export function createSceneBuffers(
  device: GPUDevice,
  graph: SceneGraph,
  imageWidth: number,
  imageHeight: number,
  maxInstancesCapacity = 256,
): SceneGpuBuffers {
  const packed = packStaticGeometry(graph.meshes);
  const materialsBuf = packMaterials(graph.materials);

  const frameUniformBuffer = device.createBuffer({
    label: 'frame-uniforms',
    size: FRAME_UNIFORMS.size,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const presentUniformBuffer = device.createBuffer({
    label: 'present-uniforms',
    size: PRESENT_UNIFORMS.size,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const materialBuffer = createBufferWithData(
    device,
    'materials-uniform',
    materialsBuf,
    GPUBufferUsage.UNIFORM,
  );

  const imageBuffer = device.createBuffer({
    label: 'raytraced-image',
    size: Math.max(1, imageWidth * imageHeight) * 16,
    usage: GPUBufferUsage.STORAGE,
  });

  const vertexBuffer = createBufferWithData(device, 'static-vertices', packed.vertices, GPUBufferUsage.STORAGE);
  const indexBuffer = createBufferWithData(device, 'static-indices', packed.indices, GPUBufferUsage.STORAGE);
  const blasBuffer = createBufferWithData(device, 'static-blas-nodes', packed.blasNodes, GPUBufferUsage.STORAGE);
  const meshInfoBuffer = createBufferWithData(device, 'static-mesh-infos', packed.meshInfos, GPUBufferUsage.STORAGE);

  // Capacidad sobrada para TLAS (≤ 2 * N nodos) e instancias.
  const tlasBuffer = device.createBuffer({
    label: 'dynamic-tlas-nodes',
    size: Math.max(2, maxInstancesCapacity * 2) * BVH_NODE.size,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  const instanceBuffer = device.createBuffer({
    label: 'dynamic-instances',
    size: Math.max(1, maxInstancesCapacity) * INSTANCE.size,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  // Verificación defensiva de tamaños contra layouts.ts.
  if (VERTEX.size !== 32 || MATERIAL.size * MAX_MATERIALS !== materialsBuf.byteLength) {
    throw new Error('Inconsistencia interna en el tamaño de los buffers estáticos.');
  }

  return {
    frameUniformBuffer,
    presentUniformBuffer,
    materialBuffer,
    imageBuffer,
    vertexBuffer,
    indexBuffer,
    blasBuffer,
    meshInfoBuffer,
    tlasBuffer,
    instanceBuffer,
    staticStats: {
      uniqueMeshes: graph.meshes.length,
      trianglesPerMesh: packed.totalTriangles,
      blasNodeCount: packed.totalBlasNodes,
    },
    meshLocalBounds: packed.meshLocalBounds,
    imageWidth,
    imageHeight,
    maxInstancesCapacity,
  };
}

export interface FrameParamsInput {
  camera: CameraBasis;
  imageWidth: number;
  imageHeight: number;
  canvasWidth: number;
  canvasHeight: number;
  time: number;
  escapeRadius: number;
  lightPos: Vec3;
  lightColor: Vec3;
  ambient: number;
  gravityEnabled: boolean;
  bvhEnabled: boolean;
  mortonEnabled: boolean;
  viewMode: number;
  stepK: number;
  dtMin: number;
  dtMaxRel: number;
  dtMaxAbs: number;
  maxSteps: number;
  blackHoles: BlackHoleInstance[];
}

export interface DynamicFrameStats {
  instanceCount: number;
  tlasNodeCount: number;
  totalTrianglesInScene: number;
  threadCount: number;
}

/**
 * Reconstruye el TLAS en CPU y sube únicamente los buffers dinámicos del
 * fotograma: `instanceBuffer`, `tlasBuffer`, `frameUniformBuffer` y
 * `presentUniformBuffer`.
 */
export function updateDynamicBuffers(
  device: GPUDevice,
  buffers: SceneGpuBuffers,
  instances: Instance[],
  params: FrameParamsInput,
): DynamicFrameStats {
  if (instances.length > buffers.maxInstancesCapacity) {
    throw new Error(`El número de instancias (${instances.length}) supera la capacidad (${buffers.maxInstancesCapacity}).`);
  }

  // 1. AABBs de mundo + construcción del TLAS + empaquetado de instancias en el orden del TLAS.
  const worldBounds = instanceWorldBounds(instances, buffers.meshLocalBounds);
  const tlas = buildTlas(worldBounds);
  const flatTlas = flattenBvh(tlas);
  const packedInst = packInstances(instances, tlas.order);

  device.queue.writeBuffer(buffers.tlasBuffer, 0, flatTlas);
  device.queue.writeBuffer(buffers.instanceBuffer, 0, packedInst);

  // 2. Banderas y número total de hilos a despachar (redondeado a bloques 8×8 si Morton está activo).
  let flags = 0;
  if (params.gravityEnabled) flags |= FLAG_GRAVITY;
  if (params.bvhEnabled) flags |= FLAG_BVH;
  if (params.mortonEnabled) flags |= FLAG_MORTON;

  const tilesX = Math.ceil(params.imageWidth / 8);
  const tilesY = Math.ceil(params.imageHeight / 8);
  const threadCount = params.mortonEnabled ? tilesX * tilesY * 64 : params.imageWidth * params.imageHeight;

  // Escala del mapa de calor de nodos BVH: en modo BVH ~160 nodos es caliente;
  // en fuerza bruta escalamos al total de triángulos para que el gradiente sea legible.
  const totalTrianglesInScene = instances.length * buffers.staticStats.trianglesPerMesh;
  const heatMax = params.bvhEnabled ? 180.0 : Math.max(1000.0, totalTrianglesInScene);

  // 3. Empaquetar FrameUniforms (224 bytes).
  const frameBuf = new ArrayBuffer(FRAME_UNIFORMS.size);
  const f32 = new Float32Array(frameBuf);
  const u32 = new Uint32Array(frameBuf);
  const o = FRAME_UNIFORMS.offsets;

  f32.set(params.camera.position, o.cam_pos / 4);
  f32[o.tan_half_fov / 4] = params.camera.tanHalfFov;
  f32.set(params.camera.right, o.cam_right / 4);
  f32[o.aspect / 4] = params.imageWidth / Math.max(1, params.imageHeight);
  f32.set(params.camera.up, o.cam_up / 4);
  f32[o.escape_r / 4] = params.escapeRadius;
  f32.set(params.camera.forward, o.cam_fwd / 4);
  f32[o.time / 4] = params.time;
  f32.set(params.lightPos, o.light_pos / 4);
  f32[o.ambient / 4] = params.ambient;
  f32.set(params.lightColor, o.light_color / 4);
  f32[o.heat_max / 4] = heatMax;

  u32[o.width / 4] = params.imageWidth;
  u32[o.height / 4] = params.imageHeight;
  u32[o.max_steps / 4] = params.maxSteps;
  u32[o.flags / 4] = flags;

  f32[o.step_k / 4] = params.stepK;
  f32[o.dt_min / 4] = params.dtMin;
  f32[o.dt_max_rel / 4] = params.dtMaxRel;
  f32[o.dt_max_abs / 4] = params.dtMaxAbs;

  const bhCount = Math.min(params.blackHoles.length, MAX_BLACK_HOLES);
  u32[o.bh_count / 4] = bhCount;
  u32[o.view_mode / 4] = params.viewMode;
  u32[o.instance_count / 4] = instances.length;
  u32[o.thread_offset / 4] = 0;
  u32[o.thread_count / 4] = threadCount;

  for (let i = 0; i < bhCount; i++) {
    const bh = params.blackHoles[i];
    const base = o.black_holes / 4 + i * 4;
    f32[base + 0] = bh.position[0];
    f32[base + 1] = bh.position[1];
    f32[base + 2] = bh.position[2];
    f32[base + 3] = bh.rs;
  }

  device.queue.writeBuffer(buffers.frameUniformBuffer, 0, frameBuf);

  // 4. Empaquetar PresentUniforms (32 bytes).
  const presentBuf = new Uint32Array(PRESENT_UNIFORMS.size / 4);
  presentBuf[0] = params.imageWidth;
  presentBuf[1] = params.imageHeight;
  presentBuf[2] = params.canvasWidth;
  presentBuf[3] = params.canvasHeight;
  presentBuf[4] = flags;
  device.queue.writeBuffer(buffers.presentUniformBuffer, 0, presentBuf);

  return {
    instanceCount: instances.length,
    tlasNodeCount: tlas.nodeCount,
    totalTrianglesInScene,
    threadCount,
  };
}

