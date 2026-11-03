# Física Relativista e Integradores Numéricos

Este documento explica el modelo físico empleado para curvar los rayos de luz alrededor de uno o varios agujeros negros de Schwarzschild, el esquema de integración numérica **RK4 con paso adaptativo**, la elección de escalas para la escena y la comparación frente a **RK45 Dormand-Prince**.

---

## 1. Ecuación geodésica nula en la métrica de Schwarzschild

En unidades geométricas donde el agujero negro principal tiene radio de Schwarzschild $r_s = \frac{2GM}{c^2} = 1$ y la velocidad de la luz es $c = 1$:

- El **horizonte de eventos** está en $r = r_s$. Cualquier fotón con $r \le r_s$ queda capturado (píxel negro).
- La **esfera de fotones** (órbitas circulares inestables de luz) se sitúa en $r = 1.5\,r_s$.
- El **parámetro de impacto crítico** que produce el anillo de Einstein y la sombra aparente del agujero negro es $b_c = \frac{3\sqrt{3}}{2}\,r_s \approx 2.598\,r_s$.

La ecuación orbital de Binet para un fotón en el plano de su órbita ($u = 1/r$) es:

$$
\frac{d^2 u}{d\varphi^2} + u = \frac{3}{2}\,r_s\,u^2
$$

Al pasar a coordenadas cartesianas 3D respecto al centro $C$ del agujero negro, con vector de posición relativo $\mathbf{r} = \mathbf{P} - \mathbf{C}$ y dirección del fotón $\mathbf{V}$ ($|\mathbf{V}| = 1$), el sistema de primer orden respecto al parámetro afín $t$ es:

$$
\frac{d\mathbf{P}}{dt} = \mathbf{V}, \qquad \frac{d\mathbf{V}}{dt} = \mathbf{a}(\mathbf{P}, \mathbf{V}) = -\frac{3}{2}\,r_s\,\frac{h^2}{|\mathbf{r}|^5}\,\mathbf{r}
$$

donde $h^2 = |\mathbf{r} \times \mathbf{V}|^2$ es el cuadrado del momento angular específico del fotón.

---

## 2. Caso de varios agujeros negros (aproximación por superposición)

En Relatividad General las ecuaciones de campo de Einstein son no lineales: dos agujeros negros cercanos no tienen una solución cerrada estática simple. Para permitir escenas interactivas con más de un agujero negro (por ejemplo activando el segundo agujero negro con la tecla **`2`**), en `src/shaders/geodesic.wgsl` (`photon_acceleration`) sumamos la contribución de cada agujero negro $i$:

$$
\mathbf{a}(\mathbf{P}, \mathbf{V}) \approx -\sum_{i=1}^{N_{\text{BH}}} \frac{3}{2}\,r_{s,i}\,\frac{|(\mathbf{P} - \mathbf{C}_i) \times \mathbf{V}|^2}{|\mathbf{P} - \mathbf{C}_i|^5}\,(\mathbf{P} - \mathbf{C}_i)
$$

- **Con 1 solo agujero negro ($N_{\text{BH}} = 1$):** $h^2 = |(\mathbf{P} - \mathbf{C}_1) \times \mathbf{V}|^2$ es una constante de movimiento exacta (porque $\mathbf{a}$ es central) y la fórmula es **matemáticamente idéntica** a la del PoC original.
- **Con varios agujeros negros ($N_{\text{BH}} > 1$):** el momento angular respecto a cada centro deja de conservarse, por lo que recalculamos $h_i^2$ en cada evaluación de RK4 a partir del estado actual $(\mathbf{P}, \mathbf{V})$. Es una aproximación físicamente razonable cuando los agujeros negros están separados varias veces su radio $r_s$.

---

## 3. Integrador RK4 y renormalización de la velocidad

El método clásico **Runge-Kutta de 4.º orden (RK4)** avanza el estado $S = (\mathbf{P}, \mathbf{V})$ un paso $\Delta t$ mediante cuatro evaluaciones de la derivada:

