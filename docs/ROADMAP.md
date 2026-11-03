# Roadmap y Puntos de Extensión (`TODO(ext)`)

Este documento enumera las extensiones previstas para la versión final del proyecto y enlaza cada una con el punto exacto del código donde se dejó preparada la interfaz (`// TODO(ext):`).

---

## 1. Tabla de puntos de extensión en el código

| Extensión | Archivo y ubicación del `TODO(ext)` | Cómo se conecta con lo ya implementado |
|---|---|---|
| **Carga de modelos `.obj` (naves y asteroides)** | `src/geometry/objLoader.ts` (`parseObj`, `loadObj`) | `parseObj` debe devolver un `Mesh.fromArrays(name, positions, normals, indices)`. Al registrarlo con `graph.addMesh(mesh)`, `packStaticGeometry` en `src/gpu/buffers.ts` construye automáticamente su BLAS con Morton y lo empaqueta junto a la icosfera usando la tabla `MeshInfo`. |
| **Cinturón de asteroides con instanciación masiva y naves** | `src/scene/solarSystem.ts` y `src/scene/sceneGraph.ts` (`Animator`) | El sistema de instancias (`Instance` + `TLAS`) ya soporta cientos de instancias compartiendo el mismo `meshId`. Basta añadir nodos hijos con `Orbit` al grafo de escena (y, si supera 256 instancias, subir `maxInstancesCapacity` en `createSceneBuffers`). |
| **Integrador RK45 Dormand-Prince intercambiable** | `src/shaders/geodesic.wgsl` (`integrate_step`) | El compute shader `trace.wgsl` solo invoca `integrate_step(s, dt)`. Se puede añadir una bandera o constante para alternar entre RK4 y el paso adaptativo Dormand-Prince con FSAL para comparar precisión y FPS en el informe. |
| **Sombras curvas gravitacionales** | `src/shaders/shading.wgsl` (`shade_surface`) | Actualmente `shade_surface` calcula la iluminación Lambert con la dirección recta hacia `frame.light_pos`. Para sombras curvas, desde `hit.world_pos` se integran rayos secundarios hacia la estrella comprobando si caen en el horizonte o chocan con otro planeta en el TLAS/BLAS. |
| **Disco de acreción relativista (Doppler + redshift)** | `src/shaders/shading.wgsl` y `src/shaders/trace.wgsl` | En cada micro-segmento $[p_0, p_1]$ se puede probar el cruce con el plano ecuatorial $y = 0$ en el anillo $r \in [3\,r_s, 14\,r_s]$ y acumular emisión con corrimiento al rojo gravitacional $\sqrt{1 - r_s/r}$ y Doppler relativista por la velocidad kepleriana del gas. |

---

## 2. Orden recomendado para la siguiente iteración

1. **Implementar `parseObj` en `src/geometry/objLoader.ts`** con una prueba unitaria que cargue un cubo/tetraedro en texto y verifique su BLAS.
2. **Añadir un cinturón de 150–300 asteroides instanciados** en `src/scene/solarSystem.ts` para demostrar cómo el TLAS + instanciación mantiene tiempos de fotograma interactivos con cientos de objetos en movimiento.
3. **Añadir el disco de acreción semitransparente** alrededor del agujero negro principal.
4. **Incorporar RK45 como modo opcional** para generar las tablas comparativas de rendimiento/error del informe final.

