// =============================================================================
//  controls.ts — Controles de cámara orbital, botones, sliders y atajos de teclado.
// =============================================================================
//  Implementa todos los controles requeridos mediante botones interactivos y
//  sliders en el panel derecho (y mantiene los atajos de teclado sincronizados):
//
//    Control UI / Tecla    Acción
//    --------------------------------------------------------------------------
//    Arrastrar ratón       Orbitar la cámara alrededor del agujero negro
//    Rueda del ratón       Acercar / alejar la cámara
//    Botón Gravedad (G)    Gravedad ON / OFF (luz curva vs luz recta)
//    Botón Tiempo (Esp.)   Pausar / reanudar el tiempo de la escena
//    Botón 2.º BH (2)      Activar / desactivar el 2.º agujero negro en órbita
//    Botón Fondo (F)       Mostrar / ocultar rejilla y estrellas de fondo
//    Botón Sol (S)         Poner / quitar el Sol (estrella emisiva)
//    Pestañas R / G / B    Seleccionar una de las 3 fuentes spotlight (RGB)
//      └─ Estado (L)       Encender / apagar la fuente seleccionada
//      └─ Emisión          Alternar entre Cono y Rayos paralelos
//      └─ Cantidad de luz  Intensidad emitida por esa fuente (0.0 .. 4.0)
//      └─ Ángulo del cono  Apertura del cono (5° .. 65°)
//      └─ Ángulo plano     Elevación respecto al plano XZ (-85° .. 85°)
//      └─ Rotación BH      Ángulo alrededor del agujero negro (0° .. 360°)
//    Botones Vista (H)     Normal / Mapa de calor RK4 / Mapa de calor BVH
//    Slider Factor K       Ajustar factor K del paso adaptativo (0.015 .. 0.250)
//    Slider Máx. pasos     Ajustar MAX_STEPS del integrador (100 .. 900)
// =============================================================================
import type { Vec3 } from '../geometry/mesh';
import { VIEW_HEAT_BVH, VIEW_HEAT_STEPS, VIEW_NORMAL } from '../gpu/layouts';
import type { OrbitCamera } from '../scene/camera';

export interface SpotlightChannelState {
  readonly label: string;
  readonly color: Vec3;
  enabled: boolean;
  parallel: boolean;
  intensity: number;
  angleDeg: number;
  elevationDeg: number;
  azimuthDeg: number;
}

export interface SimulationState {
  gravityEnabled: boolean;
  paused: boolean;
  bvhEnabled: boolean;
  mortonEnabled: boolean;
  backgroundEnabled: boolean;
  starEnabled: boolean;
  secondaryBlackHoleEnabled: boolean;
  activeSpotlightIndex: number;
  spotlights: [SpotlightChannelState, SpotlightChannelState, SpotlightChannelState];
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
    backgroundEnabled: true,
    starEnabled: true,
    secondaryBlackHoleEnabled: false,
    activeSpotlightIndex: 0,
    spotlights: [
      {
        label: 'R',
        color: [1.0, 0.0, 0.0],
        enabled: false,
        parallel: false,
        intensity: 1.8,
        angleDeg: 28,
        elevationDeg: 31,
        azimuthDeg: 21,
      },
      {
        label: 'G',
        color: [0.0, 1.0, 0.0],
        enabled: false,
        parallel: false,
        intensity: 1.8,
        angleDeg: 28,
        elevationDeg: 31,
        azimuthDeg: 141,
      },
      {
        label: 'B',
        color: [0.0, 0.0, 1.0],
        enabled: false,
        parallel: false,
        intensity: 1.8,
        angleDeg: 28,
        elevationDeg: 31,
        azimuthDeg: 261,
      },
    ],
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
  onToggleStar?: (enabled: boolean) => void,
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

    <div class="ctrl-row">
      <span class="ctrl-label">Fondo estelar</span>
      <button id="btn-bg" class="ctrl-btn" type="button"></button>
    </div>

    <div class="ctrl-row">
      <span class="ctrl-label">Sol (estrella)</span>
      <button id="btn-star" class="ctrl-btn" type="button"></button>
    </div>

