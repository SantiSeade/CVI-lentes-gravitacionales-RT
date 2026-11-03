// =============================================================================
//  sceneGraph.ts — Grafo de escena jerárquico con instanciación y animadores.
// =============================================================================
//  ¿Qué problema resuelve?
//    En un sistema solar, una luna gira alrededor de su planeta, que a su vez
//    gira alrededor de la estrella. Si guardáramos la posición absoluta de cada
//    cuerpo tendríamos que recalcular a mano todas esas composiciones. Con un
//    GRAFO DE ESCENA cada nodo guarda solo su transformación RELATIVA al padre
//    (transformación local) y la de mundo se obtiene multiplicando hacia abajo:
//
//        mundo(nodo) = mundo(padre) · local(nodo)
//
//    Así, la luna "hereda" automáticamente el movimiento de su planeta.
//
//  Instanciación (DAG de mallas):
//    Los nodos no contienen la malla, solo un `meshId` (índice en
//    `SceneGraph.meshes`). Muchos nodos pueden apuntar a la misma malla: el
//    árbol de nodos es un árbol, pero el grafo nodo→malla es un DAG. La malla
//    se sube a la GPU una sola vez (ver gpu/buffers.ts → packGeometry).
//
//  Patrón "pivote + cuerpo":
//    Un planeta se modela con DOS nodos: un pivote con el animador `Orbit`
//    (posición) y un hijo "cuerpo" con la malla, la escala (radio) y `Spin`.
//    Las lunas cuelgan del PIVOTE, no del cuerpo: así heredan la órbita del
//    planeta pero no su escala ni su giro propio (si colgaran del cuerpo, una
//    luna de un planeta de radio 10 orbitaría 10 veces más lejos y giraría
//    con la rotación del planeta).
//
//  Estructura del proyecto que implementa: "Grafo de escena (CPU)", 4.1.
// =============================================================================
import { mat4, quat, vec3 } from 'gl-matrix';
import type { Mesh, Vec3 } from '../geometry/mesh';
import type { Instance, MaterialDesc } from './instances';

/** Transformación local de un nodo: T · R · S. */
export interface Transform {
  position: vec3;
  rotation: quat;
  scale: vec3;
}

/**
 * Un animador modifica la transformación LOCAL de su nodo en función del
 * tiempo. Es una función pura del tiempo (no acumula estado), así que pausar,
 * retroceder o probar un instante concreto es trivial y reproducible.
 *
 * Para añadir un animador nuevo basta implementar esta interfaz.
 * TODO(ext): animadores de trayectoria para naves (splines, keyframes).
 */
export interface Animator {
  readonly kind: string;
  apply(node: SceneNode, time: number): void;
}

/**
 * Órbita circular alrededor del origen del PADRE.
 *
 *   ángulo(t) = fase + 2π · t / periodo
 *   posición  = R_y(nodoAscendente) · R_x(inclinación) · (r·cos θ, 0, r·sin θ)
 *
 * La órbita base está en el plano XZ; la inclinación la ladea alrededor del
 * eje X y `ascendingNode` gira ese ladeo alrededor del eje Y.
 */
export class Orbit implements Animator {
  readonly kind = 'orbit';
  constructor(
    public radius: number,
    public period: number,
    public inclination = 0,
    public phase = 0,
    public ascendingNode = 0,
  ) {}

  angleAt(time: number): number {
    return this.phase + (2 * Math.PI * time) / this.period;
  }

  /** Posición en el espacio del padre en el instante `time`. */
  positionAt(time: number): Vec3 {
    const a = this.angleAt(time);
    const x = this.radius * Math.cos(a);
    const z0 = this.radius * Math.sin(a);
    // Inclinación: rotar (x, 0, z0) alrededor del eje X.
    const y = -z0 * Math.sin(this.inclination);
    const z = z0 * Math.cos(this.inclination);
    // Nodo ascendente: rotar alrededor del eje Y.
    const c = Math.cos(this.ascendingNode), s = Math.sin(this.ascendingNode);
    return [c * x + s * z, y, -s * x + c * z];
  }

  apply(node: SceneNode, time: number): void {
    const p = this.positionAt(time);
    vec3.set(node.transform.position, p[0], p[1], p[2]);
  }
}

/** Rotación del nodo sobre su propio eje (giro diario de un planeta). */
export class Spin implements Animator {
  readonly kind = 'spin';
  private readonly axis: vec3;
  constructor(
    public period: number,
    axis: Vec3 = [0, 1, 0],
    public phase = 0,
  ) {
    this.axis = vec3.normalize(vec3.create(), vec3.fromValues(axis[0], axis[1], axis[2]));
  }

  apply(node: SceneNode, time: number): void {
    quat.setAxisAngle(node.transform.rotation, this.axis, this.phase + (2 * Math.PI * time) / this.period);
  }
}

/** Componente de agujero negro: el nodo aporta un agujero negro en su posición de mundo. */
export interface BlackHoleComponent {
  /** Radio de Schwarzschild (horizonte de eventos). */
  rs: number;
}

/** Agujero negro ya resuelto en coordenadas de mundo (entrada del integrador). */
export interface BlackHoleInstance {
  name: string;
  position: Vec3;
  rs: number;
}

