/**
 * Regular grid of nodes. Node (i, j) sits at x = x0 + i*h, z = zTop - j*h
 * (z is elevation, so j grows downwards). Node index = j*nx + i.
 */
export interface Grid {
  nx: number;
  nz: number;
  h: number;
  x0: number;
  zTop: number;
}

export interface RayPath {
  /** Calculated traveltime (s). */
  time: number;
  /** Nodes the ray depends on and the path length (m) attributed to each. */
  nodes: number[];
  lengths: number[];
  /** Polyline from receiver to source as x, z pairs (m). */
  points: number[];
}

/** Lazy-deletion binary min-heap of (key, node) pairs. */
class MinHeap {
  private keys = new Float64Array(1024);
  private nodes = new Int32Array(1024);
  size = 0;

  clear(): void {
    this.size = 0;
  }

  push(key: number, node: number): void {
    if (this.size === this.keys.length) {
      const keys = new Float64Array(this.size * 2);
      keys.set(this.keys);
      this.keys = keys;
      const nodes = new Int32Array(this.size * 2);
      nodes.set(this.nodes);
      this.nodes = nodes;
    }
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent]! <= key) break;
      this.keys[i] = this.keys[parent]!;
      this.nodes[i] = this.nodes[parent]!;
      i = parent;
    }
    this.keys[i] = key;
    this.nodes[i] = node;
  }

  /** Removes the smallest entry; read it afterwards from topKey/topNode. */
  topKey = 0;
  topNode = 0;
  pop(): void {
    this.topKey = this.keys[0]!;
    this.topNode = this.nodes[0]!;
    const n = --this.size;
    if (n === 0) return;
    const key = this.keys[n]!;
    const node = this.nodes[n]!;
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= n) break;
      if (child + 1 < n && this.keys[child + 1]! < this.keys[child]!) child++;
      if (this.keys[child]! >= key) break;
      this.keys[i] = this.keys[child]!;
      this.nodes[i] = this.nodes[child]!;
      i = child;
    }
    this.keys[i] = key;
    this.nodes[i] = node;
  }
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** How far (in cells) sources and receivers look for nodes to attach to. */
const ATTACH_RADIUS = 2;

/**
 * First-arrival traveltimes by the shortest path method (Dijkstra on the node
 * graph). Slowness is defined on the nodes; the cost of an edge is its length
 * times the mean slowness of its two ends. Each node connects to 32 neighbours
 * (all coprime offsets up to 3 cells), which keeps the angular error below 1%.
 */
export class RayTracer {
  readonly grid: Grid;
  readonly active: Uint8Array;
  readonly time: Float64Array;
  private readonly pred: Int32Array;
  private readonly done: Uint8Array;
  private readonly heap = new MinHeap();
  private readonly stencilDi: number[] = [];
  private readonly stencilDj: number[] = [];
  private readonly stencilLength: number[] = [];
  private slowness: Float64Array = new Float64Array(0);
  private sourceX = 0;
  private sourceZ = 0;

  constructor(grid: Grid, active: Uint8Array) {
    this.grid = grid;
    this.active = active;
    const n = grid.nx * grid.nz;
    this.time = new Float64Array(n);
    this.pred = new Int32Array(n);
    this.done = new Uint8Array(n);
    for (let dj = -3; dj <= 3; dj++) {
      for (let di = -3; di <= 3; di++) {
        if ((di === 0 && dj === 0) || gcd(Math.abs(di), Math.abs(dj)) !== 1) continue;
        this.stencilDi.push(di);
        this.stencilDj.push(dj);
        this.stencilLength.push(Math.hypot(di, dj) * grid.h);
      }
    }
  }

  /** Active nodes near a point, with their distance to it. */
  private nearbyNodes(x: number, z: number): { node: number; distance: number }[] {
    const { nx, nz, h, x0, zTop } = this.grid;
    const ci = Math.round((x - x0) / h);
    const cj = Math.round((zTop - z) / h);
    for (let radius = ATTACH_RADIUS; radius <= Math.max(nx, nz); radius *= 2) {
      const found: { node: number; distance: number }[] = [];
      for (let j = Math.max(0, cj - radius); j <= Math.min(nz - 1, cj + radius); j++) {
        for (let i = Math.max(0, ci - radius); i <= Math.min(nx - 1, ci + radius); i++) {
          const node = j * nx + i;
          if (!this.active[node]) continue;
          found.push({ node, distance: Math.hypot(x0 + i * h - x, zTop - j * h - z) });
        }
      }
      if (found.length > 0) return found;
    }
    return [];
  }

