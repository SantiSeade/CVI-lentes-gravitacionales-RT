// =============================================================================
//  bvhFlatten.ts — Aplanado del BVH a un arreglo 1D de 32 bytes por nodo.
// =============================================================================
//  ¿Por qué aplanar el árbol?
//    En WGSL no existen punteros ni recursión. Para que la GPU pueda recorrer
//    el BVH con una pila pequeña (`array<u32, 32>`), guardamos todos los nodos
//    en un único arreglo lineal siguiendo el orden PRE-ORDEN (depth-first:
//    primero el nodo, luego todo el subárbol izquierdo y después todo el
//    subárbol derecho).
//
//    Esta disposición tiene una propiedad clave:
//      - El HIJO IZQUIERDO de un nodo interno en el índice `i` está SIEMPRE en
//        `i + 1` (no hace falta guardarlo).
//      - Solo necesitamos guardar el índice del HIJO DERECHO.
//
//  Layout exacto de `BvhNode` (32 bytes = 8 × 4 bytes, ver gpu/layouts.ts):
//
//      offset  0: aabb_min.x       (f32)
//      offset  4: aabb_min.y       (f32)
//      offset  8: aabb_min.z       (f32)
//      offset 12: right_or_first   (u32)  si count == 0 → índice del hijo derecho
//                                         si count  > 0 → índice de la 1.ª primitiva
//      offset 16: aabb_max.x       (f32)
//      offset 20: aabb_max.y       (f32)
//      offset 24: aabb_max.z       (f32)
//      offset 28: count            (u32)  0 = nodo interno, >0 = hoja con `count` primitivas
//
//  Además, este archivo incluye las rutinas de intersección en CPU (slab +
//  Möller-Trumbore + recorrido con pila explícita) idénticas a las de
//  `intersect.wgsl`, para que `tests/bvh.test.ts` valide el árbol contra fuerza
//  bruta sin necesitar una GPU.
// =============================================================================
import { VERTEX_FLOATS, type Vec3 } from '../geometry/mesh';
import { BVH_NODE } from '../gpu/layouts';
import type { Instance } from '../scene/instances';
import type { BuiltBvh, BvhTreeNode } from './bvhBuilder';

/** Floats/u32 por nodo (32 bytes / 4 = 8). */
export const BVH_NODE_WORDS = BVH_NODE.size / 4;

/**
 * Aplana un `BuiltBvh` en orden depth-first a un `ArrayBuffer` de `32 * N` bytes.
 *
 * @param nodeOffset desplazamiento que se suma al índice del hijo derecho
 *                   (útil cuando varios BLAS se concatenan en un mismo buffer).
 * @param primOffset desplazamiento que se suma a `first` en las hojas.
 */
export function flattenBvh(bvh: BuiltBvh, nodeOffset = 0, primOffset = 0): ArrayBuffer {
  const buf = new ArrayBuffer(Math.max(1, bvh.nodeCount) * BVH_NODE.size);
  const f32 = new Float32Array(buf);
  const u32 = new Uint32Array(buf);
  let cursor = 0;

  const emit = (node: BvhTreeNode): number => {
    const myIndex = cursor++;
    const base = myIndex * BVH_NODE_WORDS;
    f32[base + 0] = node.bounds.min[0];
    f32[base + 1] = node.bounds.min[1];
    f32[base + 2] = node.bounds.min[2];
    f32[base + 4] = node.bounds.max[0];
    f32[base + 5] = node.bounds.max[1];
    f32[base + 6] = node.bounds.max[2];

    if (node.count > 0 || !node.left || !node.right) {
      u32[base + 3] = primOffset + node.first;
      u32[base + 7] = node.count;
    } else {
      emit(node.left); // queda garantizado en myIndex + 1
      const rightIndex = emit(node.right);
      u32[base + 3] = nodeOffset + rightIndex;
      u32[base + 7] = 0;
    }
    return myIndex;
  };

  emit(bvh.root);
  return buf;
}

// =============================================================================
//  Recorrido en CPU (espejo exacto de src/shaders/intersect.wgsl para tests)
// =============================================================================

export interface CpuHit {
  t: number;
  instanceIndex: number;
  triangleIndex: number;
  nodesVisited: number;
}

/**
 * Método de las losas (slab test) para el segmento `P(t) = p0 + t·d`,
 * `t ∈ [0, tMax]`. Devuelve el `tEnter` de entrada a la caja o `Infinity` si no
 * la corta.
 */
