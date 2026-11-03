// =============================================================================
//  shaders/index.ts — Ensamblado de archivos .wgsl y mapeo de líneas de error.
// =============================================================================
//  ¿Por qué existe?
//    WGSL no tiene directiva `#include`. Para mantener el código del shader
//    modular y legible (common, geodesic, intersect, shading, trace), Vite
//    importa cada archivo `.wgsl` como cadena de texto (`?raw`) y aquí los
//    concatenamos registrando en qué línea empieza cada uno.
//
//    Cuando WebGPU compila el shader, `module.getCompilationInfo()` devuelve
//    números de línea del texto concatenado; `logShaderCompilation()` los
//    traduce de vuelta al nombre de archivo `.wgsl` y línea original (sección 11).
// =============================================================================
import commonWgsl from './common.wgsl?raw';
import geodesicWgsl from './geodesic.wgsl?raw';
import intersectWgsl from './intersect.wgsl?raw';
import presentWgsl from './present.wgsl?raw';
import shadingWgsl from './shading.wgsl?raw';
import traceWgsl from './trace.wgsl?raw';

export interface ShaderSourceMapEntry {
  file: string;
  startLine: number;
  lineCount: number;
}

export interface AssembledShader {
  code: string;
  entries: ShaderSourceMapEntry[];
}

function assemble(parts: [string, string][]): AssembledShader {
  const entries: ShaderSourceMapEntry[] = [];
  const chunks: string[] = [];
  let currentLine = 1;

  for (const [file, text] of parts) {
    const normalized = text.replace(/\r\n/g, '\n');
    const lineCount = normalized.split('\n').length;
    entries.push({ file, startLine: currentLine, lineCount });
    chunks.push(normalized);
    currentLine += lineCount;
  }
  return { code: chunks.join('\n'), entries };
}

/** Ensambla el compute shader (`trace`) concatenando sus 5 módulos WGSL. */
export function buildTraceShaderSource(): AssembledShader {
  return assemble([
    ['common.wgsl', commonWgsl],
    ['geodesic.wgsl', geodesicWgsl],
    ['intersect.wgsl', intersectWgsl],
    ['shading.wgsl', shadingWgsl],
    ['trace.wgsl', traceWgsl],
  ]);
}

/** Devuelve el shader de presentación (`vs` + `fs`). */
export function buildPresentShaderSource(): AssembledShader {
  return assemble([['present.wgsl', presentWgsl]]);
}

/** Traduce un número de línea global (1-based) al archivo `.wgsl` y su línea local. */
export function resolveShaderLine(
  shader: AssembledShader,
  globalLine: number,
): { file: string; line: number } {
  for (let i = shader.entries.length - 1; i >= 0; i--) {
    const e = shader.entries[i];
    if (globalLine >= e.startLine) {
      return { file: e.file, line: globalLine - e.startLine + 1 };
    }
  }
  return { file: shader.entries[0]?.file ?? 'shader.wgsl', line: globalLine };
}

/**
 * Consulta `module.getCompilationInfo()` e imprime en consola cualquier mensaje
 * con el archivo `.wgsl` y la línea original (requisito de la sección 11).
 */
export async function logShaderCompilation(
  module: GPUShaderModule,
  shader: AssembledShader,
  label: string,
): Promise<void> {
  const info = await module.getCompilationInfo();
  for (const msg of info.messages) {
    const loc = resolveShaderLine(shader, msg.lineNum);
    const text = `[WGSL ${label}] ${msg.type} en ${loc.file}:${loc.line}:${msg.linePos} — ${msg.message}`;
    if (msg.type === 'error') console.error(text);
    else if (msg.type === 'warning') console.warn(text);
    else console.info(text);
  }
}