  /** Computes traveltimes from a source to every active node. */
  run(slowness: Float64Array, sourceX: number, sourceZ: number): void {
    const { nx, nz } = this.grid;
    const { time, pred, done, heap, active } = this;
    this.slowness = slowness;
    this.sourceX = sourceX;
    this.sourceZ = sourceZ;
    time.fill(Infinity);
    pred.fill(-1);
    done.fill(0);
    heap.clear();

    for (const { node, distance } of this.nearbyNodes(sourceX, sourceZ)) {
      time[node] = distance * slowness[node]!;
      heap.push(time[node]!, node);
    }

    const count = this.stencilDi.length;
    while (heap.size > 0) {
      heap.pop();
      const node = heap.topNode;
      if (done[node]) continue;
      done[node] = 1;
      const t = heap.topKey;
      const i = node % nx;
      const j = (node - i) / nx;
      const s = slowness[node]!;
      for (let k = 0; k < count; k++) {
        const ni = i + this.stencilDi[k]!;
        const nj = j + this.stencilDj[k]!;
        if (ni < 0 || ni >= nx || nj < 0 || nj >= nz) continue;
        const next = nj * nx + ni;
        if (done[next] || !active[next]) continue;
        const candidate = t + this.stencilLength[k]! * 0.5 * (s + slowness[next]!);
        if (candidate < time[next]!) {
          time[next] = candidate;
          pred[next] = node;
          heap.push(candidate, next);
        }
      }
    }
  }

  /** Traveltime and ray path from the last source to a receiver. */
  ray(receiverX: number, receiverZ: number): RayPath {
    const { nx, h, x0, zTop } = this.grid;
    const { time, pred, slowness } = this;
    const near = this.nearbyNodes(receiverX, receiverZ);

    let bestNode = -1;
    let bestDistance = 0;
    let bestTime = Infinity;
    for (const { node, distance } of near) {
      const t = time[node]! + distance * slowness[node]!;
      if (t < bestTime) {
        bestTime = t;
        bestNode = node;
        bestDistance = distance;
      }
    }

    // Source and receiver closer than the node spacing can resolve: straight ray.
    const direct = Math.hypot(receiverX - this.sourceX, receiverZ - this.sourceZ);
    if (direct < 2 * ATTACH_RADIUS * h && near.length > 0) {
      const mx = 0.5 * (receiverX + this.sourceX);
      const mz = 0.5 * (receiverZ + this.sourceZ);
      let closest = near[0]!.node;
      let closestDistance = Infinity;
      for (const { node } of near) {
        const d = Math.hypot(x0 + (node % nx) * h - mx, zTop - Math.floor(node / nx) * h - mz);
        if (d < closestDistance) {
          closestDistance = d;
          closest = node;
        }
      }
      const t = direct * slowness[closest]!;
      if (t <= bestTime) {
        return {
          time: t,
          nodes: [closest],
          lengths: [direct],
          points: [receiverX, receiverZ, this.sourceX, this.sourceZ],
        };
      }
    }

    if (bestNode < 0) return { time: Infinity, nodes: [], lengths: [], points: [] };

    const nodes: number[] = [bestNode];
    const lengths: number[] = [bestDistance];
    const points: number[] = [receiverX, receiverZ];
    let node = bestNode;
    for (;;) {
      const i = node % nx;
      const j = (node - i) / nx;
      const x = x0 + i * h;
      const z = zTop - j * h;
      points.push(x, z);
      const previous = pred[node]!;
      if (previous < 0) {
        lengths[lengths.length - 1]! += Math.hypot(x - this.sourceX, z - this.sourceZ);
        break;
      }
      const pi = previous % nx;
      const pj = (previous - pi) / nx;
      const half = 0.5 * Math.hypot(pi - i, pj - j) * h;
      lengths[lengths.length - 1]! += half;
      nodes.push(previous);
      lengths.push(half);
      node = previous;
    }
    points.push(this.sourceX, this.sourceZ);
    return { time: bestTime, nodes, lengths, points };
  }
}
