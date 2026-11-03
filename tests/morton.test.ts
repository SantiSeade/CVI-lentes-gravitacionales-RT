// =============================================================================
//  morton.test.ts — Pruebas unitarias de los códigos de Morton 2D y 3D.
// =============================================================================
//  Verifica el criterio de la Fase 3 (sección 9 del enunciado):
//    1. Ida y vuelta exacta de codificar/decodificar en 2D y 3D.
//    2. Orden Z correcto en los primeros casos conocidos (cuadrado 2×2 y cubo 2×2×2).
//    3. Localidad espacial: puntos cercanos en una AABB producen códigos cercanos.
// =============================================================================
import { describe, expect, it } from 'vitest';
import {
  decodeMorton2D,
  decodeMorton3D,
  expandBits,
  morton2D,
  morton3D,
  mortonFromPoint,
} from '../src/accel/morton';

describe('Morton 2D (morton.ts)', () => {
  it('sigue exactamente el orden Z en el bloque 2×2 básico', () => {
    expect(morton2D(0, 0)).toBe(0b00);
    expect(morton2D(1, 0)).toBe(0b01);
    expect(morton2D(0, 1)).toBe(0b10);
    expect(morton2D(1, 1)).toBe(0b11);
  });

  it('codifica y decodifica sin pérdida en todo el rango de 16 bits', () => {
    const samples: [number, number][] = [
      [0, 0],
      [1, 0],
      [0, 1],
      [7, 13],
      [255, 512],
      [1920, 1080],
      [65535, 65535],
    ];
    for (const [x, y] of samples) {
      expect(decodeMorton2D(morton2D(x, y))).toEqual([x, y]);
    }
  });
});

describe('Morton 3D (morton.ts)', () => {
  it('sigue el orden Z 3D en las 8 esquinas del cubo unitario', () => {
    expect(morton3D(0, 0, 0)).toBe(0b000);
    expect(morton3D(1, 0, 0)).toBe(0b001);
    expect(morton3D(0, 1, 0)).toBe(0b010);
    expect(morton3D(1, 1, 0)).toBe(0b011);
    expect(morton3D(0, 0, 1)).toBe(0b100);
    expect(morton3D(1, 0, 1)).toBe(0b101);
    expect(morton3D(0, 1, 1)).toBe(0b110);
    expect(morton3D(1, 1, 1)).toBe(0b111);
    expect(expandBits(0b101)).toBe(0b1000001);
  });

  it('codifica y decodifica sin pérdida en todo el rango de 10 bits (0..1023)', () => {
    const samples: [number, number, number][] = [
      [0, 0, 0],
      [1, 2, 3],
      [42, 511, 900],
      [1023, 0, 1023],
      [1023, 1023, 1023],
    ];
    for (const [x, y, z] of samples) {
      expect(decodeMorton3D(morton3D(x, y, z))).toEqual([x, y, z]);
    }
  });

  it('asigna códigos mucho más cercanos a puntos vecinos que a puntos opuestos de la AABB', () => {
    const bounds = { min: [-10, -10, -10] as [number, number, number], max: [10, 10, 10] as [number, number, number] };
    const a = mortonFromPoint([-9.9, -9.9, -9.9], bounds);
    const b = mortonFromPoint([-9.8, -9.8, -9.8], bounds);
    const far = mortonFromPoint([9.9, 9.9, 9.9], bounds);
    expect(Math.abs(a - b)).toBeLessThan(Math.abs(a - far) / 1000);
  });
});
