// =============================================================================
//  solarSystem.ts — Definición de la escena inicial a gran escala.
// =============================================================================
//  ¿Qué construye este archivo?
//    La escena descrita en la sección 6 del enunciado, en unidades donde el
//    radio de Schwarzschild del agujero negro principal es `rs = 1`:
//
//      - 1 agujero negro principal en el origen (rs = 1.0).
//      - 1 segundo agujero negro compañero opcional en órbita (rs = 0.45),
//        para demostrar la aproximación multi-agujero negro de la sección 5.
//      - 1 estrella emisiva que ilumina la escena (y cuya luz también se curva).
//      - 6 planetas con radios entre 2.2 y 12 unidades, órbitas entre 18 y 210
//        unidades, distintas inclinaciones, velocidades y patrones procedurales.
//      - 3 lunas en jerarquía de tres niveles (raíz → pivote planeta → pivote
//        luna → cuerpo luna), que heredan automáticamente la órbita del planeta.
//
//    TODOS los cuerpos esféricos (estrella, 6 planetas y 3 lunas = 10 instancias)
//    comparten UNA SOLA malla `Mesh` (icosfera subdividida). Esa malla se sube
//    una única vez a la GPU.
//
//  TODO(ext): añadir cinturón de asteroides instanciado (cientos de instancias
//  compartiendo una malla irregular) y naves cargadas desde `.obj`.
// =============================================================================
import { createIcosphere } from '../geometry/primitives';
import { PATTERN_BANDS, PATTERN_NOISE, PATTERN_NONE } from './instances';
import { Orbit, SceneGraph, SceneNode, Spin } from './sceneGraph';

export interface SolarSystemScene {
  graph: SceneGraph;
  /** Nodo de la estrella emisiva (para consultar su posición de mundo y usarla como luz puntual). */
  starNode: SceneNode;
  /** Nodo del segundo agujero negro (se puede activar/desactivar en tiempo de ejecución). */
  secondaryBlackHoleNode: SceneNode;
  /** Radio característico de escape de la escena (unidades de rs). */
  escapeRadius: number;
}

export interface SolarSystemOptions {
  /** Subdivisiones de la icosfera compartida (4 → 5 120 triángulos por instancia). */
  icosphereSubdivisions?: number;
  /** Si true, el segundo agujero negro empieza activo. */
  enableSecondaryBlackHole?: boolean;
}

/**
 * Construye el grafo de escena completo del sistema planetario alrededor del
 * agujero negro.
 */