export interface SceneNodeOptions {
  position?: Vec3;
  scale?: number | Vec3;
  meshId?: number;
  materialId?: number;
  animators?: Animator[];
  blackHole?: BlackHoleComponent;
}

export class SceneNode {
  readonly transform: Transform = { position: vec3.create(), rotation: quat.create(), scale: vec3.fromValues(1, 1, 1) };
  readonly children: SceneNode[] = [];
  parent: SceneNode | null = null;
  meshId: number | null = null;
  materialId: number | null = null;
  blackHole: BlackHoleComponent | null = null;
  animators: Animator[] = [];
  /** Si es false, el nodo y todo su subárbol se ignoran (no se actualizan ni se recolectan). */
  enabled = true;
  /** local = T·R·S (se recalcula en update). */
  readonly localMatrix: mat4 = mat4.create();
  /** mundo = mundo(padre) · local (se recalcula en update). */
  readonly worldMatrix: mat4 = mat4.create();

  constructor(
    readonly name: string,
    opts: SceneNodeOptions = {},
  ) {
    if (opts.position) vec3.set(this.transform.position, ...opts.position);
    if (opts.scale !== undefined) {
      const s = typeof opts.scale === 'number' ? [opts.scale, opts.scale, opts.scale] : opts.scale;
      vec3.set(this.transform.scale, s[0], s[1], s[2]);
    }
    this.meshId = opts.meshId ?? null;
    this.materialId = opts.materialId ?? null;
    this.animators = opts.animators ?? [];
    this.blackHole = opts.blackHole ?? null;
  }

  addChild<T extends SceneNode>(child: T): T {
    if (child.parent) throw new Error(`El nodo "${child.name}" ya tiene padre.`);
    child.parent = this;
    this.children.push(child);
    return child;
  }

  /** Posición de mundo (columna de traslación de worldMatrix). Válida tras update(). */
  worldPosition(): Vec3 {
    return [this.worldMatrix[12], this.worldMatrix[13], this.worldMatrix[14]];
  }
}

export class SceneGraph {
  readonly root = new SceneNode('root');
  /** Registro de mallas únicas. meshId = índice en este arreglo. */
  readonly meshes: Mesh[] = [];
  /** Registro de materiales. materialId = índice en este arreglo. */
  readonly materials: MaterialDesc[] = [];

  /** Registra una malla (una sola vez aunque se llame varias veces) y devuelve su id. */
  addMesh(mesh: Mesh): number {
    const existing = this.meshes.indexOf(mesh);
    if (existing >= 0) return existing;
    this.meshes.push(mesh);
    return this.meshes.length - 1;
  }

  addMaterial(material: MaterialDesc): number {
    this.materials.push(material);
    return this.materials.length - 1;
  }

  /** Recorrido en profundidad (pre-orden) de los nodos habilitados. */
  traverse(visit: (node: SceneNode) => void, node: SceneNode = this.root): void {
    if (!node.enabled) return;
    visit(node);
    for (const c of node.children) this.traverse(visit, c);
  }

  /** Busca un nodo por nombre (incluye nodos deshabilitados). */
  find(name: string, node: SceneNode = this.root): SceneNode | null {
    if (node.name === name) return node;
    for (const c of node.children) {
      const r = this.find(name, c);
      if (r) return r;
    }
    return null;
  }

  /**
   * Avanza la escena al instante `time`:
   *   1. cada animador escribe la parte que controla de la transformación local;
   *   2. local = T · R · S;
   *   3. mundo = mundo(padre) · local, de la raíz hacia las hojas.
   *
   * El orden padre→hijo garantiza que cuando calculamos un hijo, la matriz de
   * mundo del padre ya es la de ESTE fotograma.
   */
  update(time: number): void {
    const visit = (node: SceneNode, parentWorld: mat4 | null): void => {
      if (!node.enabled) return;
      for (const a of node.animators) a.apply(node, time);
      const t = node.transform;
      mat4.fromRotationTranslationScale(node.localMatrix, t.rotation, t.position, t.scale);
      if (parentWorld) mat4.multiply(node.worldMatrix, parentWorld, node.localMatrix);
      else mat4.copy(node.worldMatrix, node.localMatrix);
      for (const c of node.children) visit(c, node.worldMatrix);
    };
    visit(this.root, null);
  }

  /**
   * Aplana el árbol a una lista de instancias (solo nodos con malla).
   * Calcula aquí la inversa `localFromWorld` (una vez por instancia y fotograma).
   */
  collectInstances(): Instance[] {
    const out: Instance[] = [];
    this.traverse((node) => {
      if (node.meshId === null) return;
      const localFromWorld = mat4.create();
      if (!mat4.invert(localFromWorld, node.worldMatrix)) {
        throw new Error(`La matriz de mundo de "${node.name}" no es invertible (¿escala 0?).`);
      }
      out.push({
        name: node.name,
        worldFromLocal: mat4.clone(node.worldMatrix),
        localFromWorld,
        meshId: node.meshId,
        materialId: node.materialId ?? 0,
      });
    });
    return out;
  }

  /** Agujeros negros habilitados, en coordenadas de mundo. */
  collectBlackHoles(): BlackHoleInstance[] {
    const out: BlackHoleInstance[] = [];
    this.traverse((node) => {
      if (node.blackHole) out.push({ name: node.name, position: node.worldPosition(), rs: node.blackHole.rs });
    });
    return out;
  }
}

