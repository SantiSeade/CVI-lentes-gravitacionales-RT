// =============================================================================
//  vite.config.ts — Configuración de Vite (servidor de desarrollo) y Vitest.
// =============================================================================
//  - Vite sirve `index.html` y compila TypeScript al vuelo. Los shaders .wgsl se
//    importan como texto con el sufijo `?raw` (ver src/shaders/index.ts), así
//    que no hace falta ningún plugin adicional.
//  - Vitest reutiliza esta misma configuración; las pruebas corren en Node
//    (sin navegador ni GPU) porque solo prueban la lógica de CPU: Morton, BVH,
//    grafo de escena y el layout de memoria de los structs.
// =============================================================================
import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: {
    port: 5173,
  },
  build: {
    target: 'es2022',
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});

