// =============================================================================
//  device.ts — Inicialización de WebGPU: adaptador, dispositivo, canvas y límites.
// =============================================================================
//  ¿Por qué existe?
//    Toda la aplicación necesita un `GPUDevice` (la "conexión lógica" con la
//    GPU) y un contexto de canvas configurado. Además, este proyecto depende de
//    varios límites del hardware que NO son infinitos:
//
//      - Cuántos storage buffers puede ver una misma etapa de shader
//        (`maxStorageBuffersPerShaderStage`, por defecto 8). El compute shader
//        usa 7 (ver TRACE_STORAGE_BUFFER_COUNT en pipelines.ts).
//      - Tamaño máximo de un storage buffer (la imagen a 4K ocupa ~33 MB).
//
//    Aquí se comprueban esos límites ANTES de crear nada, para dar un mensaje
//    claro si el dispositivo no alcanza, en vez de un error críptico después.
//
//  Estructura del proyecto que implementa: capa "GPU" (ver docs/ARQUITECTURA.md).
// =============================================================================

/** Todo lo que el resto del programa necesita saber de la GPU. */
export interface GpuContext {
  adapter: GPUAdapter;
  device: GPUDevice;
  canvas: HTMLCanvasElement;
  context: GPUCanvasContext;
  /** Formato de color preferido del canvas (normalmente 'bgra8unorm'). */
  format: GPUTextureFormat;
  /** true si el dispositivo soporta consultas de tiempo de GPU ('timestamp-query'). */
  hasTimestamps: boolean;
}

/** Requisitos mínimos del proyecto. Si el adaptador no los cumple, se avisa. */
export interface GpuRequirements {
  /** Storage buffers que necesita la etapa de cómputo. */
  storageBuffersPerStage: number;
  /** Tamaño mínimo deseado para un storage buffer (bytes). */
  storageBufferBindingSize: number;
}

/** Error "amigable" cuyo mensaje se puede mostrar directamente al usuario. */
export class GpuUnavailableError extends Error {}

/**
 * Pide adaptador y dispositivo, comprueba límites y configura el canvas.
 *
 * Por qué pedimos `requiredLimits` explícitos: WebGPU entrega por defecto los
 * límites MÍNIMOS garantizados, aunque el hardware soporte más. Si queremos un
 * storage buffer más grande que el mínimo hay que pedirlo al crear el device.
 */
export async function initGpu(canvas: HTMLCanvasElement, req: GpuRequirements): Promise<GpuContext> {
  if (!('gpu' in navigator) || !navigator.gpu) {
    throw new GpuUnavailableError(
      'Este navegador no soporta WebGPU. Usa Chrome/Edge 113+ (o Firefox/Safari con WebGPU activado).',
    );
  }

  // Probamos primero `requestAdapter()` sin argumentos (el camino más compatible
  // en todos los navegadores), luego modo de compatibilidad y por último el
  // adaptador de respaldo (WARP/software) si la GPU principal está bloqueada.
  const adapter =
    (await navigator.gpu.requestAdapter()) ??
    (await navigator.gpu.requestAdapter({ featureLevel: 'compatibility' } as GPURequestAdapterOptions)) ??
    (await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })) ??
    (await navigator.gpu.requestAdapter({ powerPreference: 'low-power' })) ??
    (await navigator.gpu.requestAdapter({ forceFallbackAdapter: true }));
  if (!adapter) {
    throw new GpuUnavailableError(
      'No se encontró un adaptador WebGPU. Verifica en tu navegador (chrome://gpu o edge://gpu) que ' +
        '"Usar aceleración gráfica cuando esté disponible" esté activado en Configuración → Sistema.',
    );
  }

  // ---- Comprobación de límites ---------------------------------------------
  // Nuestro trazador usa 7 storage buffers (≤ 8 por defecto de WebGPU) y ~15 MB
  // para la imagen (≤ 128 MB por defecto), así que cabe dentro de los límites
  // estándar de cualquier dispositivo WebGPU sin pedir features ni límites extra
  // que puedan hacer fallar `requestDevice()`.
  const lim = adapter.limits;
  if (lim.maxStorageBuffersPerShaderStage < req.storageBuffersPerStage) {
    throw new GpuUnavailableError(
      `El dispositivo solo permite ${lim.maxStorageBuffersPerShaderStage} storage buffers por etapa ` +
        `y el trazador necesita ${req.storageBuffersPerStage}.`,
    );
  }
  if (lim.maxStorageBufferBindingSize < req.storageBufferBindingSize) {
    throw new GpuUnavailableError(
      `El límite de storage buffer del dispositivo (${(lim.maxStorageBufferBindingSize / 2 ** 20).toFixed(1)} MB) ` +
        `es menor que el requerido (${(req.storageBufferBindingSize / 2 ** 20).toFixed(1)} MB).`,
    );
  }

  const device = await adapter.requestDevice();
  const hasTimestamps = false;

  // Errores de validación no capturados: los mostramos siempre en consola.
  device.addEventListener('uncapturederror', (ev) => {
    console.error('[WebGPU] error no capturado:', (ev as GPUUncapturedErrorEvent).error.message);
  });

  // ---- Canvas ----------------------------------------------------------------
  const context = canvas.getContext('webgpu');
  if (!context) throw new GpuUnavailableError('No se pudo obtener el contexto "webgpu" del canvas.');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  console.info(
    `[WebGPU] adaptador listo. storage buffers/etapa=${device.limits.maxStorageBuffersPerShaderStage}, ` +
      `maxStorageBufferBindingSize=${(device.limits.maxStorageBufferBindingSize / 2 ** 20).toFixed(0)} MB, ` +
      `timestamps=${hasTimestamps ? 'sí' : 'no'}`,
  );

  return { adapter, device, canvas, context, format, hasTimestamps };
}

