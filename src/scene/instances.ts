// =============================================================================
//  instances.ts — Formato de instancia (y de material) tal como lo ve la GPU.
// =============================================================================
//  ¿Qué es una instancia?
//    Una INSTANCIA es "esta malla, dibujada con esta transformación y este
//    material". Diez planetas que comparten la misma icosfera son diez
//    instancias de UNA sola malla: la malla (y su BLAS) se sube una vez y cada
//    instancia solo añade 144 bytes. Es lo que permitirá, más adelante, tener
//    cientos de asteroides casi gratis en memoria.
//
//  Layout de `Instance` (144 bytes, ver gpu/layouts.ts y common.wgsl):
//
//      offset   0  world_from_local : mat4x4f  (local → mundo)
//      offset  64  local_from_world : mat4x4f  (mundo → local, la inversa)
//      offset 128  mesh_id          : u32      (índice en MeshInfo)
//      offset 132  material_id      : u32      (índice en la tabla de materiales)
//      offset 136  _pad0, _pad1     : u32×2    (relleno hasta múltiplo de 16)
//
//    ¿Por qué guardar la INVERSA? El trazador transforma cada micro-segmento
//    del mundo al espacio local de la instancia (donde vive el BLAS). Invertir
//    una matriz 4×4 por segmento y por instancia en la GPU sería carísimo; en
//    CPU se hace una vez por instancia y fotograma.
//
//  Estructura del proyecto que implementa: grafo de escena con instanciación
//  (4.1) y la entrada del TLAS (4.4).
// =============================================================================
import type { mat4 } from 'gl-matrix';
import type { Aabb, Vec3 } from '../geometry/mesh';
import { INSTANCE, MATERIAL, MAX_MATERIALS } from '../gpu/layouts';

/** Instancia aplanada lista para empaquetar (producida por SceneGraph.collectInstances). */
export interface Instance {
  name: string;
  worldFromLocal: mat4;
  localFromWorld: mat4;
  meshId: number;
  materialId: number;
}

/**
 * Empaqueta instancias en un ArrayBuffer con el layout de `Instance`.
 *
 * @param order si se da, la instancia k del buffer es `instances[order[k]]`.
 *              El TLAS reordena las instancias (orden Morton) para que cada hoja
 *              apunte a un rango contiguo del buffer.
 */
export function packInstances(instances: Instance[], order?: ArrayLike<number>): ArrayBuffer {
  const count = order ? order.length : instances.length;
  const buf = new ArrayBuffer(Math.max(1, count) * INSTANCE.size);
  const f32 = new Float32Array(buf);
  const u32 = new Uint32Array(buf);
  for (let k = 0; k < count; k++) {
    const inst = instances[order ? order[k] : k];
    const base = (k * INSTANCE.size) / 4;
    f32.set(inst.worldFromLocal as ArrayLike<number>, base + INSTANCE.offsets.world_from_local / 4);
    f32.set(inst.localFromWorld as ArrayLike<number>, base + INSTANCE.offsets.local_from_world / 4);
    u32[base + INSTANCE.offsets.mesh_id / 4] = inst.meshId;
    u32[base + INSTANCE.offsets.material_id / 4] = inst.materialId;
  }
  return buf;
}

/**
 * Transforma una AABB local con la matriz `m` y devuelve la AABB de mundo que
 * la contiene (método de Arvo, 1990).
 *
 * Idea: en vez de transformar las 8 esquinas, para cada eje de salida i se
 * suma, por cada eje de entrada j, el menor y el mayor de m[i][j]·min[j] y
 * m[i][j]·max[j]. Da exactamente la misma caja que las 8 esquinas, con menos
 * operaciones. gl-matrix guarda las matrices por columnas: m[j*4 + i] = fila i, columna j.
 */
export function transformAabb(m: ArrayLike<number>, box: Aabb): Aabb {
  const outMin: Vec3 = [m[12], m[13], m[14]];
  const outMax: Vec3 = [m[12], m[13], m[14]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const e = m[j * 4 + i];
      const a = e * box.min[j];
      const b = e * box.max[j];
      outMin[i] += Math.min(a, b);
      outMax[i] += Math.max(a, b);
    }
  }
  return { min: outMin, max: outMax };
}

/**
 * AABB de mundo de cada instancia, empaquetadas como 6 floats por instancia
 * (la entrada que espera `buildTlas`).
 */
export function instanceWorldBounds(instances: Instance[], meshBounds: Aabb[]): Float32Array {
  const out = new Float32Array(instances.length * 6);
  instances.forEach((inst, k) => {
    const b = transformAabb(inst.worldFromLocal as ArrayLike<number>, meshBounds[inst.meshId]);
    out.set([...b.min, ...b.max], k * 6);
  });
  return out;
}

// =============================================================================
//  Materiales
// =============================================================================
//  Layout de `Material` (48 bytes, en un uniform buffer de MAX_MATERIALS):
//
//      offset  0  base_color      : vec4f  rgb = albedo,          w = tipo de patrón
//      offset 16  secondary_color : vec4f  rgb = segundo color,   w = escala del patrón
//      offset 32  emission        : vec4f  rgb = color emisivo,   w = intensidad (0 = no emite)
//
//  Los patrones procedurales (bandas tipo Júpiter, "continentes" con ruido) se
//  evalúan en el espacio LOCAL de la malla, así que giran con el planeta y hacen
//  visible el animador `Spin`.
// =============================================================================
export const PATTERN_NONE = 0;
export const PATTERN_BANDS = 1;
export const PATTERN_NOISE = 2;

export interface MaterialDesc {
  name: string;
  baseColor: Vec3;
  secondaryColor?: Vec3;
  pattern?: number;
  patternScale?: number;
  emission?: Vec3;
  emissionStrength?: number;
}

/** Empaqueta la tabla completa de materiales (tamaño fijo, MAX_MATERIALS entradas). */
export function packMaterials(materials: MaterialDesc[]): ArrayBuffer {
  if (materials.length > MAX_MATERIALS) {
    throw new Error(`Hay ${materials.length} materiales y el máximo es ${MAX_MATERIALS} (ver MAX_MATERIALS).`);
  }
  const buf = new ArrayBuffer(MAX_MATERIALS * MATERIAL.size);
  const f32 = new Float32Array(buf);
  materials.forEach((m, k) => {
    const base = (k * MATERIAL.size) / 4;
    const sec = m.secondaryColor ?? m.baseColor;
    const em = m.emission ?? [0, 0, 0];
    f32.set([...m.baseColor, m.pattern ?? PATTERN_NONE], base + MATERIAL.offsets.base_color / 4);
    f32.set([...sec, m.patternScale ?? 1], base + MATERIAL.offsets.secondary_color / 4);
    f32.set([...em, m.emissionStrength ?? 0], base + MATERIAL.offsets.emission / 4);
  });
  return buf;
}

