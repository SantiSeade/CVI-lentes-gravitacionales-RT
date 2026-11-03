// =============================================================================
//  bvhBuilder.ts — Construcción del BVH de dos niveles (BLAS y TLAS) con Morton.
// =============================================================================
//  ¿Qué problema resuelve un BVH (Bounding Volume Hierarchy)?
//    Para saber si un micro-segmento choca con una malla de 5 120 triángulos,
//    la fuerza bruta prueba los 5 120 triángulos. El BVH envuelve grupos de
//    triángulos cercanos en cajas (AABB) formando un árbol binario: si el
//    segmento NO toca la caja de un subárbol, descartamos de golpe todos sus
//    triángulos sin probarlos uno por uno. El coste pasa de O(N) a O(log N).
//
//  ¿Por qué DOS niveles (TLAS + BLAS)?
//    - BLAS (Bottom-Level Acceleration Structure): un árbol por cada `Mesh`, en
//      el espacio LOCAL de esa malla. Se construye UNA SOLA VEZ al arrancar y
//      todos los planetas que comparten la icosfera comparten también su BLAS.
//    - TLAS (Top-Level Acceleration Structure): un árbol pequeño cuyas "hojas"
//      son las AABB de MUNDO de las instancias. Como los planetas orbitan, el
//      TLAS se reconstruye cada fotograma en CPU (cuesta microsegundos porque
//      hay ~10 instancias, frente a miles de triángulos del BLAS).
//
//  ¿Cómo se construye con códigos de Morton (estilo LBVH / Karras)?
//    1. Calculamos el centroide de cada primitiva (triángulo o instancia) y el
//       AABB que envuelve a todos los centroides.
//    2. Convertimos cada centroide en su código de Morton 3D de 30 bits y
//       ORDENAMOS las primitivas por ese código. Ahora las primitivas cercanas
//       en 3D están contiguas en el arreglo.
//    3. Partimos recursivamente cada rango `[first, last)`: buscamos el bit más
//       alto en el que difieren los códigos del primero y del último del rango
//       y cortamos donde ese bit cambia de 0 a 1 (búsqueda binaria). Si todos
//       tienen el mismo código de Morton, cortamos por la mitad.
//    4. Cada nodo guarda la unión de las AABB de sus dos hijos.
// =============================================================================
import { emptyAabb, growAabbPoint, type Aabb, type Mesh, type Vec3 } from '../geometry/mesh';
import { mortonFromPoint } from './morton';

export interface BvhTreeNode {
  bounds: Aabb;
  /** Hijo izquierdo (null si es hoja). */
  left: BvhTreeNode | null;
  /** Hijo derecho (null si es hoja). */
  right: BvhTreeNode | null;
  /** Índice de la primera primitiva en el arreglo ya reordenado por Morton. */
  first: number;
  /** Cantidad de primitivas (> 0 si es hoja, 0 si es nodo interno). */
  count: number;
}

export interface BuiltBvh {
  root: BvhTreeNode;
  /**
   * Permutación aplicada a las primitivas: la primitiva en la posición `k` del
   * árbol corresponde a la primitiva original `order[k]`.
   */
  order: Uint32Array;
  nodeCount: number;
}