export function intersectSegmentAabb(
  p0: Vec3,
  d: Vec3,
  bmin: Vec3,
  bmax: Vec3,
  tMax: number,
): number {
  let tMin = 0.0;
  let tFar = tMax;
  for (let axis = 0; axis < 3; axis++) {
    const dir = d[axis];
    const orig = p0[axis];
    if (Math.abs(dir) < 1e-9) {
      if (orig < bmin[axis] || orig > bmax[axis]) return Infinity;
    } else {
      const inv = 1.0 / dir;
      let t1 = (bmin[axis] - orig) * inv;
      let t2 = (bmax[axis] - orig) * inv;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tMin) tMin = t1;
      if (t2 < tFar) tFar = t2;
      if (tMin > tFar) return Infinity;
    }
  }
  return tMin;
}

/**
 * Intersección segmento-triángulo con el algoritmo de Möller-Trumbore para
 * `P(t) = p0 + t·d` con `t ∈ (1e-5, tMax)`. Devuelve `t` o `Infinity`.
 */
export function intersectSegmentTriangle(
  p0: Vec3,
  d: Vec3,
  v0: Vec3,
  v1: Vec3,
  v2: Vec3,
  tMax: number,
): number {
  const e1x = v1[0] - v0[0], e1y = v1[1] - v0[1], e1z = v1[2] - v0[2];
  const e2x = v2[0] - v0[0], e2y = v2[1] - v0[1], e2z = v2[2] - v0[2];
  const hx = d[1] * e2z - d[2] * e2y;
  const hy = d[2] * e2x - d[0] * e2z;
  const hz = d[0] * e2y - d[1] * e2x;
  const det = e1x * hx + e1y * hy + e1z * hz;
  if (Math.abs(det) < 1e-8) return Infinity;
  const invDet = 1.0 / det;
  const sx = p0[0] - v0[0], sy = p0[1] - v0[1], sz = p0[2] - v0[2];
  const u = (sx * hx + sy * hy + sz * hz) * invDet;
  if (u < 0.0 || u > 1.0) return Infinity;
  const qx = sy * e1z - sz * e1y;
  const qy = sz * e1x - sx * e1z;
  const qz = sx * e1y - sy * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * invDet;
  if (v < 0.0 || u + v > 1.0) return Infinity;
  const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
  return t > 1e-5 && t < tMax ? t : Infinity;
}

function readPos(vertices: Float32Array, idx: number): Vec3 {
  const o = idx * VERTEX_FLOATS;
  return [vertices[o], vertices[o + 1], vertices[o + 2]];
}

function transformPoint(m: ArrayLike<number>, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

function transformVector(m: ArrayLike<number>, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2],
  ];
}

/** Recorre un BLAS aplanado con pila explícita de 32 enteros. */
export function traverseBlasCpu(
  p0Local: Vec3,
  dLocal: Vec3,
  blasBuf: ArrayBuffer,
  rootNode: number,
  vertices: Float32Array,
  indices: Uint32Array,
  vertexOffset: number,
  tMaxInitial: number,
): { t: number; triangleIndex: number; nodesVisited: number } {
  const f32 = new Float32Array(blasBuf);
  const u32 = new Uint32Array(blasBuf);
  const stack = new Uint32Array(32);
  let sp = 0;
  stack[sp++] = rootNode;

  let bestT = tMaxInitial;
  let bestTri = -1;
  let visited = 0;

  while (sp > 0) {
    const nodeIdx = stack[--sp];
    visited++;
    const base = nodeIdx * BVH_NODE_WORDS;
    const bmin: Vec3 = [f32[base + 0], f32[base + 1], f32[base + 2]];
    const bmax: Vec3 = [f32[base + 4], f32[base + 5], f32[base + 6]];
    if (intersectSegmentAabb(p0Local, dLocal, bmin, bmax, bestT) === Infinity) continue;

    const rightOrFirst = u32[base + 3];
    const count = u32[base + 7];
    if (count > 0) {
      for (let i = 0; i < count; i++) {
        const tri = rightOrFirst + i;
        const v0 = readPos(vertices, vertexOffset + indices[tri * 3 + 0]);
        const v1 = readPos(vertices, vertexOffset + indices[tri * 3 + 1]);
        const v2 = readPos(vertices, vertexOffset + indices[tri * 3 + 2]);
        const t = intersectSegmentTriangle(p0Local, dLocal, v0, v1, v2, bestT);
        if (t < bestT) {
          bestT = t;
          bestTri = tri;
        }
      }
    } else {
      const leftIdx = nodeIdx + 1;
      const rightIdx = rightOrFirst;
      // Empujar primero el hijo más lejano para visitar antes el más cercano.
      const lBase = leftIdx * BVH_NODE_WORDS;
      const rBase = rightIdx * BVH_NODE_WORDS;
      const tL = intersectSegmentAabb(
        p0Local,
        dLocal,
        [f32[lBase], f32[lBase + 1], f32[lBase + 2]],
        [f32[lBase + 4], f32[lBase + 5], f32[lBase + 6]],
        bestT,
      );
      const tR = intersectSegmentAabb(
        p0Local,
        dLocal,
        [f32[rBase], f32[rBase + 1], f32[rBase + 2]],
        [f32[rBase + 4], f32[rBase + 5], f32[rBase + 6]],
        bestT,
      );
      if (tL < tR) {
        if (tR < Infinity) stack[sp++] = rightIdx;
        if (tL < Infinity) stack[sp++] = leftIdx;
      } else {
        if (tL < Infinity) stack[sp++] = leftIdx;
        if (tR < Infinity) stack[sp++] = rightIdx;
      }
    }
  }
  return { t: bestT, triangleIndex: bestTri, nodesVisited: visited };
}

