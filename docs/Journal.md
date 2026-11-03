## Oct 26:

Se hizo un proof of concept para ver si el proyecto en efecto era posible. Lo principal es que se usó un integrador RK4 para calcular la trayectoria de cada rayo. Se probaron otros integradores cómo RK45 pero este era demasiado lento para la precisión adicional que daba, la cual no era tan significativa a simple vista. Por eso, se decidió usar RK4.

## Nov 2:

Se implementó la primera versión del proyecto funcional. Un sistema solar básico con planetas y agujeros negros. Se usaron las estructuras de datos Grafo de Escena, BVH Linealizado y Ordenes de Morton para implementar todo el proyecto. 

El problema principal por ahora es que no corre muy rápido. Sí es capaz de generar la imagen en tiempo real a baja resolución, pero corre a máximo 10 FPS en mi computador con una tarjeta gráfica decente. El próximo objetivo es ver dónde se puede hacer que funcione más rápido y entender el código que ya ha sido escrito. 