    <div class="ctrl-slider-block">
      <div class="ctrl-slider-head">
        <span class="ctrl-label">Fuentes Spotlight (RGB)</span>
      </div>
      <div class="ctrl-seg">
        <button id="btn-spot-tab-0" type="button"></button>
        <button id="btn-spot-tab-1" type="button"></button>
        <button id="btn-spot-tab-2" type="button"></button>
      </div>
      <div class="ctrl-row">
        <span id="lbl-spot-state" class="ctrl-label">Fuente</span>
        <button id="btn-spot" class="ctrl-btn" type="button"></button>
      </div>
      <div class="ctrl-row">
        <span class="ctrl-label">Emisión</span>
        <button id="btn-spot-mode" class="ctrl-btn" type="button"></button>
      </div>
      <div class="ctrl-slider-head" style="margin-top:4px;">
        <span class="ctrl-label">Cantidad de luz</span>
        <span id="val-spot-int" class="ctrl-slider-val"></span>
      </div>
      <input id="slider-spot-int" class="ctrl-slider" type="range" min="0" max="4" step="0.1" />
      <div id="spot-angle-wrap" class="ctrl-slider-head" style="margin-top:4px;">
        <span class="ctrl-label">Ángulo del cono</span>
        <span id="val-spot-angle" class="ctrl-slider-val"></span>
      </div>
      <input id="slider-spot-angle" class="ctrl-slider" type="range" min="5" max="65" step="1" />
      <div class="ctrl-slider-head" style="margin-top:4px;">
        <span class="ctrl-label">Ángulo sobre el plano</span>
        <span id="val-spot-elev" class="ctrl-slider-val"></span>
      </div>
      <input id="slider-spot-elev" class="ctrl-slider" type="range" min="-85" max="85" step="1" />
      <div class="ctrl-slider-head" style="margin-top:4px;">
        <span class="ctrl-label">Rotación alrededor del BH</span>
        <span id="val-spot-azim" class="ctrl-slider-val"></span>
      </div>
      <input id="slider-spot-azim" class="ctrl-slider" type="range" min="0" max="360" step="1" />
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
  const btnBg = panelEl.querySelector('#btn-bg') as HTMLButtonElement;
  const btnStar = panelEl.querySelector('#btn-star') as HTMLButtonElement;

  const spotTabs = [
    panelEl.querySelector('#btn-spot-tab-0') as HTMLButtonElement,
    panelEl.querySelector('#btn-spot-tab-1') as HTMLButtonElement,
    panelEl.querySelector('#btn-spot-tab-2') as HTMLButtonElement,
  ];
  const lblSpotState = panelEl.querySelector('#lbl-spot-state') as HTMLElement;
  const btnSpot = panelEl.querySelector('#btn-spot') as HTMLButtonElement;
  const btnSpotMode = panelEl.querySelector('#btn-spot-mode') as HTMLButtonElement;
  const sliderSpotInt = panelEl.querySelector('#slider-spot-int') as HTMLInputElement;
  const valSpotInt = panelEl.querySelector('#val-spot-int') as HTMLElement;
  const sliderSpotAngle = panelEl.querySelector('#slider-spot-angle') as HTMLInputElement;
  const valSpotAngle = panelEl.querySelector('#val-spot-angle') as HTMLElement;
  const spotAngleWrap = panelEl.querySelector('#spot-angle-wrap') as HTMLElement;
  const sliderSpotElev = panelEl.querySelector('#slider-spot-elev') as HTMLInputElement;
  const valSpotElev = panelEl.querySelector('#val-spot-elev') as HTMLElement;
  const sliderSpotAzim = panelEl.querySelector('#slider-spot-azim') as HTMLInputElement;
  const valSpotAzim = panelEl.querySelector('#val-spot-azim') as HTMLElement;

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

  const activeSpot = (): SpotlightChannelState => state.spotlights[state.activeSpotlightIndex];

