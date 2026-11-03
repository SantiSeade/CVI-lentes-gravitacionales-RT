// =============================================================================
//  sceneGraph.test.ts — Pruebas unitarias del grafo de escena y la geometría.
// =============================================================================
//  Verifica el criterio de la Fase 2 (sección 9 del enunciado):
//    1. Que una luna hereda la órbita de su planeta (jerarquía de 3 niveles).
//    2. Que todas las instancias del sistema solar comparten un único `meshId`
//       (la icosfera se sube una sola vez a la GPU).
//    3. Que `localFromWorld` es realmente la inversa de `worldFromLocal`.
//    4. Que la icosfera genera 20·4^s triángulos con vértices sobre la esfera unitaria.
// =============================================================================
import { mat4, vec3 } from 'gl-matrix';
import { describe, expect, it } from 'vitest';
import { createIcosphere } from '../src/geometry/primitives';
import { Orbit, SceneGraph, SceneNode, Spin } from '../src/scene/sceneGraph';
import { createSolarSystem } from '../src/scene/solarSystem';

describe('Geometría: icosfera (primitives.ts)', () => {
  it('produce exactamente 20·4^s triángulos y todos los vértices tienen radio 1', () => {
    const mesh = createIcosphere(3);
    expect(mesh.triangleCount).toBe(20 * 4 ** 3); // 1 280 triángulos
    for (let i = 0; i < mesh.vertexCount; i++) {
      const [x, y, z] = mesh.position(i);
      expect(Math.hypot(x, y, z)).toBeCloseTo(1.0, 5);
    }
    const bounds = mesh.computeBounds();
    expect(bounds.min[0]).toBeGreaterThanOrEqual(-1.0001);
    expect(bounds.max[0]).toBeLessThanOrEqual(1.0001);
  });
});

describe('Grafo de escena (sceneGraph.ts)', () => {
  it('una luna hereda la traslación orbital de su planeta y no su escala ni su giro propio', () => {
    const g = new SceneGraph();
    const meshId = g.addMesh(createIcosphere(1));

    // Planeta en órbita de radio 100 (periodo 40 s), con cuerpo de radio 10.
    const planetPivot = g.root.addChild(
      new SceneNode('planet-pivot', { animators: [new Orbit(100, 40, 0, 0)] }),
    );
    const planetBody = planetPivot.addChild(
      new SceneNode('planet', { scale: 10, meshId, animators: [new Spin(5)] }),
    );

    // Luna en órbita de radio 8 alrededor del pivote del planeta (periodo 16 s).
    const moonPivot = planetPivot.addChild(
      new SceneNode('moon-pivot', { animators: [new Orbit(8, 16, 0, 0)] }),
    );
    const moonBody = moonPivot.addChild(new SceneNode('moon', { scale: 2, meshId }));

    // En t = 0: planeta en (100, 0, 0) y luna en (100 + 8, 0, 0) = (108, 0, 0).
    g.update(0);
    expect(planetBody.worldPosition()[0]).toBeCloseTo(100, 5);
    expect(planetBody.worldPosition()[2]).toBeCloseTo(0, 5);
    expect(moonBody.worldPosition()[0]).toBeCloseTo(108, 5);
    expect(moonBody.worldPosition()[2]).toBeCloseTo(0, 5);

    // En t = 10 s (1/4 de órbita del planeta, 5/8 de órbita de la luna):
    //   planeta en (0, 0, 100)
    //   luna desplazada 8 unidades respecto al planeta.
    g.update(10);
    const pPos = planetBody.worldPosition();
    const mPos = moonBody.worldPosition();
    expect(pPos[0]).toBeCloseTo(0, 4);
    expect(pPos[2]).toBeCloseTo(100, 4);
    const distMoonToPlanet = Math.hypot(mPos[0] - pPos[0], mPos[1] - pPos[1], mPos[2] - pPos[2]);
    expect(distMoonToPlanet).toBeCloseTo(8.0, 4);
  });

  it('el sistema solar comparte un único meshId entre todas las instancias y calcula inversas exactas', () => {
    const scene = createSolarSystem({ icosphereSubdivisions: 2 });
    scene.graph.update(12.3);
    const instances = scene.graph.collectInstances();

    // Estrella + 6 planetas + 3 lunas = 10 instancias, pero solo 1 malla en GPU.
    expect(scene.graph.meshes.length).toBe(1);
    expect(instances.length).toBe(10);
    for (const inst of instances) {
      expect(inst.meshId).toBe(0);
      const prod = mat4.multiply(mat4.create(), inst.worldFromLocal, inst.localFromWorld);
      const p = vec3.transformMat4(vec3.create(), vec3.fromValues(1.5, -2.0, 0.7), prod);
      expect(p[0]).toBeCloseTo(1.5, 4);
      expect(p[1]).toBeCloseTo(-2.0, 4);
      expect(p[2]).toBeCloseTo(0.7, 4);
    }
  });
});

