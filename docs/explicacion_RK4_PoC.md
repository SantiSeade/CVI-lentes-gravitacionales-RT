# El integrador Runge-Kutta de 4.º orden (RK4) en el simulador de lentes gravitacionales

## 1. La idea en una frase

**RK4 es una forma de predecir dónde estará algo un instante después, cuando sabemos cómo cambia su movimiento en cada momento.** Es la herramienta que usa el simulador para dibujar la trayectoria curva de cada rayo de luz, paso a paso.

---

## 2. ¿Por qué necesitamos un integrador?

### 2.1 Luz recta: no hace falta

En un ray tracer normal, el rayo es una recta:

```
P(t) = O + t · D
```

`O` es el origen, `D` la dirección y `t` la distancia recorrida. Con esa fórmula puedes saltar directo a cualquier punto del rayo sin calcular lo que hay en medio.

### 2.2 Luz curva: no hay fórmula directa

Cerca de un agujero negro, la dirección de la luz **cambia en cada instante**, y cuánto cambia depende de dónde esté en ese momento. Es un círculo vicioso: para saber hacia dónde se curva necesitas saber dónde está, y para saber dónde está necesitas saber cómo se curvó antes.

La única salida práctica es **simular el viaje en pasos pequeños**:

1. Estoy en este punto, con esta dirección.
2. Calculo cómo me empuja la gravedad aquí.
3. Avanzo un pasito y actualizo mi posición y mi dirección.
4. Repito.

Hacer esto de forma cuidadosa y precisa se llama **integración numérica**. RK4 es una de las formas más usadas de hacerlo.

---

## 3. Lo que el integrador necesita saber: el estado del fotón

En cada instante el fotón se describe con dos vectores:

| Símbolo | Significado | 
|---|---|
| `P` | Posición (dónde está) |
| `V` | Velocidad (hacia dónde va) |

Y las reglas de cambio son solo dos:

```
dP/dt = V          → la posición cambia según la velocidad
dV/dt = a(P)       → la velocidad cambia según la aceleración
```

La aceleración `a(P)` es la que viene de la gravedad del agujero negro. En el proyecto es:

```
a(P) = -(3/2) · rs · h² · P / |P|⁵
```

Interpretación sencilla:

- **El signo menos** significa que empuja hacia el agujero negro.
- **`|P|⁵` en el denominador** hace que el empuje sea enorme cerca del agujero y casi nulo lejos.
- **`h²`** es el momento angular del fotón (`h = |P × V|`). Si el rayo apunta directo al centro, `h = 0` y no se curva. Si pasa rozando, `h` es grande y se curva mucho. Es constante durante todo el viaje, así que se calcula una sola vez.
- **`rs`** es el radio de Schwarzschild (en el código, `rs = 1`).

Todo lo que hace el integrador es: *dado `P` y `V` ahora, calcular `P` y `V` un instante `dt` después.*

---

## 4. El método más simple y por qué no basta: Euler

La idea más ingenua es suponer que durante todo el paso la aceleración **no cambia**:

```
P_nuevo = P + V · dt
V_nuevo = V + a(P) · dt
```

Es como conducir un auto mirando el volante solo al inicio de cada segundo: sigues recto con la dirección que tenías, y recién después corriges. Si el camino curva fuerte, te sales.

El problema: **el error se acumula**. Cada paso se equivoca un poquito, el siguiente parte de un punto ya equivocado, y tras cientos de pasos el rayo puede terminar en un lugar completamente distinto. Con Euler, la luz tiende a «escaparse» hacia afuera de la curva, y para evitarlo habría que usar pasos diminutos (y mucho cómputo).

---

## 5. La idea de RK4: probar el terreno antes de avanzar

RK4 resuelve el problema consultando la dirección del cambio **en cuatro puntos del paso** y quedándose con un promedio inteligente. Es como mirar el camino al inicio, dos veces en el medio y al final antes de decidir cómo girar.

Llamamos a esas cuatro lecturas `k1`, `k2`, `k3` y `k4` (cada una tiene una parte para la posición y otra para la velocidad):

| Lectura | ¿Dónde se mide? | ¿Cómo se estima ese punto? |
|---|---|---|
| `k1` | Al **inicio** del paso | Con el estado actual |
| `k2` | A la **mitad** del paso | Avanzando medio paso con la pendiente `k1` |
| `k3` | A la **mitad** del paso (otra vez) | Avanzando medio paso con la pendiente `k2`, que es una mejor estimación |
| `k4` | Al **final** del paso | Avanzando un paso completo con la pendiente `k3` |

Después se combinan con estos pesos:

```
nuevo = actual + (dt / 6) · ( k1 + 2·k2 + 2·k3 + k4 )
```

El **1-2-2-1** da más peso a las lecturas del medio, que suelen representar mejor el comportamiento promedio durante todo el paso (es una regla de Simpson aplicada a ecuaciones diferenciales).

### Un ejemplo con números

Para ver la diferencia, usemos un problema donde conocemos la respuesta exacta: `y' = y`, con `y(0) = 1`. La solución es `y(1) = e ≈ 2.718`. Damos **un solo paso** de tamaño 1:

- **Euler:** `y = 1 + 1·1 = 2.000` (error grande, ~26 %)
- **RK4:**
  - `k1 = 1`
  - `k2 = 1 + 0.5·1 = 1.5`
  - `k3 = 1 + 0.5·1.5 = 1.75`
  - `k4 = 1 + 1·1.75 = 2.75`
  - `y = 1 + (1 + 2·1.5 + 2·1.75 + 2.75)/6 = 1 + 10.25/6 ≈ 2.708`

Con un solo paso, RK4 queda a menos de 0.4 % del valor exacto, mientras que Euler se queda en 2.0. Lo que se paga es **evaluar la función 4 veces** en vez de 1.

---

## 6. RK4 aplicado al fotón, paso a paso

En nuestro caso las «lecturas» son pares: una para la posición y otra para la velocidad. Esto es lo que ocurre en `rk4_step()`:

```
k1p = V                         k1v = a(P)
k2p = V + ½·dt·k1v              k2v = a(P + ½·dt·k1p)
k3p = V + ½·dt·k2v              k3v = a(P + ½·dt·k2p)
k4p = V + dt·k3v                k4v = a(P + dt·k3p)

P_nuevo = P + (dt/6)·(k1p + 2·k2p + 2·k3p + k4p)
V_nuevo = V + (dt/6)·(k1v + 2·k2v + 2·k3v + k4v)
```

Cómo leerlo:

- Las **`kp`** responden «¿hacia dónde se movería la posición?». Siempre es alguna estimación de la velocidad.
- Las **`kv`** responden «¿cuánto cambiaría la velocidad?». Es la aceleración gravitacional evaluada en distintos puntos del paso.
- Cada nueva lectura **usa la anterior** para saber en qué punto del espacio evaluar la gravedad. Por eso el orden importa.

### El código real

```wgsl
struct State { p: vec3f, v: vec3f }

fn rk4_step(s: State, dt: f32, h2: f32) -> State {
  let k1p = s.v;
  let k1v = acceleration(s.p, h2);

  let k2p = s.v + 0.5 * dt * k1v;
  let k2v = acceleration(s.p + 0.5 * dt * k1p, h2);

  let k3p = s.v + 0.5 * dt * k2v;
  let k3v = acceleration(s.p + 0.5 * dt * k2p, h2);

  let k4p = s.v + dt * k3v;
  let k4v = acceleration(s.p + dt * k3p, h2);

  var out: State;
  out.p = s.p + (dt / 6.0) * (k1p + 2.0 * k2p + 2.0 * k3p + k4p);
  out.v = s.v + (dt / 6.0) * (k1v + 2.0 * k2v + 2.0 * k3v + k4v);
  return out;
}
```

Cada llamada a `acceleration()` calcula la fuerza gravitacional en un punto, así que **un paso RK4 cuesta 4 evaluaciones de la gravedad por rayo**.

---

## 7. Cómo encaja RK4 en el flujo de un rayo

Cada píxel de la imagen ejecuta este bucle dentro del compute shader:

```
estado inicial: P = posición de la cámara, V = dirección del píxel
h² = |P × V|²                           ← una sola vez

repetir hasta 500 veces:
    r = |P|
    si r < rs                → capturado por el agujero negro (negro)
    si r > 30 y se aleja     → escapó: color = fondo según la dirección de V
    dt = paso adaptativo (según r)
    siguiente = rk4_step(estado, dt, h²)
    si el segmento [P, siguiente.P] toca la esfera → color de la esfera
    estado = siguiente
```

Tres detalles importantes:

1. **El rayo curvo es una cadena de segmentos rectos.** RK4 nos da los vértices de esa cadena (`P0, P1, P2, ...`). Entre cada par de vértices consecutivos tratamos el camino como recto y probamos la colisión con la geometría. Mientras más pequeño sea `dt`, mejor se aproxima la curva real.
2. **La dirección final decide el fondo.** Si el rayo escapa, su velocidad `V` ya está curvada por la gravedad, y con ella se consulta el fondo. Por eso el cielo se ve deformado alrededor del agujero negro.
3. **`h²` no se recalcula.** Es una cantidad que se conserva en una trayectoria de este tipo, así que calcularla una vez ahorra operaciones.

---

## 8. El paso adaptativo: cuánto avanzar cada vez

Aunque RK4 es preciso, un paso demasiado grande en una zona muy curva sigue dando errores. Y un paso diminuto en todas partes sería un desperdicio. Por eso el tamaño del paso depende de qué tan cerca está el fotón del horizonte:

```wgsl
let dt = clamp(0.08 * (r - RS) + 0.01, 0.01, 0.5);
```

| Distancia `r` | Paso `dt` aproximado | Situación |
|---|---|---|
| 14 (la cámara) | 0.5 (máximo) | Espacio casi plano: pasos largos |
| 5 | ~0.33 | Curvatura moderada |
| 1.5 (esfera de fotones) | ~0.05 | Curvatura fuerte: pasos cortos |
| 1.1 (cerca del horizonte) | ~0.018 | Casi en el límite, mínimo cuidado |

