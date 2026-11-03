// =============================================================================
//  primitives.ts — Generador de primitivas: icosfera.
// =============================================================================
//  ¿Por qué una icosfera y no una esfera UV (latitud/longitud)?
//    La esfera UV concentra triángulos diminutos en los polos y triángulos
//    grandes en el ecuador. La icosfera parte de un icosaedro (20 triángulos
//    equiláteros) y subdivide cada triángulo en 4, proyectando los vértices
//    nuevos sobre la esfera. Resultado: triángulos casi del mismo tamaño en
//    toda la superficie, lo que da un BVH equilibrado y un sombreado uniforme.
//
//    Triángulos según subdivisiones:  20 · 4^s
//        s = 2 →   320     s = 3 → 1 280     s = 4 → 5 120     s = 5 → 20 480
//
//    El proyecto usa s = 4 por defecto (5 120 triángulos por planeta): suficiente
//    para que recorrer el BVH sea MUCHO más barato que probar todos los
//    triángulos, que es justo lo que queremos medir.
//
//  Estructura del proyecto que implementa: "Mallas", 4.2 (malla compartida por
//  todos los planetas mediante instanciación).
// =============================================================================
import { Mesh } from './mesh';

/**
 * Crea una icosfera de radio 1 centrada en el origen.
 * Al ser de radio 1, la normal de cada vértice es igual a su posición.
 *
 * @param subdivisions número de veces que se subdivide cada triángulo (0..7).
 */
export function createIcosphere(subdivisions: number, name = `icosphere-${subdivisions}`): Mesh {
  if (!Number.isInteger(subdivisions) || subdivisions < 0 || subdivisions > 7) {
    throw new Error('createIcosphere: subdivisions debe ser un entero entre 0 y 7.');
  }

  // ---- Icosaedro base -------------------------------------------------------
  // Sus 12 vértices son las permutaciones cíclicas de (0, ±1, ±φ), con φ la
  // razón áurea. Luego se normalizan para quedar sobre la esfera unitaria.
  const phi = (1 + Math.sqrt(5)) / 2;
  const positions: number[] = [];
  const addVertex = (x: number, y: number, z: number): number => {
    const len = Math.hypot(x, y, z);
    positions.push(x / len, y / len, z / len);
    return positions.length / 3 - 1;
  };
  for (const [x, y, z] of [
    [-1, phi, 0], [1, phi, 0], [-1, -phi, 0], [1, -phi, 0],
    [0, -1, phi], [0, 1, phi], [0, -1, -phi], [0, 1, -phi],
    [phi, 0, -1], [phi, 0, 1], [-phi, 0, -1], [-phi, 0, 1],
  ]) {
    addVertex(x, y, z);
  }

  // 20 caras con orientación antihoraria vista desde fuera (normal hacia fuera).
  let faces: number[] = [
    0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11,
    1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
    3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9,
    4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
  ];

  // ---- Subdivisión -----------------------------------------------------------
  // Cada triángulo (a, b, c) se parte en 4 usando los puntos medios de sus
  // aristas. La caché evita crear dos veces el punto medio de una arista
  // compartida por dos triángulos (si no, la malla tendría grietas).
  for (let s = 0; s < subdivisions; s++) {
    const midCache = new Map<number, number>();
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? a * 1_000_003 + b : b * 1_000_003 + a;
      const cached = midCache.get(key);
      if (cached !== undefined) return cached;
      const id = addVertex(
        (positions[a * 3] + positions[b * 3]) / 2,
        (positions[a * 3 + 1] + positions[b * 3 + 1]) / 2,
        (positions[a * 3 + 2] + positions[b * 3 + 2]) / 2,
      );
      midCache.set(key, id);
      return id;
    };
    const next: number[] = [];
    for (let f = 0; f < faces.length; f += 3) {
      const a = faces[f], b = faces[f + 1], c = faces[f + 2];
      const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
      next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    faces = next;
  }

  // En la esfera unitaria la normal es la propia posición.
  return Mesh.fromArrays(name, positions, positions, faces);
}