/** Calcula la unión de dos AABB. */
function unionAabb(a: Aabb, b: Aabb): Aabb {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

/**
 * Encuentra dónde partir el rango `[first, last]` (ambos inclusive) según el
 * bit más significativo en que difieren `codes[first]` y `codes[last]`.
 */
function findMortonSplit(codes: Uint32Array, first: number, last: number): number {
  const firstCode = codes[first];
  const lastCode = codes[last];
  if (firstCode === lastCode) {
    return (first + last) >> 1;
  }
  const diff = firstCode ^ lastCode;
  const highestBit = 1 << (31 - Math.clz32(diff));

  // Búsqueda binaria del último índice cuyo bit `highestBit` sigue siendo 0.
  let lo = first;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((codes[mid] & highestBit) === 0) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Constructor genérico de BVH a partir de un arreglo plano de AABBs
 * (`primBounds` = 6 floats `[minX,minY,minZ,maxX,maxY,maxZ]` por primitiva).
 */
export function buildBvhFromBounds(primBounds: Float32Array, maxLeafSize = 4): BuiltBvh {
  const count = primBounds.length / 6;
  if (count === 0) {
    return {
      root: { bounds: { min: [0, 0, 0], max: [0, 0, 0] }, left: null, right: null, first: 0, count: 0 },
      order: new Uint32Array(0),
      nodeCount: 1,
    };
  }

  // 1. Centroides y AABB que encierra todos los centroides.
  const centroids = new Float32Array(count * 3);
  const centroidBounds = emptyAabb();
  for (let i = 0; i < count; i++) {
    const o = i * 6;
    const cx = 0.5 * (primBounds[o + 0] + primBounds[o + 3]);
    const cy = 0.5 * (primBounds[o + 1] + primBounds[o + 4]);
    const cz = 0.5 * (primBounds[o + 2] + primBounds[o + 5]);
    centroids[i * 3 + 0] = cx;
    centroids[i * 3 + 1] = cy;
    centroids[i * 3 + 2] = cz;
    growAabbPoint(centroidBounds, cx, cy, cz);
  }

  // 2. Código de Morton 3D de 30 bits para cada primitiva y ordenación.
  const rawCodes = new Uint32Array(count);
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const p: Vec3 = [centroids[i * 3 + 0], centroids[i * 3 + 1], centroids[i * 3 + 2]];
    rawCodes[i] = mortonFromPoint(p, centroidBounds);
    order[i] = i;
  }
  order.sort((a, b) => rawCodes[a] - rawCodes[b] || a - b);

  const sortedCodes = new Uint32Array(count);
  for (let i = 0; i < count; i++) sortedCodes[i] = rawCodes[order[i]];

  // 3. Construcción recursiva sobre el arreglo ya ordenado por Morton.
  let nodeCount = 0;
  const buildRange = (first: number, lastInclusive: number): BvhTreeNode => {
    nodeCount++;
    const span = lastInclusive - first + 1;
    if (span <= maxLeafSize) {
      const box = emptyAabb();
      for (let k = first; k <= lastInclusive; k++) {
        const o = order[k] * 6;
        growAabbPoint(box, primBounds[o + 0], primBounds[o + 1], primBounds[o + 2]);
        growAabbPoint(box, primBounds[o + 3], primBounds[o + 4], primBounds[o + 5]);
      }
      return { bounds: box, left: null, right: null, first, count: span };
    }
    const split = findMortonSplit(sortedCodes, first, lastInclusive);
    const left = buildRange(first, split);
    const right = buildRange(split + 1, lastInclusive);
    return {
      bounds: unionAabb(left.bounds, right.bounds),
      left,
      right,
      first: 0,
      count: 0,
    };
  };

  const root = buildRange(0, count - 1);
  return { root, order, nodeCount };
}

/**
 * Construye el BLAS de una `Mesh` y devuelve tanto el árbol como el arreglo de
 * índices de triángulos YA REORDENADO en el orden de Morton de sus hojas.
 */
export function buildBlas(mesh: Mesh, maxLeafSize = 2): { bvh: BuiltBvh; orderedIndices: Uint32Array } {
  const bvh = buildBvhFromBounds(mesh.triangleBounds(), maxLeafSize);
  const orderedIndices = new Uint32Array(mesh.indices.length);
  for (let t = 0; t < mesh.triangleCount; t++) {
    const srcTri = bvh.order[t];
    orderedIndices[t * 3 + 0] = mesh.indices[srcTri * 3 + 0];
    orderedIndices[t * 3 + 1] = mesh.indices[srcTri * 3 + 1];
    orderedIndices[t * 3 + 2] = mesh.indices[srcTri * 3 + 2];
  }
  return { bvh, orderedIndices };
}

/**
 * Construye el TLAS de la escena a partir de las AABB de mundo de las
 * instancias (`maxLeafSize = 1` para que cada hoja apunte a una instancia).
 */
export function buildTlas(instanceBounds: Float32Array): BuiltBvh {
  return buildBvhFromBounds(instanceBounds, 1);
}

