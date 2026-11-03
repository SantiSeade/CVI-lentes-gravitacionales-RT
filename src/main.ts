// =============================================================================
//  main.ts — Punto de entrada y bucle principal de simulación y renderizado.
// =============================================================================
//  Orquesta todas las piezas del proyecto:
//    1. Inicializa WebGPU y verifica los límites del dispositivo (`device.ts`).
//    2. Construye el sistema solar con 1 malla de icosfera compartida por la
//       estrella, los 6 planetas y las 3 lunas (`solarSystem.ts`).
//    3. Sube la geometría estática y su BLAS (ordenado por Morton) UNA sola vez
//       a la GPU (`buffers.ts`).
//    4. Compila los shaders WGSL concatenados y crea los pipelines de cómputo
//       (`trace`) y presentación (`vs`/`fs`) (`pipelines.ts`).
//    5. En cada fotograma:
//         a) Avanza el tiempo de la escena (si no está en pausa) y propaga las
//            matrices jerárquicas (`graph.update(simTime)`).
//         b) Recolecta las instancias, reconstruye el TLAS en CPU y sube solo
//            los buffers dinámicos (`updateDynamicBuffers`).
//         c) Ejecuta el compute pass (`trace`, 1 hilo = 1 rayo curvo con RK4)
//            y luego el render pass que presenta la imagen en el canvas.
// =============================================================================
import { createSceneBuffers, updateDynamicBuffers } from './gpu/buffers';
import { GpuUnavailableError, initGpu } from './gpu/device';
import { WORKGROUP_SIZE } from './gpu/layouts';
import { createPipelines, TRACE_STORAGE_BUFFER_COUNT } from './gpu/pipelines';
import { OrbitCamera } from './scene/camera';
import { createSolarSystem } from './scene/solarSystem';
import { attachControls, createDefaultSimState } from './ui/controls';
import { StatsOverlay } from './ui/stats';

/** Escala de la resolución interna de trazado respecto al tamaño CSS de la ventana. */
const RENDER_SCALE = 0.65;
const MAX_RAY_WIDTH = 1280;
const MAX_RAY_HEIGHT = 720;

function computeRayResolution(): { imageWidth: number; imageHeight: number; canvasWidth: number; canvasHeight: number } {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = Math.max(320, window.innerWidth);
  const cssH = Math.max(240, window.innerHeight);
  const canvasWidth = Math.floor(cssW * dpr);
  const canvasHeight = Math.floor(cssH * dpr);

  // Redondeamos a múltiplo de 8 para que los bloques 8×8 de Morton encajen limpios.
  const rawW = Math.min(MAX_RAY_WIDTH, Math.max(320, Math.floor(cssW * RENDER_SCALE)));
  const rawH = Math.min(MAX_RAY_HEIGHT, Math.max(200, Math.floor(cssH * RENDER_SCALE)));
  const imageWidth = Math.max(64, rawW & ~7);
  const imageHeight = Math.max(64, rawH & ~7);

  return { imageWidth, imageHeight, canvasWidth, canvasHeight };
}

