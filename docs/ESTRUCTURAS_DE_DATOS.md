# Estructuras de Datos del Proyecto

Este documento detalla las tres estructuras de datos centrales del proyecto, el problema que resuelve cada una, su **layout exacto en memoria** (bytes, offsets y alineamientos WGSL) y cómo medir experimentalmente su beneficio desde la interfaz del simulador.

---

## 1. Grafo de Escena con Instanciación (DAG de mallas) y Mallas IFS

### 1.1 Problema que resuelve

- **Jerarquía de movimiento:** en un sistema planetario, las lunas orbitan a sus planetas mientras estos orbitan alrededor del agujero negro. El grafo de escena calcula cada matriz de mundo como $M_{\text{mundo}}(\text{hijo}) = M_{\text{mundo}}(\text{padre}) \cdot M_{\text{local}}(\text{hijo})$.
- **Ahorro de memoria por instanciación:** la estrella, los 6 planetas y las 3 lunas (10 objetos esféricos) comparten **una única malla de icosfera** (`meshId = 0`, 5 120 triángulos). La geometría y su BLAS se suben a la GPU **una sola vez**; cada nuevo cuerpo solo cuesta **144 bytes** en el buffer de instancias.

### 1.2 Layout de `Vertex` (Indexed Face Set, 32 bytes, alineamiento 16 B)

Definido en `src/geometry/mesh.ts`, `src/gpu/layouts.ts` y `src/shaders/common.wgsl`:

| Offset (B) | Campo | Tipo WGSL | Tamaño (B) | Descripción |
|---:|---|---|---:|---|
| 0 | `position` | `vec4f` | 16 | `xyz` = posición en espacio local, `w = 1.0` (relleno de alineamiento) |
| 16 | `normal` | `vec4f` | 16 | `xyz` = normal unitaria en espacio local, `w = 0.0` (relleno) |

Los triángulos se almacenan en `indices: array<u32>` (3 enteros de 4 bytes por triángulo = 12 B/triángulo), ya reordenados según las hojas del BLAS.

### 1.3 Layout de `MeshInfo` (16 bytes, alineamiento 4 B)

Permite almacenar varias mallas distintas concatenadas en los mismos buffers globales:

| Offset (B) | Campo | Tipo WGSL | Tamaño (B) | Descripción |
|---:|---|---|---:|---|
| 0 | `vertex_offset` | `u32` | 4 | Primer vértice de esta malla en `vertices` |
| 4 | `triangle_offset` | `u32` | 4 | Primer triángulo de esta malla en `indices` (en unidades de triángulos) |
| 8 | `blas_offset` | `u32` | 4 | Índice del nodo raíz de esta malla en `blas_nodes` |
| 12 | `triangle_count` | `u32` | 4 | Número total de triángulos de la malla |

### 1.4 Layout de `Instance` (144 bytes, alineamiento 16 B)

| Offset (B) | Campo | Tipo WGSL | Tamaño (B) | Descripción |
|---:|---|---|---:|---|
| 0 | `world_from_local` | `mat4x4f` | 64 | Transformación afín de espacio local a mundo |
| 64 | `local_from_world` | `mat4x4f` | 64 | Inversa precalculada en CPU (mundo → local) |
| 128 | `mesh_id` | `u32` | 4 | Índice en `mesh_infos` |
| 132 | `material_id` | `u32` | 4 | Índice en `materials` |
| 136 | `_pad0` | `u32` | 4 | Relleno explícito a múltiplo de 16 B |
| 140 | `_pad1` | `u32` | 4 | Relleno explícito a múltiplo de 16 B |

---

## 2. Código de Morton (Curva de Orden Z en 2D y 3D)

### 2.1 Problema que resuelve

- **Uso 1 — Construcción del BVH en 3D (`morton3D`):** cada centroide de triángulo se normaliza a $[0, 1023]^3$ dentro de la AABB de la malla y se intercalan sus bits en un entero de 30 bits (`z₉y₉x₉...z₀y₀x₀`). Al ordenar los triángulos por este código antes de construir el árbol, los triángulos próximos en el espacio quedan contiguos en memoria y las cajas del BVH resultan compactas.
- **Uso 2 — Coherencia de rayos e imagen en 2D (`morton2D`):** cuando la bandera `M` está activa, cada workgroup de 64 hilos procesa un bloque de $8\times 8$ píxeles siguiendo el orden Z 2D y escribe en posiciones consecutivas del buffer `image`. Así los rayos vecinos (que sufren deflexiones gravitacionales casi idénticas y visitan los mismos nodos del BVH) se ejecutan juntos en la misma *wavefront/warp* de la GPU.

### 2.2 Cómo medir su beneficio

- Pulsa la tecla **`M`** en tiempo de ejecución para alternar entre indexación **Morton 2D (orden Z)** e indexación **lineal por filas** y compara los `FPS` y `ms/frame` en el panel superior izquierdo.

---

## 3. BVH Linealizado de Dos Niveles (TLAS + BLAS)

### 3.1 Problema que resuelve

Cada rayo curvo se descompone en hasta `MAX_STEPS = 450` micro-segmentos rectos. Con 10 instancias de 5 120 triángulos (51 200 triángulos en escena), probar cada micro-segmento por fuerza bruta requeriría hasta $450 \times 51\,200 \approx 2.3 \times 10^7$ pruebas rayo-triángulo **por píxel**.

El BVH de dos niveles reduce esa búsqueda a dos árboles binarios:
1. **TLAS (Top-Level Acceleration Structure, dinámico):** construido cada fotograma en CPU sobre las AABB de mundo de las 10 instancias (~19 nodos).
2. **BLAS (Bottom-Level Acceleration Structure, estático):** construido una sola vez sobre los 5 120 triángulos de la icosfera (~5 119 nodos con hojas de hasta 2 triángulos).

### 3.2 Layout de `BvhNode` (32 bytes, alineamiento 16 B)

Idéntico para `blas_nodes` y `tlas_nodes`, almacenado en pre-orden (depth-first):

| Offset (B) | Campo | Tipo WGSL | Tamaño (B) | Descripción |
|---:|---|---|---:|---|
| 0 | `aabb_min` | `vec3f` | 12 | Esquina mínima $(x_{\min}, y_{\min}, z_{\min})$ de la caja |
| 12 | `right_or_first` | `u32` | 4 | Si `count == 0`: índice del hijo derecho; si `count > 0`: índice de la 1.ª primitiva |
| 16 | `aabb_max` | `vec3f` | 12 | Esquina máxima $(x_{\max}, y_{\max}, z_{\max})$ de la caja |
| 28 | `count` | `u32` | 4 | `0` = nodo interno (hijo izquierdo implícito en `nodo + 1`); `> 0` = hoja con `count` primitivas |

### 3.3 Cómo medir su beneficio

1. **Comparación directa de rendimiento e igualdad de imagen:** pulsa **`B`** para alternar entre **BVH (TLAS+BLAS)** y **Fuerza bruta**. La imagen producida es idéntica píxel a píxel, mientras que el coste por fotograma cae drásticamente con el BVH activo.
2. **Mapa de calor de nodos visitados:** pulsa **`H`** dos veces hasta activar **`Calor: nodos BVH`** para visualizar en falso color cuántas cajas/triángulos prueba cada píxel.

