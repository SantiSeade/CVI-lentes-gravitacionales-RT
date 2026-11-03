// =============================================================================
//  objLoader.ts — STUB documentado del cargador de modelos Wavefront .obj.
// =============================================================================
//  ¿Por qué existe si no hace nada todavía?
//    El objetivo del proyecto es que la luz curvada choque con MALLAS 3D
//    arbitrarias (naves, asteroides), no solo con esferas. Esta versión inicial
//    solo usa icosferas generadas por código, pero el resto del pipeline ya es
//    genérico: cualquier `Mesh` (Indexed Face Set) obtiene su BLAS y puede
//    instanciarse en el grafo de escena. Este archivo marca el punto exacto
//    donde se enchufará la carga de modelos.
//
//  Plan de implementación (TODO(ext)):
//    1. Leer el texto del .obj línea a línea:
//         v  x y z        → posición
//         vn x y z        → normal
//         f  a/b/c ...    → cara (índices 1-based; puede ser polígono → triangular en abanico)
//    2. Como .obj indexa posición y normal por separado, "des-indexar" a pares
//       (posición, normal) únicos con un Map, para producir un IFS con un solo
//       índice por vértice (lo que espera `Mesh`).
//    3. Si faltan normales, calcularlas promediando las normales de cara.
//    4. Devolver `Mesh.fromArrays(nombre, posiciones, normales, índices)`.
//    5. Registrar la malla con `SceneGraph.addMesh()`; su BLAS se construye una
//       sola vez en `packGeometry()` (gpu/buffers.ts).
//
//  Estructura del proyecto relacionada: "Mallas (Indexed Face Set)", 4.2.
//  Ver docs/ROADMAP.md, sección "Carga de modelos .obj".
// =============================================================================
import type { Mesh } from './mesh';

/**
 * Convierte el texto de un archivo .obj en una `Mesh`.
 * TODO(ext): implementar carga de .obj (naves, asteroides). Ver plan arriba.
 */
export function parseObj(_text: string, name: string): Mesh {
  throw new Error(`parseObj("${name}"): la carga de .obj aún no está implementada (TODO(ext), ver docs/ROADMAP.md).`);
}

/**
 * Descarga y convierte un .obj desde una URL.
 * TODO(ext): implementar junto con `parseObj`.
 */
export async function loadObj(url: string): Promise<Mesh> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`loadObj: no se pudo descargar ${url} (${res.status}).`);
  return parseObj(await res.text(), url);
}