function showError(message: string): void {
  const errorEl = document.getElementById('error');
  if (errorEl) {
    errorEl.style.display = 'block';
    errorEl.innerHTML = `<h3>No se pudo iniciar WebGPU</h3><p>${message}</p>`;
  }
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
  const statsEl = document.getElementById('stats');
  const panelEl = document.getElementById('panel');
  if (!canvas || !statsEl || !panelEl) {
    throw new Error('Faltan elementos HTML requeridos (#canvas, #stats, #panel).');
  }

  const initialRes = computeRayResolution();
  canvas.width = initialRes.canvasWidth;
  canvas.height = initialRes.canvasHeight;

  const gpu = await initGpu(canvas, {
    storageBuffersPerStage: TRACE_STORAGE_BUFFER_COUNT,
    storageBufferBindingSize: MAX_RAY_WIDTH * MAX_RAY_HEIGHT * 16,
  });

  // ---- Escena inicial (icosfera subdividida + sistema planetario) ------------
  const solar = createSolarSystem({ icosphereSubdivisions: 4 });
  const camera = new OrbitCamera();
  const simState = createDefaultSimState();

  const buffers = createSceneBuffers(
    gpu.device,
    solar.graph,
    initialRes.imageWidth,
    initialRes.imageHeight,
  );
  const pipelines = await createPipelines(gpu.device, gpu.format, buffers);

  attachControls(canvas, panelEl, camera, simState, (enabled) => {
    solar.secondaryBlackHoleNode.enabled = enabled;
  });
  const stats = new StatsOverlay(statsEl);

  window.addEventListener('resize', () => {
    const r = computeRayResolution();
    canvas.width = r.canvasWidth;
    canvas.height = r.canvasHeight;
  });

  // ---- Bucle de animación y renderizado -------------------------------------
  let simTime = 0;
  let lastWallTime = performance.now();

  const frame = (now: number): void => {
    const dt = Math.min(0.1, (now - lastWallTime) / 1000);
    lastWallTime = now;
    if (!simState.paused) {
      simTime += dt;
    }

    // 1. Actualizar jerarquía de escena en CPU.
    solar.graph.update(simTime);
    const instances = solar.graph.collectInstances();
    const blackHoles = solar.graph.collectBlackHoles();
    const starPos = solar.starNode.worldPosition();
    const camBasis = camera.computeBasis();

    // 2. Reconstruir TLAS y subir únicamente los buffers dinámicos.
    const dynStats = updateDynamicBuffers(gpu.device, buffers, instances, {
      camera: camBasis,
      imageWidth: buffers.imageWidth,
      imageHeight: buffers.imageHeight,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      time: simTime,
      escapeRadius: solar.escapeRadius,
      lightPos: starPos,
      lightColor: [1.0, 0.95, 0.85],
      ambient: 0.14,
      gravityEnabled: simState.gravityEnabled,
      bvhEnabled: simState.bvhEnabled,
      mortonEnabled: simState.mortonEnabled,
      viewMode: simState.viewMode,
      stepK: simState.stepK,
      dtMin: simState.dtMin,
      dtMaxRel: simState.dtMaxRel,
      dtMaxAbs: simState.dtMaxAbs,
      maxSteps: simState.maxSteps,
      blackHoles,
    });

    // 3. Ejecutar compute pass (trazado geodésico) + render pass (presentación).
    const encoder = gpu.device.createCommandEncoder();

    const computePass = encoder.beginComputePass();
    computePass.setPipeline(pipelines.computePipeline);
    computePass.setBindGroup(0, pipelines.computeBindGroup);
    const workgroups = Math.ceil(dynStats.threadCount / WORKGROUP_SIZE);
    computePass.dispatchWorkgroups(workgroups, 1, 1);
    computePass.end();

    const renderPass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: gpu.context.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    renderPass.setPipeline(pipelines.renderPipeline);
    renderPass.setBindGroup(0, pipelines.renderBindGroup);
    renderPass.draw(3);
    renderPass.end();

    gpu.device.queue.submit([encoder.finish()]);

    // 4. Actualizar estadísticas en pantalla.
    stats.update(
      now,
      {
        imageWidth: buffers.imageWidth,
        imageHeight: buffers.imageHeight,
        uniqueMeshes: buffers.staticStats.uniqueMeshes,
        trianglesPerMesh: buffers.staticStats.trianglesPerMesh,
        instanceCount: dynStats.instanceCount,
        totalTrianglesInScene: dynStats.totalTrianglesInScene,
        blasNodeCount: buffers.staticStats.blasNodeCount,
        tlasNodeCount: dynStats.tlasNodeCount,
        blackHoleCount: blackHoles.length,
      },
      simState,
    );

    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
}

main().catch((err: unknown) => {
  console.error(err);
  showError(err instanceof GpuUnavailableError || err instanceof Error ? err.message : String(err));
});