/**
 * Recorre TLAS + BLAS sobre una lista de instancias ordenadas por el TLAS y
 * devuelve el impacto más cercano en `t ∈ (0, tMax]`.
 */
export function traverseTlasBlasCpu(
  p0World: Vec3,
  dWorld: Vec3,
  tlasBuf: ArrayBuffer,
  orderedInstances: Instance[],
  blasBuf: ArrayBuffer,
  vertices: Float32Array,
  indices: Uint32Array,
  tMax = 1.0,
): CpuHit {
  const f32 = new Float32Array(tlasBuf);
  const u32 = new Uint32Array(tlasBuf);
  const stack = new Uint32Array(32);
  let sp = 0;
  stack[sp++] = 0;

  let bestT = tMax;
  let bestInst = -1;
  let bestTri = -1;
  let visited = 0;

  while (sp > 0) {
    const nodeIdx = stack[--sp];
    visited++;
    const base = nodeIdx * BVH_NODE_WORDS;
    const bmin: Vec3 = [f32[base + 0], f32[base + 1], f32[base + 2]];
    const bmax: Vec3 = [f32[base + 4], f32[base + 5], f32[base + 6]];
    if (intersectSegmentAabb(p0World, dWorld, bmin, bmax, bestT) === Infinity) continue;

    const rightOrFirst = u32[base + 3];
    const count = u32[base + 7];
    if (count > 0) {
      for (let i = 0; i < count; i++) {
        const instIdx = rightOrFirst + i;
        const inst = orderedInstances[instIdx];
        // Propiedad clave (sección 4.4): transformamos p0 y d con localFromWorld
        // SIN normalizar d; así el parámetro t ∈ [0, 1] es idéntico al de mundo.
        const p0Local = transformPoint(inst.localFromWorld as ArrayLike<number>, p0World);
        const dLocal = transformVector(inst.localFromWorld as ArrayLike<number>, dWorld);
        const hit = traverseBlasCpu(p0Local, dLocal, blasBuf, 0, vertices, indices, 0, bestT);
        visited += hit.nodesVisited;
        if (hit.triangleIndex >= 0 && hit.t < bestT) {
          bestT = hit.t;
          bestInst = instIdx;
          bestTri = hit.triangleIndex;
        }
      }
    } else {
      stack[sp++] = rightOrFirst;
      stack[sp++] = nodeIdx + 1;
    }
  }
  return { t: bestT, instanceIndex: bestInst, triangleIndex: bestTri, nodesVisited: visited };
}

/** Fuerza bruta sobre todas las instancias y todos sus triángulos. */
export function bruteForceSceneCpu(
  p0World: Vec3,
  dWorld: Vec3,
  orderedInstances: Instance[],
  vertices: Float32Array,
  indices: Uint32Array,
  tMax = 1.0,
): CpuHit {
  const triCount = indices.length / 3;
  let bestT = tMax;
  let bestInst = -1;
  let bestTri = -1;
  for (let instIdx = 0; instIdx < orderedInstances.length; instIdx++) {
    const inst = orderedInstances[instIdx];
    const p0Local = transformPoint(inst.localFromWorld as ArrayLike<number>, p0World);
    const dLocal = transformVector(inst.localFromWorld as ArrayLike<number>, dWorld);
    for (let tri = 0; tri < triCount; tri++) {
      const v0 = readPos(vertices, indices[tri * 3 + 0]);
      const v1 = readPos(vertices, indices[tri * 3 + 1]);
      const v2 = readPos(vertices, indices[tri * 3 + 2]);
      const t = intersectSegmentTriangle(p0Local, dLocal, v0, v1, v2, bestT);
      if (t < bestT) {
        bestT = t;
        bestInst = instIdx;
        bestTri = tri;
      }
    }
  }
  return {
    t: bestT,
    instanceIndex: bestInst,
    triangleIndex: bestTri,
    nodesVisited: orderedInstances.length * triCount,
  };
}
