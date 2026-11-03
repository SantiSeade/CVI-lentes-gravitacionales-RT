// =============================================================================
//  mesh.ts — Malla de triángulos en formato "Indexed Face Set".
// =============================================================================
//  ¿Qué es un Indexed Face Set?
//    Es la forma más simple y compacta de guardar una malla:
//      - Un arreglo de VÉRTICES (cada uno con su posición y su normal).
//      - Un arreglo de ÍNDICES: cada 3 enteros forman un triángulo y dicen qué
//        vértices usa. Un vértice compartido por 6 triángulos se guarda 1 vez.
//
//    No usamos estructuras de adyacencia (Half-Edge, Winged-Edge): el trazador
//    solo necesita "dame los 3 vértices del triángulo k", que el IFS responde
//    con dos lecturas de memoria. Ambos arreglos son lineales y contiguos, así
//    que se suben a la GPU tal cual, sin conversión.
//
//  Layout de un vértice (32 bytes, igual al struct `Vertex` de common.wgsl):
//
//      offset  0: position.xyz (f32×3)   offset 12: 1.0  (relleno)
//      offset 16: normal.xyz   (f32×3)   offset 28: 0.0  (relleno)
//
//    ¿Por qué el relleno? En WGSL un `vec3f` dentro de un arreglo ocupa 16
//    bytes (se alinea a 16). Si guardáramos solo 3 floats por campo, CPU y GPU
//    leerían los datos desfasados. Rellenando a vec4 el layout es idéntico en
//    ambos lados y la lectura en GPU es una sola carga de 16 bytes.
//
//  Estructura del proyecto que implementa: "Mallas (Indexed Face Set)", 4.2.
// =============================================================================

/** Vector de 3 componentes en CPU (doble precisión de JS). */
export type Vec3 = [number, number, number];

/** Caja alineada con los ejes (Axis-Aligned Bounding Box). */
export interface Aabb {
  min: Vec3;
  max: Vec3;
}

/** Floats por vértice: position(4) + normal(4). */
export const VERTEX_FLOATS = 8;
/** Bytes por vértice en el buffer de GPU. */
export const VERTEX_BYTES = VERTEX_FLOATS * 4;

/** AABB "vacía": cualquier punto que se le añada la convierte en válida. */
export function emptyAabb(): Aabb {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}

/** Agranda `box` para que contenga el punto (x, y, z). */
export function growAabbPoint(box: Aabb, x: number, y: number, z: number): void {
  if (x < box.min[0]) box.min[0] = x;
  if (y < box.min[1]) box.min[1] = y;
  if (z < box.min[2]) box.min[2] = z;
  if (x > box.max[0]) box.max[0] = x;
  if (y > box.max[1]) box.max[1] = y;
  if (z > box.max[2]) box.max[2] = z;
}

export class Mesh {
  /** Vértices empaquetados (VERTEX_FLOATS floats por vértice). */
  readonly vertices: Float32Array;
  /** Índices de triángulos (3 por triángulo), relativos a esta malla. */
  readonly indices: Uint32Array;

  constructor(
    readonly name: string,
    vertices: Float32Array,
    indices: Uint32Array,
  ) {
    if (vertices.length % VERTEX_FLOATS !== 0) {
      throw new Error(`Mesh "${name}": el arreglo de vértices no es múltiplo de ${VERTEX_FLOATS} floats.`);
    }
    if (indices.length % 3 !== 0) {
      throw new Error(`Mesh "${name}": el número de índices no es múltiplo de 3.`);
    }
    const vc = vertices.length / VERTEX_FLOATS;
    for (let i = 0; i < indices.length; i++) {
      if (indices[i] >= vc) throw new Error(`Mesh "${name}": índice ${indices[i]} fuera de rango (${vc} vértices).`);
    }
    this.vertices = vertices;
    this.indices = indices;
  }

  /**
   * Construye una malla a partir de arreglos "planos" (xyz, xyz, ...) y añade
   * el relleno a vec4 que exige WGSL.
   */
  static fromArrays(name: string, positions: ArrayLike<number>, normals: ArrayLike<number>, indices: ArrayLike<number>): Mesh {
    if (positions.length !== normals.length) throw new Error(`Mesh "${name}": posiciones y normales no coinciden.`);
    const count = positions.length / 3;
    const v = new Float32Array(count * VERTEX_FLOATS);
    for (let i = 0; i < count; i++) {
      const o = i * VERTEX_FLOATS;
      v[o + 0] = positions[i * 3 + 0];
      v[o + 1] = positions[i * 3 + 1];
      v[o + 2] = positions[i * 3 + 2];
      v[o + 3] = 1.0; // relleno (w = 1: es un punto)
      v[o + 4] = normals[i * 3 + 0];
      v[o + 5] = normals[i * 3 + 1];
      v[o + 6] = normals[i * 3 + 2];
      v[o + 7] = 0.0; // relleno (w = 0: es una dirección)
    }
    return new Mesh(name, v, Uint32Array.from(indices));
  }

  get vertexCount(): number {
    return this.vertices.length / VERTEX_FLOATS;
  }

  get triangleCount(): number {
    return this.indices.length / 3;
  }

  /** Posición del vértice i. */
  position(i: number): Vec3 {
    const o = i * VERTEX_FLOATS;
    return [this.vertices[o], this.vertices[o + 1], this.vertices[o + 2]];
  }

  /** AABB de toda la malla en su espacio local. */
  computeBounds(): Aabb {
    const box = emptyAabb();
    for (let i = 0; i < this.vertexCount; i++) {
      const o = i * VERTEX_FLOATS;
      growAabbPoint(box, this.vertices[o], this.vertices[o + 1], this.vertices[o + 2]);
    }
    return box;
  }

  /**
   * AABB de cada triángulo, empaquetadas como [minX,minY,minZ,maxX,maxY,maxZ]
   * por triángulo. Es la entrada del constructor del BVH (bvhBuilder.ts).
   */
  triangleBounds(): Float32Array {
    const out = new Float32Array(this.triangleCount * 6);
    const v = this.vertices;
    for (let t = 0; t < this.triangleCount; t++) {
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let k = 0; k < 3; k++) {
        const o = this.indices[t * 3 + k] * VERTEX_FLOATS;
        const x = v[o], y = v[o + 1], z = v[o + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      out.set([minX, minY, minZ, maxX, maxY, maxZ], t * 6);
    }
    return out;
  }
}

