# Simulador en Tiempo Real de Lentes Gravitacionales con WebGPU

Motor gráfico en tiempo real desarrollado para la asignatura de **Computación Visual** que simula **lentes gravitacionales** bajo la métrica de Schwarzschild en **WebGPU / WGSL**. A diferencia de las demos que solo distorsionan una textura de fondo, aquí los rayos de luz se integran numéricamente con **RK4 de paso adaptativo** y cada micro-segmento del rayo curvo se intersecta contra **mallas de triángulos 3D reales** (estrella, planetas y lunas en órbita) aceleradas mediante un **BVH linealizado de dos niveles (TLAS + BLAS)** construido con **códigos de Morton (orden Z)**.

---

## Requisitos del navegador

- **Chrome 113+** o **Edge 113+** (o Firefox Nightly / Safari con soporte WebGPU habilitado).
- **Node.js 20+** y `npm` para ejecutar el servidor de desarrollo y las pruebas unitarias.

---

## Instalación y ejecución

```bash
# 1. Instalar dependencias
npm install

# 2. Iniciar el servidor de desarrollo (Vite)
npm run dev

# 3. Ejecutar la batería de pruebas unitarias (Morton, Grafo de escena, BVH y layouts WGSL)
npm test

# 4. Verificar tipos TypeScript y compilar para producción
npm run build
```

Al correr `npm run dev`, abre la URL que muestra Vite en la terminal (por defecto `http://localhost:5173`).

---

## Controles e interacción en tiempo real

| Entrada | Acción |
|---|---|
| **Arrastrar ratón** | Orbitar la cámara alrededor del agujero negro |
| **Rueda del ratón** | Acercar / alejar la cámara |
| **`G`** | Alternar gravedad **ON (espacio curvo)** / **OFF (luz recta)** |
| **`Espacio`** | Pausar / reanudar el tiempo orbital de la escena |
| **`B`** | Alternar **BVH de dos niveles (TLAS + BLAS)** / **Fuerza bruta** |
| **`M`** | Alternar disposición **Morton 2D (orden Z)** / **Lineal** para los hilos y el buffer de imagen |
| **`H`** | Ciclar vista: **Normal** → **Mapa de calor de pasos RK4** → **Mapa de calor de nodos BVH visitados** |
| **`[` y `]`** | Disminuir / aumentar el factor `K` del paso adaptativo (más precisión vs más velocidad) |
| **`2`** | Activar / desactivar un **segundo agujero negro** en órbita |

---

## Documentación técnica

- [`docs/ARQUITECTURA.md`](./docs/ARQUITECTURA.md): flujo completo CPU → GPU, presupuesto de buffers WebGPU y responsabilidades por módulo.
- [`docs/ESTRUCTURAS_DE_DATOS.md`](./docs/ESTRUCTURAS_DE_DATOS.md): grafo de escena con instanciación, mallas IFS, códigos de Morton 2D/3D y layout exacto en bytes del BVH de dos niveles.
- [`docs/FISICA_E_INTEGRADORES.md`](./docs/FISICA_E_INTEGRADORES.md): derivación de la aceleración geodésica, RK4 con paso adaptativo, aproximación multi-agujero negro y comparativa frente a RK45 Dormand-Prince.
- [`docs/ROADMAP.md`](./docs/ROADMAP.md): extensiones futuras y puntos `TODO(ext)` preparados en el código.
- [`docs/explicacion_RK4_PoC.md`](./docs/explicacion_RK4_PoC.md): explicación divulgativa del integrador RK4 del Proof of Concept inicial (conservado en `poc-lente-gravitacional/`).
