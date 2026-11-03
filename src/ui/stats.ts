// =============================================================================
//  stats.ts — Medición de FPS, ms/fotograma y contadores de estructuras de datos.
// =============================================================================
//  Muestra en tiempo real (sección 10):
//    - FPS y milisegundos por fotograma (media móvil exponencial suave).
//    - Resolución interna del trazador de rayos.
//    - Instancias activas, mallas únicas en GPU (instanciación) y triángulos
//      totales en la escena.
//    - Nodos del BLAS (estático) y del TLAS (reconstruido cada fotograma).
//    - Estado resumido de las banderas (Gravedad, BVH, Morton, Vista).
// =============================================================================
import { type SimulationState, viewModeLabel } from './controls';

export interface FrameCounters {
  imageWidth: number;
  imageHeight: number;
  uniqueMeshes: number;
  trianglesPerMesh: number;
  instanceCount: number;
  totalTrianglesInScene: number;
  blasNodeCount: number;
  tlasNodeCount: number;
  blackHoleCount: number;
}

export class StatsOverlay {
  private lastFrameTime = performance.now();
  private smoothedFrameMs = 16.7;
  private lastDomUpdate = 0;

  constructor(private readonly container: HTMLElement) {}

  update(now: number, counters: FrameCounters, state: SimulationState): void {
    const dtMs = Math.max(0.1, now - this.lastFrameTime);
    this.lastFrameTime = now;
    this.smoothedFrameMs = this.smoothedFrameMs * 0.9 + dtMs * 0.1;

    // Actualizar el DOM ~6 veces por segundo para no ensuciar el perfilado.
    if (now - this.lastDomUpdate < 160) return;
    this.lastDomUpdate = now;

    const fps = 1000 / Math.max(0.1, this.smoothedFrameMs);
    const totalBvhNodes = counters.blasNodeCount + counters.tlasNodeCount;

    this.container.innerHTML = `
      <h3>Estadísticas en tiempo real</h3>
      <table>
        <tr><td>Rendimiento</td><td><b>${fps.toFixed(1)} FPS</b> (${this.smoothedFrameMs.toFixed(2)} ms/frame)</td></tr>
        <tr><td>Resolución rayos</td><td>${counters.imageWidth} × ${counters.imageHeight} px</td></tr>
        <tr><td>Instancias / Mallas GPU</td><td>${counters.instanceCount} inst. → <b>${counters.uniqueMeshes} malla</b></td></tr>
        <tr><td>Triángulos (malla / escena)</td><td>${counters.trianglesPerMesh.toLocaleString('es-CO')} / ${counters.totalTrianglesInScene.toLocaleString('es-CO')}</td></tr>
        <tr><td>Nodos BVH (TLAS + BLAS)</td><td>${counters.tlasNodeCount} + ${counters.blasNodeCount} = <b>${totalBvhNodes}</b></td></tr>
        <tr><td>Agujeros negros activos</td><td>${counters.blackHoleCount} (MAX_STEPS=${state.maxSteps})</td></tr>
        <tr><td>Estado</td><td>G:${state.gravityEnabled ? 'ON' : 'OFF'} · BVH:${state.bvhEnabled ? 'ON' : 'OFF'} · Morton:${state.mortonEnabled ? 'ON' : 'OFF'}</td></tr>
        <tr><td>Vista activa</td><td>${viewModeLabel(state.viewMode)}</td></tr>
      </table>
    `;
  }
}

