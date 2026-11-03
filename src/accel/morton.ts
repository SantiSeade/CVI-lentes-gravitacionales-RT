// =============================================================================
//  morton.ts — Curva de orden Z (código de Morton) en 2D y 3D.
// =============================================================================
//  ¿Qué es el código de Morton y por qué lo usamos en DOS sitios distintos?
//    Una memoria de computador es 1D (una fila de celdas), pero nuestros datos
//    viven en 2D (píxeles de la imagen) o en 3D (triángulos en el espacio).
//    Si guardamos una imagen fila por fila, dos píxeles vecinos en vertical
//    quedan separados por `ancho` posiciones en memoria.
//
//    El código de Morton INTERCALA los bits de las coordenadas:
//      - En 2D, dados x = x₂x₁x₀ e y = y₂y₁y₀, el código es y₂x₂y₁x₁y₀x₀.
//        Al recorrer los códigos 0, 1, 2, 3, ... se dibuja una letra "Z" a
//        todas las escalas: puntos cercanos en 2D tienen códigos cercanos.
//      - En 3D se intercalan 10 bits de x, 10 de y y 10 de z → un entero sin
//        signo de 30 bits: z₉y₉x₉ ... z₀y₀x₀.
//
//    Los dos usos en el proyecto (sección 4.3):
//      1. Construcción del BVH (3D): ordenamos los triángulos por el código de
//         Morton de su centroide antes de partir el árbol (estilo LBVH). Así
//         los triángulos cercanos en el espacio quedan contiguos en memoria.
//      2. Disposición de la imagen (2D): con la bandera Morton activa (`M`),
//         los hilos del compute shader y las celdas del buffer de imagen se
//         indexan en orden Z de bloques 8×8, de modo que rayos vecinos viajen
//         juntos en el mismo workgroup y escriban en posiciones cercanas.
//
//  Truco de bits ("magic bits"):
//    En vez de un bucle bit a bit, `expandBits2D` abre huecos entre los 16 bits
//    de un número en 4 pasos con máscaras constantes; `expandBits3D` abre dos
//    huecos entre cada uno de 10 bits en 5 pasos. Es O(1) y se replica tal cual
//    en WGSL (common.wgsl).
// =============================================================================
import type { Aabb, Vec3 } from '../geometry/mesh';

// -----------------------------------------------------------------------------
//  2D: 16 bits por eje → código de 32 bits sin signo
// -----------------------------------------------------------------------------

/**
 * Abre un bit de hueco entre cada bit de un entero de 16 bits:
 *   b₁₅ b₁₄ ... b₁ b₀  →  0 b₁₅ 0 b₁₄ ... 0 b₁ 0 b₀
 */
export function expandBits2D(v: number): number {
  let x = v & 0xffff;
  x = (x | (x << 8)) & 0x00ff00ff;
  x = (x | (x << 4)) & 0x0f0f0f0f;
  x = (x | (x << 2)) & 0x33333333;
  x = (x | (x << 1)) & 0x55555555;
  return x >>> 0;
}

/** Operación inversa de `expandBits2D`: compacta los bits pares a los 16 bits bajos. */
export function compactBits2D(v: number): number {
  let x = v & 0x55555555;
  x = (x | (x >>> 1)) & 0x33333333;
  x = (x | (x >>> 2)) & 0x0f0f0f0f;
  x = (x | (x >>> 4)) & 0x00ff00ff;
  x = (x | (x >>> 8)) & 0x0000ffff;
  return x >>> 0;
}

/** Codifica (x, y) ∈ [0, 65535]² en un código de Morton 2D de 32 bits (x en bits pares, y en impares). */
export function morton2D(x: number, y: number): number {
  return ((expandBits2D(x) | (expandBits2D(y) << 1)) >>> 0);
}

/** Decodifica un código de Morton 2D en el par [x, y]. */
export function decodeMorton2D(code: number): [number, number] {
  return [compactBits2D(code), compactBits2D(code >>> 1)];
}

// -----------------------------------------------------------------------------
//  3D: 10 bits por eje (0..1023) → código de 30 bits sin signo
// -----------------------------------------------------------------------------

/**
 * Abre DOS bits de hueco entre cada uno de los 10 bits bajos de `v`:
 *   b₉ ... b₁ b₀  →  00b₉ ... 00b₁ 00b₀
 */
export function expandBits3D(v: number): number {
  let x = v & 0x000003ff; // 10 bits (0..1023)
  x = (x | (x << 16)) & 0x030000ff;
  x = (x | (x << 8)) & 0x0300f00f;
  x = (x | (x << 4)) & 0x030c30c3;
  x = (x | (x << 2)) & 0x09249249;
  return x >>> 0;
}

/** Alias pedido en la sección 4.3 (`expandBits` abre huecos para Morton 3D). */
export const expandBits = expandBits3D;

/** Operación inversa de `expandBits3D`: recupera los 10 bits originales. */
export function compactBits3D(v: number): number {
  let x = v & 0x09249249;
  x = (x | (x >>> 2)) & 0x030c30c3;
  x = (x | (x >>> 4)) & 0x0300f00f;
  x = (x | (x >>> 8)) & 0x030000ff;
  x = (x | (x >>> 16)) & 0x000003ff;
  return x >>> 0;
}

/** Codifica (x, y, z) ∈ [0, 1023]³ en un código de Morton 3D de 30 bits. */
export function morton3D(x: number, y: number, z: number): number {
  return ((expandBits3D(x) | (expandBits3D(y) << 1) | (expandBits3D(z) << 2)) >>> 0);
}

/** Decodifica un código de Morton 3D de 30 bits en [x, y, z]. */
export function decodeMorton3D(code: number): Vec3 {
  return [compactBits3D(code), compactBits3D(code >>> 1), compactBits3D(code >>> 2)];
}

/**
 * Convierte un punto 3D real dentro de una AABB `bounds` en su código de Morton
 * de 30 bits (cuantizando cada coordenada a [0, 1023]).
 */
export function mortonFromPoint(p: Vec3, bounds: Aabb): number {
  const quantize = (val: number, min: number, max: number): number => {
    const span = max - min;
    if (span <= 1e-12) return 0;
    const t = Math.max(0, Math.min(1, (val - min) / span));
    return Math.min(1023, Math.floor(t * 1024));
  };
  const qx = quantize(p[0], bounds.min[0], bounds.max[0]);
  const qy = quantize(p[1], bounds.min[1], bounds.max[1]);
  const qz = quantize(p[2], bounds.min[2], bounds.max[2]);
  return morton3D(qx, qy, qz);
}

