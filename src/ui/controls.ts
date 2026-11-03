// =============================================================================
//  controls.ts — Controles de cámara orbital, botones, sliders y atajos de teclado.
// =============================================================================
//  Implementa todos los controles requeridos en la sección 10 mediante botones
//  interactivos y sliders en el panel derecho (y mantiene también los atajos de
//  teclado sincronizados con la UI):
//
//    Control UI / Tecla    Acción
//    --------------------------------------------------------------------------
//    Arrastrar ratón       Orbitar la cámara alrededor del agujero negro
//    Rueda del ratón       Acercar / alejar la cámara
//    Botón Gravedad (G)    Gravedad ON / OFF (luz curva vs luz recta)
//    Botón Tiempo (Esp.)   Pausar / reanudar el tiempo de la escena
//    Botón Aceleración (B) BVH ON (TLAS+BLAS) / Fuerza bruta
//    Botón Morton (M)      Disposición Morton 2D ON / OFF para la imagen
//    Botones Vista (H)     Normal / Mapa de calor RK4 / Mapa de calor BVH
//    Botón 2.º BH (2)      Activar / desactivar el 2.º agujero negro en órbita
//    Slider Factor K       Ajustar factor K del paso adaptativo (0.015 .. 0.250)
//    Slider Máx. pasos     Ajustar MAX_STEPS del integrador (100 .. 900)
// =============================================================================
import { VIEW_HEAT_BVH, VIEW_HEAT_STEPS, VIEW_NORMAL } from '../gpu/layouts';
import type { OrbitCamera } from '../scene/camera';

export interface SimulationState {
  gravityEnabled: boolean;
  paused: boolean;
  bvhEnabled: boolean;
  mortonEnabled: boolean;
  secondaryBlackHoleEnabled: boolean;
  viewMode: number;
  /** Factor `K` del paso adaptativo `dt = clamp(K*(d - rs) + dt_min, ...)`. */
  stepK: number;
  dtMin: number;
  dtMaxRel: number;
  dtMaxAbs: number;
  maxSteps: number;
}

export function createDefaultSimState(): SimulationState {
  return {
    gravityEnabled: true,
    paused: false,
    bvhEnabled: true,
    mortonEnabled: true,
    secondaryBlackHoleEnabled: false,
    viewMode: VIEW_NORMAL,
    stepK: 0.08,
    dtMin: 0.015,
    dtMaxRel: 0.16,
    dtMaxAbs: 5.0,
    maxSteps: 450,
  };
}

export function viewModeLabel(mode: number): string {
  switch (mode) {
    case VIEW_HEAT_STEPS:
      return 'Calor: pasos RK4';
    case VIEW_HEAT_BVH:
      return 'Calor: nodos BVH';
    default:
      return 'Normal (color)';
  }
}