export function createSolarSystem(opts: SolarSystemOptions = {}): SolarSystemScene {
  const subdivisions = opts.icosphereSubdivisions ?? 4;
  const graph = new SceneGraph();

  // ---- ÚNICA malla compartida por todos los cuerpos esféricos ---------------
  const sphereMesh = createIcosphere(subdivisions, `planet-icosphere-s${subdivisions}`);
  const sphereMeshId = graph.addMesh(sphereMesh);

  // ---- Agujero negro principal en el origen (rs = 1) ------------------------
  graph.root.addChild(
    new SceneNode('primary-black-hole', {
      position: [0, 0, 0],
      blackHole: { rs: 1.0 },
    }),
  );

  // ---- Segundo agujero negro opcional en órbita (rs = 0.45) -----------------
  const secondaryBlackHoleNode = graph.root.addChild(
    new SceneNode('secondary-black-hole', {
      animators: [new Orbit(12.0, 28.0, 0.08, Math.PI * 0.75)],
      blackHole: { rs: 0.45 },
    }),
  );
  secondaryBlackHoleNode.enabled = opts.enableSecondaryBlackHole ?? false;

  // ---- Estrella emisiva (fuente de luz puntual) -----------------------------
  const matStar = graph.addMaterial({
    name: 'star-emissive',
    baseColor: [1.0, 0.92, 0.65],
    secondaryColor: [1.0, 0.65, 0.25],
    pattern: PATTERN_NOISE,
    patternScale: 4.0,
    emission: [1.0, 0.88, 0.55],
    emissionStrength: 1.35,
  });

  const starPivot = graph.root.addChild(
    new SceneNode('star-pivot', {
      animators: [new Orbit(65.0, 140.0, 0.12, 0.9)],
    }),
  );
  const starNode = starPivot.addChild(
    new SceneNode('helios-star', {
      scale: 6.5,
      meshId: sphereMeshId,
      materialId: matStar,
      animators: [new Spin(25.0)],
    }),
  );

  // ---- Helper: crea pivote orbital + cuerpo escalado con giro ---------------
  const addBody = (
    parent: SceneNode,
    name: string,
    radius: number,
    materialId: number,
    orbit: Orbit,
    spinPeriod: number,
    spinAxis: [number, number, number] = [0, 1, 0],
  ): SceneNode => {
    const pivot = parent.addChild(
      new SceneNode(`${name}-pivot`, {
        animators: [orbit],
      }),
    );
    pivot.addChild(
      new SceneNode(name, {
        scale: radius,
        meshId: sphereMeshId,
        materialId,
        animators: [new Spin(spinPeriod, spinAxis)],
      }),
    );
    return pivot;
  };

  // ---- Planeta 1: volcánico interior (muy cerca del horizonte: gran lente) --
  const matVulcan = graph.addMaterial({
    name: 'vulcan-lava',
    baseColor: [0.95, 0.32, 0.12],
    secondaryColor: [0.22, 0.12, 0.1],
    pattern: PATTERN_NOISE,
    patternScale: 5.0,
  });
  addBody(graph.root, 'vulcan', 2.2, matVulcan, new Orbit(18.0, 22.0, 0.04, 0.2), 9.0);

  // ---- Planeta 2: rocoso terráqueo + 1 luna ---------------------------------
  const matTerra = graph.addMaterial({
    name: 'terra-ocean',
    baseColor: [0.18, 0.48, 0.88],
    secondaryColor: [0.25, 0.68, 0.35],
    pattern: PATTERN_NOISE,
    patternScale: 3.5,
  });
  const matMoonGray = graph.addMaterial({
    name: 'moon-regolith',
    baseColor: [0.74, 0.73, 0.7],
    secondaryColor: [0.46, 0.45, 0.43],
    pattern: PATTERN_NOISE,
    patternScale: 6.0,
  });
  const terraPivot = addBody(
    graph.root,
    'terra',
    3.6,
    matTerra,
    new Orbit(34.0, 40.0, -0.06, 2.4),
    12.0,
    [0.15, 1, 0],
  );
  addBody(terraPivot, 'selene', 1.0, matMoonGray, new Orbit(7.2, 9.5, 0.18, 0.5), 9.5);

  // ---- Planeta 3: desértico rojizo ------------------------------------------
  const matAres = graph.addMaterial({
    name: 'ares-rust',
    baseColor: [0.86, 0.44, 0.24],
    secondaryColor: [0.58, 0.25, 0.14],
    pattern: PATTERN_BANDS,
    patternScale: 6.0,
  });
  addBody(graph.root, 'ares', 2.8, matAres, new Orbit(52.0, 62.0, 0.09, 4.1), 14.0);

  // ---- Planeta 4: gigante gaseoso con bandas + 2 lunas ----------------------
  const matJove = graph.addMaterial({
    name: 'jove-bands',
    baseColor: [0.9, 0.72, 0.5],
    secondaryColor: [0.68, 0.38, 0.22],
    pattern: PATTERN_BANDS,
    patternScale: 10.0,
  });
  const matIo = graph.addMaterial({
    name: 'io-sulfur',
    baseColor: [0.96, 0.82, 0.22],
    secondaryColor: [0.65, 0.28, 0.1],
    pattern: PATTERN_NOISE,
    patternScale: 5.0,
  });
  const matEuropa = graph.addMaterial({
    name: 'europa-ice',
    baseColor: [0.78, 0.88, 0.98],
    secondaryColor: [0.48, 0.62, 0.78],
    pattern: PATTERN_BANDS,
    patternScale: 7.0,
  });
  const jovePivot = addBody(
    graph.root,
    'jove',
    11.5,
    matJove,
    new Orbit(105.0, 110.0, -0.05, 3.14),
    8.0,
    [0.08, 1, 0.05],
  );
  addBody(jovePivot, 'io', 1.6, matIo, new Orbit(18.0, 11.0, 0.12, 1.1), 11.0);
  addBody(jovePivot, 'europa', 1.35, matEuropa, new Orbit(25.0, 18.0, -0.15, 3.7), 18.0);

  // ---- Planeta 5: gigante helado cian ---------------------------------------
  const matBoreas = graph.addMaterial({
    name: 'boreas-cyan',
    baseColor: [0.35, 0.82, 0.92],
    secondaryColor: [0.18, 0.52, 0.72],
    pattern: PATTERN_BANDS,
    patternScale: 8.0,
  });
  addBody(
    graph.root,
    'boreas',
    7.8,
    matBoreas,
    new Orbit(155.0, 175.0, 0.14, 5.2, 0.6),
    15.0,
    [0.35, 1, 0],
  );

  // ---- Planeta 6: mundo exterior violeta ------------------------------------
  const matNyx = graph.addMaterial({
    name: 'nyx-violet',
    baseColor: [0.62, 0.44, 0.88],
    secondaryColor: [0.32, 0.2, 0.52],
    pattern: PATTERN_NONE,
    patternScale: 1.0,
  });
  addBody(graph.root, 'nyx', 4.5, matNyx, new Orbit(210.0, 250.0, -0.19, 1.7, 1.2), 20.0);

  // Inicializar matrices en t = 0 para que la escena sea consultable de inmediato.
  graph.update(0);

  return {
    graph,
    starNode,
    secondaryBlackHoleNode,
    escapeRadius: 600.0,
  };
}

