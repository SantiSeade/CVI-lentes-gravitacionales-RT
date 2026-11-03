// =============================================================================
//  pipelines.ts — Creación de los pipelines de cómputo (`trace`) y presentación (`vs`/`fs`).
// =============================================================================
//  ¿Por qué declaramos el `BindGroupLayout` de forma explícita con `minBindingSize`?
//    - Verifica en tiempo de creación que el número de storage buffers del
//      compute stage es exactamente `TRACE_STORAGE_BUFFER_COUNT = 7` (por debajo
//      del límite mínimo de 8 de la especificación WebGPU, sección 11).
//    - Pasar `minBindingSize` con los tamaños de `layouts.ts` hace que el propio
//      validador de WebGPU compruebe que ningún struct en WGSL es mayor que lo
//      empaquetado en TypeScript.
// =============================================================================
import {
  buildPresentShaderSource,
  buildTraceShaderSource,
  logShaderCompilation,
} from '../shaders';
import type { SceneGpuBuffers } from './buffers';
import {
  BVH_NODE,
  FRAME_UNIFORMS,
  INSTANCE,
  MATERIAL,
  MAX_MATERIALS,
  MESH_INFO,
  PRESENT_UNIFORMS,
  VERTEX,
} from './layouts';

/** Número exacto de storage buffers que enlaza el compute shader `trace` (≤ 8). */
export const TRACE_STORAGE_BUFFER_COUNT = 7;

export interface GpuPipelines {
  computePipeline: GPUComputePipeline;
  renderPipeline: GPURenderPipeline;
  computeBindGroupLayout: GPUBindGroupLayout;
  renderBindGroupLayout: GPUBindGroupLayout;
  computeBindGroup: GPUBindGroup;
  renderBindGroup: GPUBindGroup;
}

export async function createPipelines(
  device: GPUDevice,
  canvasFormat: GPUTextureFormat,
  buffers: SceneGpuBuffers,
): Promise<GpuPipelines> {
  // 1. Compilar ambos módulos WGSL y volcar mensajes con archivo/línea reales.
  const traceSource = buildTraceShaderSource();
  const presentSource = buildPresentShaderSource();

  const traceModule = device.createShaderModule({ label: 'trace-shader', code: traceSource.code });
  const presentModule = device.createShaderModule({ label: 'present-shader', code: presentSource.code });

  await Promise.all([
    logShaderCompilation(traceModule, traceSource, 'trace'),
    logShaderCompilation(presentModule, presentSource, 'present'),
  ]);

  // 2. Layouts explícitos de bind group.
  const computeBindGroupLayout = device.createBindGroupLayout({
    label: 'trace-bgl',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', minBindingSize: FRAME_UNIFORMS.size } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', minBindingSize: MATERIAL.size * MAX_MATERIALS } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage', minBindingSize: 16 } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage', minBindingSize: VERTEX.size } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage', minBindingSize: 12 } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage', minBindingSize: BVH_NODE.size } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage', minBindingSize: MESH_INFO.size } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage', minBindingSize: BVH_NODE.size } },
      { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage', minBindingSize: INSTANCE.size } },
    ],
  });

  const renderBindGroupLayout = device.createBindGroupLayout({
    label: 'present-bgl',
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: PRESENT_UNIFORMS.size } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage', minBindingSize: 16 } },
    ],
  });

  // 3. Pipelines de cómputo y de presentación.
  const computePipeline = device.createComputePipeline({
    label: 'trace-pipeline',
    layout: device.createPipelineLayout({ bindGroupLayouts: [computeBindGroupLayout] }),
    compute: { module: traceModule, entryPoint: 'trace' },
  });

  const renderPipeline = device.createRenderPipeline({
    label: 'present-pipeline',
    layout: device.createPipelineLayout({ bindGroupLayouts: [renderBindGroupLayout] }),
    vertex: { module: presentModule, entryPoint: 'vs' },
    fragment: { module: presentModule, entryPoint: 'fs', targets: [{ format: canvasFormat }] },
    primitive: { topology: 'triangle-list' },
  });

  const { computeBindGroup, renderBindGroup } = createBindGroups(
    device,
    computeBindGroupLayout,
    renderBindGroupLayout,
    buffers,
  );

  return {
    computePipeline,
    renderPipeline,
    computeBindGroupLayout,
    renderBindGroupLayout,
    computeBindGroup,
    renderBindGroup,
  };
}

/** Construye (o reconstruye si cambia el buffer de imagen) los bind groups. */
export function createBindGroups(
  device: GPUDevice,
  computeBindGroupLayout: GPUBindGroupLayout,
  renderBindGroupLayout: GPUBindGroupLayout,
  buffers: SceneGpuBuffers,
): { computeBindGroup: GPUBindGroup; renderBindGroup: GPUBindGroup } {
  const computeBindGroup = device.createBindGroup({
    label: 'trace-bg',
    layout: computeBindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: buffers.frameUniformBuffer } },
      { binding: 1, resource: { buffer: buffers.materialBuffer } },
      { binding: 2, resource: { buffer: buffers.imageBuffer } },
      { binding: 3, resource: { buffer: buffers.vertexBuffer } },
      { binding: 4, resource: { buffer: buffers.indexBuffer } },
      { binding: 5, resource: { buffer: buffers.blasBuffer } },
      { binding: 6, resource: { buffer: buffers.meshInfoBuffer } },
      { binding: 7, resource: { buffer: buffers.tlasBuffer } },
      { binding: 8, resource: { buffer: buffers.instanceBuffer } },
    ],
  });

  const renderBindGroup = device.createBindGroup({
    label: 'present-bg',
    layout: renderBindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: buffers.presentUniformBuffer } },
      { binding: 1, resource: { buffer: buffers.imageBuffer } },
    ],
  });

  return { computeBindGroup, renderBindGroup };
}