Es la misma lógica que reducir la velocidad al entrar a una curva cerrada: en la recta aceleras, en la curva vas despacio.

### ¿Por qué importa la esfera de fotones?

A `r = 1.5·rs` la luz puede orbitar el agujero negro en círculo. Los rayos que pasan cerca de ese radio **dan varias vueltas** antes de escapar o caer, y son los que forman el anillo brillante alrededor de la sombra. Es la zona más exigente del simulador: cualquier error pequeño por paso grande se amplifica porque el rayo permanece mucho tiempo ahí. Por eso el paso se reduce justo en esa zona.

---

## 9. ¿Por qué RK4 y no otro método?

| Método | Evaluaciones por paso | Precisión | Comentario |
|---|---|---|---|
| Euler | 1 | Baja | Necesita pasos diminutos; la luz «se escapa» de la curva |
| Punto medio (RK2) | 2 | Media | Mejor, pero aún con deriva visible cerca del agujero |
| **RK4** | **4** | **Alta** | Buen equilibrio entre costo y exactitud; fácil de programar |
| RK45 / Dormand-Prince | 6+ | Muy alta | Ajusta su propio paso según el error estimado; más complejo |

RK4 cuesta 4 veces más por paso que Euler, pero su error disminuye muchísimo más rápido al achicar el paso, así que **con pasos más grandes logra mejor resultado**. En total, suele salir más barato llegar a una precisión dada con RK4 que con Euler. Además, para una GPU el código es sencillo: sin ramas complicadas ni memoria extra.

---

## 10. Cómo ajustar y comprobar el integrador

### Parámetros que puedes mover

| Parámetro | Efecto si lo aumentas | Efecto si lo disminuyes |
|---|---|---|
| `0.08` (factor de `dt`) | Menos pasos, más rápido, menos preciso | Más pasos, más lento, más preciso |
| `0.5` (`dt` máximo) | Lejos del agujero avanza más rápido | Avanza más lento en el espacio plano |
| `0.01` (`dt` mínimo) | Menos detalle cerca del horizonte | Más detalle, más costo |
| `MAX_STEPS` | Los rayos que giran mucho pueden terminar su recorrido | Esos rayos se cortan antes (píxeles negros) |

### Cómo saber si funciona bien

1. **Apaga la gravedad** (tecla `G`): la aceleración es 0, así que RK4 debe reproducir una línea recta exacta. El cielo debe verse sin deformar.
2. **Compara contra la deflexión conocida.** Para un rayo lejano que pasa a distancia `b` del centro, el ángulo total de desviación debe ser aproximadamente `2·rs/b`. Puedes medirlo en una prueba aparte (en JavaScript, sin GPU) integrando un rayo y comparando.
3. **Revisa que `h` se conserve.** A lo largo de un rayo, `|P × V|` debería mantenerse casi constante. Si se desvía mucho, los pasos son demasiado grandes.
4. **Busca artefactos visuales**: anillos con escalones, líneas discontinuas en el borde de la sombra o píxeles negros sueltos cerca de la esfera de fotones indican que el paso necesita ser más pequeño en esa zona.

---

## 11. Limitaciones conocidas

- **La velocidad no se mantiene exactamente en 1.** En esta formulación cartesiana, `|V|` puede desviarse muy levemente de 1 por el error numérico. Para el fondo solo importa la dirección (`normalize(V)`), así que no afecta la imagen, pero es un punto a vigilar si más adelante se calculan efectos relativistas (corrimiento al rojo).
- **El paso adaptativo es heurístico.** Se decide solo por la distancia al agujero, no midiendo el error real. Una versión más avanzada (RK45) estimaría el error en cada paso y lo ajustaría automáticamente.
- **Cada rayo hace un número distinto de pasos.** Los píxeles cerca de la sombra tardan mucho más que los que apuntan al espacio abierto. En la GPU, los hilos de un mismo grupo que terminan antes esperan a los más lentos; esto es normal en este tipo de simulación y es una razón más para ordenar los datos de forma coherente (Morton) y mantener el trabajo cercano agrupado.

---

## 12. Resumen

- El rayo curvo no tiene fórmula directa, así que se **simula paso a paso** con un integrador numérico.
- **RK4** consulta cómo actúa la gravedad en cuatro puntos de cada paso (`k1` a `k4`) y los promedia con pesos 1-2-2-1. Con ello logra buena precisión sin pasos diminutos.
- Cada paso actualiza **posición y velocidad** del fotón, y el resultado es una **cadena de segmentos rectos** que se prueban contra la geometría 3D.
- El **paso adaptativo** acorta `dt` cerca del agujero negro y lo alarga en el espacio plano, para gastar el cómputo donde importa.
- En el proyecto final, RK4 seguirá siendo el motor de la trayectoria. Lo que cambiará es **qué se prueba contra cada segmento**: de una esfera a un BVH de mallas de triángulos.