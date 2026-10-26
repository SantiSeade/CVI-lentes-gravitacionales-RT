// =============================================================================
//  main.js  -  Lado CPU del proof of concept
// =============================================================================
//  Responsabilidades (la GPU hace todo el trabajo pesado en shader.wgsl):
//    1. Pedir un dispositivo WebGPU.
//    2. Crear buffers: uniforms (parámetros) e imagen (un vec4 por píxel).
//    3. Crear 2 pipelines: COMPUTE (traza rayos) y RENDER (muestra la imagen).
//    4. Cada fotograma: actualizar uniforms -> dispatch compute -> dibujar.
//    5. Tecla G: activar/desactivar la gravedad para comparar con luz recta.
// =============================================================================

const WIDTH = 800;   // resolución interna del trazado (píxeles = rayos)
const HEIGHT = 450;

async function main() {
  // ---- 1. Inicializar WebGPU ------------------------------------------------
  if (!navigator.gpu) {
    document.body.innerHTML = '<p style="color:white">Tu navegador no soporta WebGPU. Usa Chrome/Edge 113+.</p>';
    return;
  }
  const adapter = await navigator.gpu.requestAdapter();   // la GPU física
  const device = await adapter.requestDevice();           // conexión lógica a la GPU

  const canvas = document.getElementById('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format });

  // ---- 2. Cargar y compilar el shader ---------------------------------------
  const code = await (await fetch('./src/shader.wgsl')).text();
  const module = device.createShaderModule({ code });

  // Si el WGSL tiene errores, mostrarlos en la consola con su línea.
  const info = await module.getCompilationInfo();
  for (const m of info.messages) console.warn(`WGSL ${m.type} (línea ${m.lineNum}): ${m.message}`);

  // ---- 3. Buffers -----------------------------------------------------------
  // Uniforms: res.x, res.y, time, gravity  -> 4 floats = 16 bytes.
  const uniformBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // Imagen: un vec4<f32> (16 bytes) por píxel. El compute escribe, el fragment lee.
  const imageBuffer = device.createBuffer({
    size: WIDTH * HEIGHT * 16,
    usage: GPUBufferUsage.STORAGE,
  });

  // ---- 4. Pipelines ---------------------------------------------------------
  // layout:'auto' deduce los bindings a partir de lo que usa cada entry point.
  const computePipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'trace' },
  });
  const renderPipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
  });

  // Bind groups: conectan los buffers reales con los @binding del shader.
  const computeBG = device.createBindGroup({
    layout: computePipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: { buffer: imageBuffer } },
    ],
  });
  const renderBG = device.createBindGroup({
    layout: renderPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 2, resource: { buffer: imageBuffer } },
    ],
  });

  // ---- 5. Interacción: tecla G ----------------------------------------------
  let gravity = 1.0;
  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'g') {
      gravity = gravity === 1.0 ? 0.0 : 1.0;
      document.getElementById('estado').textContent = gravity ? 'ON (espacio curvo)' : 'OFF (luz recta)';
    }
  });

  // ---- 6. Bucle de render ---------------------------------------------------
  const t0 = performance.now();
  function frame() {
    const time = (performance.now() - t0) / 1000;

    // Subir parámetros a la GPU.
    device.queue.writeBuffer(uniformBuffer, 0, new Float32Array([WIDTH, HEIGHT, time, gravity]));

    const encoder = device.createCommandEncoder();

    // Pasada 1: COMPUTE -> un hilo por píxel, grupos de 8x8 hilos.
    const cpass = encoder.beginComputePass();
    cpass.setPipeline(computePipeline);
    cpass.setBindGroup(0, computeBG);
    cpass.dispatchWorkgroups(Math.ceil(WIDTH / 8), Math.ceil(HEIGHT / 8));
    cpass.end();

    // Pasada 2: RENDER -> dibuja un triángulo que muestra el buffer en el canvas.
    const rpass = encoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    rpass.setPipeline(renderPipeline);
    rpass.setBindGroup(0, renderBG);
    rpass.draw(3);
    rpass.end();

    device.queue.submit([encoder.finish()]);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main();