  const renderPanel = (): void => {
    setToggleStyle(btnGravity, state.gravityEnabled, 'ON (espacio curvo)', 'OFF (luz recta)');
    setToggleStyle(btnPause, !state.paused, 'Corriendo', 'Pausado');
    setToggleStyle(btnBh2, state.secondaryBlackHoleEnabled, 'ON (activo)', 'OFF (inactivo)');
    setToggleStyle(btnBg, state.backgroundEnabled, 'ON (rejilla/estrellas)', 'OFF (negro)');
    setToggleStyle(btnStar, state.starEnabled, 'ON (activo)', 'OFF (quitado)');

    const tabColors = ['#ff5c5c', '#5cff7a', '#5ca8ff'];
    spotTabs.forEach((tab, idx) => {
      const ch = state.spotlights[idx];
      tab.classList.toggle('selected', state.activeSpotlightIndex === idx);
      tab.innerHTML = `<span style="color:${tabColors[idx]}">●</span> ${ch.label} ${ch.enabled ? 'ON' : 'OFF'}`;
    });

    const sp = activeSpot();
    lblSpotState.textContent = `Fuente ${sp.label}`;
    setToggleStyle(btnSpot, sp.enabled, 'ON (activo)', 'OFF (apagado)');

    btnSpotMode.textContent = sp.parallel ? 'Rayos paralelos' : 'Cono';
    btnSpotMode.classList.remove('active', 'inactive');

    sliderSpotInt.value = String(sp.intensity);
    valSpotInt.textContent = sp.intensity.toFixed(1);

    sliderSpotAngle.value = String(sp.angleDeg);
    sliderSpotAngle.disabled = sp.parallel;
    spotAngleWrap.style.opacity = sp.parallel ? '0.45' : '1';
    valSpotAngle.textContent = sp.parallel ? 'N/A' : `${sp.angleDeg}°`;

    sliderSpotElev.value = String(sp.elevationDeg);
    valSpotElev.textContent = `${sp.elevationDeg}°`;

    sliderSpotAzim.value = String(sp.azimuthDeg);
    valSpotAzim.textContent = `${sp.azimuthDeg}°`;

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

  btnBg.addEventListener('click', () => {
    state.backgroundEnabled = !state.backgroundEnabled;
    renderPanel();
  });

  btnStar.addEventListener('click', () => {
    state.starEnabled = !state.starEnabled;
    onToggleStar?.(state.starEnabled);
    renderPanel();
  });

  spotTabs.forEach((tab, idx) => {
    tab.addEventListener('click', () => {
      state.activeSpotlightIndex = idx;
      renderPanel();
    });
  });

  btnSpot.addEventListener('click', () => {
    const sp = activeSpot();
    sp.enabled = !sp.enabled;
    renderPanel();
  });

  btnSpotMode.addEventListener('click', () => {
    const sp = activeSpot();
    sp.parallel = !sp.parallel;
    renderPanel();
  });

  sliderSpotInt.addEventListener('input', () => {
    const sp = activeSpot();
    sp.intensity = parseFloat(sliderSpotInt.value);
    valSpotInt.textContent = sp.intensity.toFixed(1);
  });

  sliderSpotAngle.addEventListener('input', () => {
    const sp = activeSpot();
    sp.angleDeg = parseInt(sliderSpotAngle.value, 10);
    valSpotAngle.textContent = `${sp.angleDeg}°`;
  });

  sliderSpotElev.addEventListener('input', () => {
    const sp = activeSpot();
    sp.elevationDeg = parseInt(sliderSpotElev.value, 10);
    valSpotElev.textContent = `${sp.elevationDeg}°`;
  });

  sliderSpotAzim.addEventListener('input', () => {
    const sp = activeSpot();
    sp.azimuthDeg = parseInt(sliderSpotAzim.value, 10);
    valSpotAzim.textContent = `${sp.azimuthDeg}°`;
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
    } else if (key === 'f') {
      state.backgroundEnabled = !state.backgroundEnabled;
    } else if (key === 's') {
      state.starEnabled = !state.starEnabled;
      onToggleStar?.(state.starEnabled);
    } else if (key === 'l') {
      const sp = activeSpot();
      sp.enabled = !sp.enabled;
    } else {
      return;
    }
    renderPanel();
  });

  renderPanel();
  return { renderPanel };
}
