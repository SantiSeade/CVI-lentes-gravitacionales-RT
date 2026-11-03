// =============================================================================
//  camera.ts — Cámara orbital en coordenadas esféricas (acimut, elevación, radio).
// =============================================================================
//  ¿Por qué una cámara orbital?
//    Para estudiar una lente gravitacional lo más natural es "dar la vuelta" al
//    agujero negro manteniendo la mirada en él (o en un planeta) y acercarse o
//    alejarse con la rueda del ratón. En coordenadas esféricas alrededor de
//    `target`:
//
//      pos = target + distance · (cos(elev)·sin(azim), sin(elev), -cos(elev)·cos(azim))
//
//    A partir de `pos` y `target` construimos la base ortonormal (fwd, right, up)
//    en CPU una sola vez por fotograma y la subimos en `FrameUniforms`. Así cada
//    hilo de la GPU genera su rayo inicial con dos sumas y una normalización.
//
//  Estructura del proyecto: capa de escena (ver docs/ARQUITECTURA.md).
// =============================================================================
import { vec3 } from 'gl-matrix';
import type { Vec3 } from '../geometry/mesh';

export interface CameraBasis {
  position: Vec3;
  forward: Vec3;
  right: Vec3;
  up: Vec3;
  tanHalfFov: number;
}

export class OrbitCamera {
  /** Punto al que mira la cámara (por defecto el agujero negro principal en el origen). */
  target: Vec3 = [0, 0, 0];
  /** Ángulo horizontal en radianes (0 = mirando desde -Z hacia +Z). */
  azimuth = 0.25;
  /** Ángulo vertical en radianes, limitado a (-π/2 + ε, π/2 - ε) para no volcar. */
  elevation = 0.22;
  /** Distancia al punto `target` (en unidades de rs). */
  distance = 85;
  /** Campo de visión vertical en radianes. */
  fovY = (50 * Math.PI) / 180;

  readonly minDistance = 3.0;
  readonly maxDistance = 900.0;

  /** Gira la cámara según un desplazamiento de ratón (en radianes). */
  orbit(deltaAzimuth: number, deltaElevation: number): void {
    this.azimuth += deltaAzimuth;
    const limit = Math.PI / 2 - 0.02;
    this.elevation = Math.max(-limit, Math.min(limit, this.elevation + deltaElevation));
  }

  /** Acerca o aleja multiplicando la distancia (zoom logarítmico suave). */
  zoom(factor: number): void {
    this.distance = Math.max(this.minDistance, Math.min(this.maxDistance, this.distance * factor));
  }

  /** Calcula la posición y los tres ejes ortonormales de la cámara. */
  computeBasis(): CameraBasis {
    const ce = Math.cos(this.elevation);
    const se = Math.sin(this.elevation);
    const ca = Math.cos(this.azimuth);
    const sa = Math.sin(this.azimuth);

    const pos = vec3.fromValues(
      this.target[0] + this.distance * ce * sa,
      this.target[1] + this.distance * se,
      this.target[2] - this.distance * ce * ca,
    );
    const tgt = vec3.fromValues(this.target[0], this.target[1], this.target[2]);
    const fwd = vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), tgt, pos));
    const worldUp = vec3.fromValues(0, 1, 0);
    const right = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), worldUp, fwd));
    const up = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), fwd, right));

    return {
      position: [pos[0], pos[1], pos[2]],
      forward: [fwd[0], fwd[1], fwd[2]],
      right: [right[0], right[1], right[2]],
      up: [up[0], up[1], up[2]],
      tanHalfFov: Math.tan(this.fovY * 0.5),
    };
  }
}