export function attachControls(
  canvas: HTMLCanvasElement,
  panelEl: HTMLElement,
  camera: OrbitCamera,
  state: SimulationState,
  onToggleSecondaryBh?: (enabled: boolean) => void,
): { renderPanel: () => void } {
  // ---- 1. Ratón en el canvas: arrastrar para orbitar y rueda para zoom ------
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.classList.add('dragging');
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    camera.orbit(-dx * 0.0055, dy * 0.0055);
  });

  const stopDrag = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    canvas.classList.remove('dragging');
    if (canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
  };
  canvas.addEventListener('pointerup', stopDrag);
  canvas.addEventListener('pointercancel', stopDrag);

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const factor = Math.exp(e.deltaY * 0.0012);
      camera.zoom(factor);
    },
    { passive: false },
  );

  // ---- 2. Construcción de botones y sliders en el panel ---------------------
  panelEl.innerHTML = `
    <h3>Controles y depuración</h3>
    <div class="ctrl-hint">Cámara: arrastrar ratón para orbitar · rueda para zoom</div>

    <div class="ctrl-row">
      <span class="ctrl-label">Gravedad</span>
      <button id="btn-gravity" class="ctrl-btn" type="button"></button>
    </div>

    <div class="ctrl-row">
      <span class="ctrl-label">Tiempo escena</span>
      <button id="btn-pause" class="ctrl-btn" type="button"></button>
    </div>

    <div class="ctrl-row">
      <span class="ctrl-label">2.º Agujero negro</span>
      <button id="btn-bh2" class="ctrl-btn" type="button"></button>
    </div>

    <div class="ctrl-slider-block">
      <div class="ctrl-slider-head">
        <span class="ctrl-label">Modo de vista</span>
      </div>
      <div class="ctrl-seg">
        <button id="btn-view-0" type="button">Normal</button>
        <button id="btn-view-1" type="button">Calor RK4</button>
        <button id="btn-view-2" type="button">Calor BVH</button>
      </div>
    </div>

    <div class="ctrl-slider-block">
      <div class="ctrl-slider-head">
        <span class="ctrl-label">Factor K (paso adaptativo)</span>
        <span id="val-step-k" class="ctrl-slider-val"></span>
      </div>
      <input id="slider-step-k" class="ctrl-slider" type="range" min="0.015" max="0.25" step="0.005" />
    </div>

    <div class="ctrl-slider-block">
      <div class="ctrl-slider-head">
        <span class="ctrl-label">Máx. pasos RK4</span>
        <span id="val-max-steps" class="ctrl-slider-val"></span>
      </div>
      <input id="slider-max-steps" class="ctrl-slider" type="range" min="100" max="900" step="25" />
    </div>
  `;

  const btnGravity = panelEl.querySelector('#btn-gravity') as HTMLButtonElement;
  const btnPause = panelEl.querySelector('#btn-pause') as HTMLButtonElement;
  const btnBh2 = panelEl.querySelector('#btn-bh2') as HTMLButtonElement;
  const viewButtons = [
    panelEl.querySelector('#btn-view-0') as HTMLButtonElement,
    panelEl.querySelector('#btn-view-1') as HTMLButtonElement,
    panelEl.querySelector('#btn-view-2') as HTMLButtonElement,
  ];
  const sliderStepK = panelEl.querySelector('#slider-step-k') as HTMLInputElement;
  const valStepK = panelEl.querySelector('#val-step-k') as HTMLElement;
  const sliderMaxSteps = panelEl.querySelector('#slider-max-steps') as HTMLInputElement;
  const valMaxSteps = panelEl.querySelector('#val-max-steps') as HTMLElement;

  const setToggleStyle = (btn: HTMLButtonElement, active: boolean, textOn: string, textOff: string): void => {
    btn.textContent = active ? textOn : textOff;
    btn.classList.toggle('active', active);
    btn.classList.toggle('inactive', !active);
  };

  const renderPanel = (): void => {
    setToggleStyle(btnGravity, state.gravityEnabled, 'ON (espacio curvo)', 'OFF (luz recta)');
    setToggleStyle(btnPause, !state.paused, 'Corriendo', 'Pausado');
    setToggleStyle(btnBh2, state.secondaryBlackHoleEnabled, 'ON (activo)', 'OFF (inactivo)');

    viewButtons.forEach((b, idx) => {
      b.classList.toggle('selected', state.viewMode === idx);
    });

    sliderStepK.value = String(state.stepK);
    valStepK.textContent = state.stepK.toFixed(3);

    sliderMaxSteps.value = String(state.maxSteps);
    valMaxSteps.textContent = String(state.maxSteps);
  };

  // ---- 3. Eventos de clic en botones y cambio en sliders --------------------
  btnGravity.addEventListener('click', () => {
    state.gravityEnabled = !state.gravityEnabled;
    renderPanel();
  });

  btnPause.addEventListener('click', () => {
    state.paused = !state.paused;
    renderPanel();
  });

  btnBh2.addEventListener('click', () => {
    state.secondaryBlackHoleEnabled = !state.secondaryBlackHoleEnabled;
    onToggleSecondaryBh?.(state.secondaryBlackHoleEnabled);
    renderPanel();
  });

  viewButtons.forEach((b, idx) => {
    b.addEventListener('click', () => {
      state.viewMode = idx;
      renderPanel();
    });
  });

  sliderStepK.addEventListener('input', () => {
    state.stepK = parseFloat(sliderStepK.value);
    valStepK.textContent = state.stepK.toFixed(3);
  });

  sliderMaxSteps.addEventListener('input', () => {
    state.maxSteps = parseInt(sliderMaxSteps.value, 10);
    valMaxSteps.textContent = String(state.maxSteps);
  });

  // ---- 4. Atajos de teclado sincronizados con los botones y sliders ---------
  window.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    if (key === 'g') {
      state.gravityEnabled = !state.gravityEnabled;
    } else if (e.code === 'Space') {
      e.preventDefault();
      state.paused = !state.paused;
    } else if (key === 'b') {
      state.bvhEnabled = !state.bvhEnabled;
    } else if (key === 'm') {
      state.mortonEnabled = !state.mortonEnabled;
    } else if (key === 'h') {
      state.viewMode = (state.viewMode + 1) % 3;
    } else if (e.key === '[') {
      state.stepK = Math.max(0.015, +(state.stepK - 0.005).toFixed(3));
    } else if (e.key === ']') {
      state.stepK = Math.min(0.25, +(state.stepK + 0.005).toFixed(3));
    } else if (e.key === '2') {
      state.secondaryBlackHoleEnabled = !state.secondaryBlackHoleEnabled;
      onToggleSecondaryBh?.(state.secondaryBlackHoleEnabled);
    } else {
      return;
    }
    renderPanel();
  });

  renderPanel();
  return { renderPanel };
}
