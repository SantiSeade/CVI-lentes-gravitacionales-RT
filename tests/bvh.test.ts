// =============================================================================
//  bvh.test.ts — Pruebas unitarias del BVH de dos niveles (BLAS + TLAS).
// =============================================================================
//  Verifica el criterio de la Fase 4 (sección 9 del enunciado):
//    1. Que las AABB de todos los hijos están contenidas dentro de la AABB de
//       su nodo padre (tanto en BLAS como en TLAS).
//    2. Que el recorrido BLAS + TLAS aplanado devuelve EXACTAMENTE el mismo
//       triángulo e instancia más cercanos que la fuerza bruta para cientos de
//       segmentos aleatorios, visitando muchos menos nodos.
// =============================================================================
import { describe, expect, it } from 'vitest';
import { buildBlas, buildTlas, type BvhTreeNode } from '../src/accel/bvhBuilder';
import { bruteForceSceneCpu, flattenBvh, traverseTlasBlasCpu } from '../src/accel/bvhFlatten';
import type { Vec3 } from '../src/geometry/mesh';
import { ALL_LAYOUTS } from '../src/gpu/layouts';
import { instanceWorldBounds } from '../src/scene/instances';
import { createSolarSystem } from '../src/scene/solarSystem';
import { buildPresentShaderSource, buildTraceShaderSource, resolveShaderLine } from '../src/shaders';

