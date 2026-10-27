# CVI-lentes-gravitacionales-RT

## Descripción inicial del proyecto del proyecto: 

La mayoría de los renders astronómicos actuales simulan curvas en los rayos de luz distorsionando imágenes detrás de objetos celestiales de gran masa. Realmente no calculan la traectoria que toman los rayos de luz al pasar cerca a estos objetos. La idea de este proyecto es hacer un ray tracer (posiblemente en tiempo real) que sea capaz de calcular las trayectorias de rayos de luz teniendo en cuenta deformaciones en el espacio tiempo causadas por objetos de gran masa, como lo son planetas, estrellas agujeros negros y posiblemente naves espaciales.

## Journal:
### 26/10/2026:
Se realizó un proof of concept para probar si en efecto era posible hacer un ray tracer que tomara en cuenta la curvatura del espacio. En esta iteración inicial se creó una estructura básica del proyecto. Un índice html con la página principal y la interactividad con la tecla g para prender y apagar los efectos gravitacionales.

La lógica del CPU se encuentra en el archivo main.js. Acá inicializa WebGPU, carga y compila el shader, crea buffers, etc. La lógica del GPU se encuentra en shader.wgsl. Acá se hacen los cálculos necesarios para cada rayo. Esta es la parte más esencial del proyecto.

**El flujo general en la GPU de este proof of concept se ve así:**

trace(): --> hilo por pixel
1. crea rayo desde la cámara.
2. Lo va curvando paso a paso con integrador runge-kutta. Se hace paso pequeño por cada rayo y después de cada paso este se curva ligeramente.
3. Prueba cad paso del rayo contra la esfera.
4. Calcula el color y lo guarda.
