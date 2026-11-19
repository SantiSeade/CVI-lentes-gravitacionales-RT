## Oct 26:

Se hizo un proof of concept para ver si el proyecto en efecto era posible. Lo principal es que se usó un integrador RK4 para calcular la trayectoria de cada rayo. Se probaron otros integradores cómo RK45 pero este era demasiado lento para la precisión adicional que daba, la cual no era tan significativa a simple vista. Por eso, se decidió usar RK4.

## Nov 2:

Se implementó la primera versión del proyecto funcional. Un sistema solar básico con planetas y agujeros negros. Se usaron las estructuras de datos Grafo de Escena, BVH Linealizado y Ordenes de Morton para implementar todo el proyecto.

El problema principal por ahora es que no corre muy rápido. Sí es capaz de generar la imagen en tiempo real a baja resolución, pero corre a máximo 10 FPS en mi computador con una tarjeta gráfica decente. El próximo objetivo es ver dónde se puede hacer que funcione más rápido y entender el código que ya ha sido escrito.

## Nov 12:

Se discutió con el profesor y se mostraron avances en el proyecto. Se quiere buscar una mejor manera de mostrar la forma en la que los rayos se doblan por el agujero negro. Se propuso usar luces tipo spotlight de colores diferentes para ver como interactúan los rayor y donde se mezclan. Revisar el tema de las fuentes de luz.

También se puede ver si es posible hacer algún tipo de ilustración de los rayos al darle click a un objeto para entender por qué se ve de cierta forma.

Estado del proyecto:

<img width="1917" height="856" alt="Screenshot 2026-11-12 160638" src="https://github.com/user-attachments/assets/0ffd8369-54af-49e5-835b-b87eb310378a" />

## Nov 18

Se agregó la opción de quitar el fondo con las estrellas y las líneas para poder ver mejor las distorsión de los planetas.

Se agregaron 3 fuentes de luz (RGB respectivamente) tipo spotlight. Se puede controlar su ángulo de dispersión de luz y si los rayos son paralelos o salen de manera radial. Ayuda a ver un poco mejor la manera en la que se mezclan los colores.

Estado del proyecto:

<img width="1902" height="841" alt="image" src="https://github.com/user-attachments/assets/2199327f-abb1-449c-b4f1-15586542a7f5" />