/** Generador pseudoaleatorio determinista (Mulberry32) para pruebas reproducibles. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function verifyParentContainsChildren(node: BvhTreeNode): void {
  const eps = 1e-5;
  for (const child of [node.left, node.right]) {
    if (!child) continue;
    for (let a = 0; a < 3; a++) {
      expect(child.bounds.min[a]).toBeGreaterThanOrEqual(node.bounds.min[a] - eps);
      expect(child.bounds.max[a]).toBeLessThanOrEqual(node.bounds.max[a] + eps);
    }
    verifyParentContainsChildren(child);
  }
}

describe('BVH de dos niveles (bvhBuilder.ts + bvhFlatten.ts)', () => {
  it('cada AABB padre contiene las AABB de sus dos hijos en BLAS y en TLAS', () => {
    const scene = createSolarSystem({ icosphereSubdivisions: 3 });
    scene.graph.update(7.5);
    const mesh = scene.graph.meshes[0];
    const { bvh: blas } = buildBlas(mesh);
    verifyParentContainsChildren(blas.root);

    const instances = scene.graph.collectInstances();
    const worldBounds = instanceWorldBounds(instances, [mesh.computeBounds()]);
    const tlas = buildTlas(worldBounds);
    verifyParentContainsChildren(tlas.root);
  });

  it('BLAS + TLAS devuelve el mismo impacto que fuerza bruta para rayos aleatorios y dirigidos', () => {
    const scene = createSolarSystem({ icosphereSubdivisions: 3 }); // 1 280 triángulos/instancia
    scene.graph.update(4.2);

    const mesh = scene.graph.meshes[0];
    const { bvh: blas, orderedIndices } = buildBlas(mesh);
    const blasBuf = flattenBvh(blas);

    const rawInstances = scene.graph.collectInstances();
    const tlas = buildTlas(instanceWorldBounds(rawInstances, [mesh.computeBounds()]));
    const tlasBuf = flattenBvh(tlas);
    const orderedInstances = Array.from(tlas.order, (i) => rawInstances[i]);

    const rng = makeRng(20261102);
    let hitsFound = 0;
    let totalBvhVisited = 0;
    let totalBruteVisited = 0;

    // 120 rayos: la mitad apuntando hacia centros de planetas reales y la mitad aleatorios.
    for (let r = 0; r < 120; r++) {
      const p0: Vec3 = [(rng() - 0.5) * 90, (rng() - 0.5) * 40, -140 + (rng() - 0.5) * 40];
      let p1: Vec3;
      if (r < 60) {
        const target = orderedInstances[r % orderedInstances.length];
        const m = target.worldFromLocal;
        p1 = [
          m[12] + (rng() - 0.5) * 4,
          m[13] + (rng() - 0.5) * 4,
          m[14] + (rng() - 0.5) * 4,
        ];
      } else {
        p1 = [(rng() - 0.5) * 240, (rng() - 0.5) * 80, (rng() - 0.5) * 240];
      }
      // Estirar el segmento más allá de p1 para atravesar el planeta completo.
      const d: Vec3 = [(p1[0] - p0[0]) * 1.6, (p1[1] - p0[1]) * 1.6, (p1[2] - p0[2]) * 1.6];

      const bvhHit = traverseTlasBlasCpu(
        p0,
        d,
        tlasBuf,
        orderedInstances,
        blasBuf,
        mesh.vertices,
        orderedIndices,
        1.0,
      );
      const bruteHit = bruteForceSceneCpu(p0, d, orderedInstances, mesh.vertices, orderedIndices, 1.0);

      expect(bvhHit.instanceIndex).toBe(bruteHit.instanceIndex);
      expect(bvhHit.triangleIndex).toBe(bruteHit.triangleIndex);
      if (bruteHit.triangleIndex >= 0) {
        hitsFound++;
        expect(bvhHit.t).toBeCloseTo(bruteHit.t, 5);
      }
      totalBvhVisited += bvhHit.nodesVisited;
      totalBruteVisited += bruteHit.nodesVisited;
    }

    expect(hitsFound).toBeGreaterThan(35);
    // El BVH debe visitar una fracción pequeña del trabajo de fuerza bruta.
    expect(totalBvhVisited).toBeLessThan(totalBruteVisited / 15);
  });

  it('los structs WGSL (common.wgsl + present.wgsl) coinciden en tamaño y offsets con layouts.ts', () => {
    const traceShader = buildTraceShaderSource();
    const presentShader = buildPresentShaderSource();
    const fullWgsl = `${traceShader.code}\n${presentShader.code}`;

    // Verifica que el mapeo de líneas identifica cada archivo .wgsl concatenado.
    expect(traceShader.entries.map((e) => e.file)).toEqual([
      'common.wgsl',
      'geodesic.wgsl',
      'intersect.wgsl',
      'shading.wgsl',
      'trace.wgsl',
    ]);
    const lastEntry = traceShader.entries[traceShader.entries.length - 1];
    expect(resolveShaderLine(traceShader, lastEntry.startLine + 2)).toEqual({
      file: 'trace.wgsl',
      line: 3,
    });

    // Reglas de tamaño/alineamiento de WGSL para los tipos que usamos en structs.
    const wgslTypeInfo = (t: string): { size: number; align: number } => {
      const clean = t.trim();
      if (clean === 'f32' || clean === 'u32' || clean === 'i32') return { size: 4, align: 4 };
      if (clean === 'vec2f' || clean === 'vec2u') return { size: 8, align: 8 };
      if (clean === 'vec3f' || clean === 'vec3u') return { size: 12, align: 16 };
      if (clean === 'vec4f' || clean === 'vec4u') return { size: 16, align: 16 };
      if (clean === 'mat4x4f') return { size: 64, align: 16 };
      const arrMatch = clean.match(/^array<([^,]+),\s*(\d+)>$/);
      if (arrMatch) {
        const elem = wgslTypeInfo(arrMatch[1]);
        const stride = Math.ceil(elem.size / elem.align) * elem.align;
        return { size: stride * Number(arrMatch[2]), align: elem.align };
      }
      throw new Error(`Tipo WGSL no reconocido en test: ${clean}`);
    };

    for (const layout of ALL_LAYOUTS) {
      const re = new RegExp(`struct\\s+${layout.name}\\s*\\{([\\s\\S]*?)\\}`, 'm');
      const match = fullWgsl.match(re);
      expect(match, `No se encontró struct ${layout.name} en WGSL`).not.toBeNull();
      const body = match![1];

      let offset = 0;
      let maxAlign = 1;
      const computedOffsets: Record<string, number> = {};

      for (const rawLine of body.split('\n')) {
        const line = rawLine.replace(/\/\/.*$/, '').trim().replace(/,$/, '');
        if (!line) continue;
        const [fieldName, fieldType] = line.split(':').map((s) => s.trim());
        const info = wgslTypeInfo(fieldType);
        maxAlign = Math.max(maxAlign, info.align);
        offset = Math.ceil(offset / info.align) * info.align;
        computedOffsets[fieldName] = offset;
        offset += info.size;
      }
      const totalSize = Math.ceil(offset / maxAlign) * maxAlign;
      expect(computedOffsets).toEqual(layout.offsets);
      expect(totalSize).toBe(layout.size);
    }
  });
});