$$
\begin{aligned}
k_1 &= f(S_n), \\
k_2 &= f\!\left(S_n + \tfrac{1}{2}\Delta t\,k_1\right), \\
k_3 &= f\!\left(S_n + \tfrac{1}{2}\Delta t\,k_2\right), \\
k_4 &= f\!\left(S_n + \Delta t\,k_3\right), \\
S_{n+1} &= S_n + \frac{\Delta t}{6}\,(k_1 + 2k_2 + 2k_3 + k_4).
\end{aligned}
$$

Tras cada paso renormalizamos $\mathbf{V}_{n+1} \leftarrow \frac{\mathbf{V}_{n+1}}{|\mathbf{V}_{n+1}|}$ en `integrate_step` (`src/shaders/geodesic.wgsl`). Esto mantiene $|\mathbf{V}| = 1$ tras cientos de pasos sin alterar la dirección del rayo y garantiza que el parámetro $\Delta t$ siga midiendo longitud de arco espacial.

---

## 4. Paso adaptativo por distancia y elección de escala

En esta versión la escena tiene un radio de escape `ESCAPE_R = 600` unidades ($20\times$ mayor que el PoC, donde era `30`). Si usáramos el tope fijo $\Delta t_{\max} = 0.5$ del PoC, un rayo necesitaría más de 1 200 pasos solo para cruzar el sistema solar.

Por eso definimos en `adaptive_step_size` (`src/shaders/geodesic.wgsl`):

$$
\Delta t = \operatorname{clamp}\!\Big(K\,(d - r_s) + \Delta t_{\min},\; \Delta t_{\min},\; \min(\alpha_{\text{rel}}\,d,\; \Delta t_{\max,\text{abs}})\Big)
$$

con los valores por defecto (`src/ui/controls.ts`):
- $K = 0.08$ (ajustable en vivo con `[` y `]`).
- $\Delta t_{\min} = 0.015$: cerca del horizonte ($d \approx r_s$) y de la esfera de fotones ($d = 1.5\,r_s$) el paso es minúsculo para resolver las órbitas casi circulares sin atravesar el horizonte por error numérico.
- $\alpha_{\text{rel}} = 0.16$ y $\Delta t_{\max,\text{abs}} = 5.0$: lejos del agujero negro el paso crece hasta 5 unidades (donde el espacio es prácticamente plano), permitiendo cruzar los 600 radios de Schwarzschild en ~150 pasos.

---

## 5. Comparación: RK4 (paso heurístico) vs RK45 Dormand-Prince (control de error)

| Criterio | RK4 con paso por distancia (implementado) | RK45 Dormand-Prince con FSAL (`TODO(ext)`) |
|---|---|---|
| **Evaluaciones de $\mathbf{a}$ por paso** | **4** fijas (coste 100 % predecible) | **6** por intento (7 etapas, pero la última se reutiliza como primera del siguiente paso gracias a FSAL); más si el paso se rechaza |
| **Orden de error local / global** | $\mathcal{O}(\Delta t^5)$ local, $\mathcal{O}(\Delta t^4)$ global | Par embebido de 5.º y 4.º orden: estima el error local $\varepsilon = \|S^{(5)} - S^{(4)}\|$ en cada paso |
| **Divergencia de hilos en GPU (SIMT)** | **Baja:** todos los rayos cercanos toman pasos parecidos y ejecutan exactamente 4 evaluaciones por iteración | **Alta:** si un solo hilo del *workgroup* rechaza un paso cerca de la esfera de fotones, los otros 63 hilos esperan |
| **Cuándo conviene cada uno** | **Tiempo real en GPU** con intersección BVH por cada micro-segmento (menos pasos = menos recorridos del BVH) | Validación offline de referencia o escenas sin geometría 3D densa donde prima la cota estricta de error |

