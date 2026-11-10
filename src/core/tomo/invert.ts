import { elevationAt, type Topography } from '../topography';
import { RayTracer, type Grid } from './raytrace';

export interface InversionShot {
  sourceX: number;
  sourceZ: number;
  receivers: { x: number; z: number; time: number }[];
}

export interface InversionParams {
  /** Node spacing (m). */
  cellSize: number;
  /** Model depth below the lowest surface point (m). */
  depth: number;
  /** Velocity of the starting model at the surface and at `depth` (m/s). */
  vTop: number;
  vBottom: number;
  iterations: number;
  /** Relative weight of the smoothness constraint (dimensionless, around 1). */
  smoothing: number;
}

export interface InversionInput {
  shots: InversionShot[];
  /** Surface profile; must cover the stations (see `elevationAt`). */
  topography: Topography;
  params: InversionParams;
}

export interface InversionResult {
  grid: Grid;
  /** 1 for nodes below the surface, 0 for air. */
  active: Uint8Array;
  /** Velocity at each node (m/s). */
  velocity: Float32Array;
  /** Total ray length attributed to each node (m). */
  coverage: Float32Array;
  /** RMS misfit (s) of the starting model and after each iteration. */
  rmsHistory: number[];
  /** RMS misfit (s) of the returned model. */
  rms: number;
  /** Median absolute residual (s) of the returned model; insensitive to bad picks. */
  medianResidual: number;
  /** Calculated traveltime (s) per shot and receiver, in input order. */
  calculated: number[][];
  /** Ray polylines (x, z pairs) of the returned model. */
  rays: Float32Array[];
}

export interface InversionProgress {
  iteration: number;
  iterations: number;
  rms: number;
}

const V_MIN = 100;
const V_MAX = 8000;
/** Vertical smoothing relative to horizontal: layers are expected to be sub-horizontal. */
const VERTICAL_WEIGHT = 0.3;
const CGLS_ITERATIONS = 60;
/** Residuals beyond this many robust standard deviations are down-weighted. */
const HUBER_THRESHOLD = 2;
/** Largest change of ln(slowness) accepted for a node in one iteration. */
const MAX_STEP = 0.5;

export function buildGrid(input: InversionInput): { grid: Grid; active: Uint8Array; depthBelowSurface: Float64Array } {
  const { shots, topography, params } = input;
  const h = params.cellSize;
  let xMin = Infinity;
  let xMax = -Infinity;
  for (const shot of shots) {
    xMin = Math.min(xMin, shot.sourceX);
    xMax = Math.max(xMax, shot.sourceX);
    for (const r of shot.receivers) {
      xMin = Math.min(xMin, r.x);
      xMax = Math.max(xMax, r.x);
    }
  }
  const x0 = xMin - 2 * h;
  const nx = Math.ceil((xMax + 2 * h - x0) / h) + 1;

  const surface = new Float64Array(nx);
  let zHigh = -Infinity;
  let zLow = Infinity;
  for (let i = 0; i < nx; i++) {
    surface[i] = elevationAt(topography, x0 + i * h);
    zHigh = Math.max(zHigh, surface[i]!);
    zLow = Math.min(zLow, surface[i]!);
  }
  const zTop = zHigh;
  const nz = Math.ceil((zTop - (zLow - params.depth)) / h) + 1;

  const active = new Uint8Array(nx * nz);
  const depthBelowSurface = new Float64Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const depth = surface[i]! - (zTop - j * h);
      if (depth >= -1e-6 * h) {
        active[j * nx + i] = 1;
        depthBelowSurface[j * nx + i] = Math.max(depth, 0);
      }
    }
  }
  return { grid: { nx, nz, h, x0, zTop }, active, depthBelowSurface };
}

interface ForwardResult {
  rms: number;
  /** Mean absolute residual: ranks models without letting outliers dominate. */
  meanAbs: number;
  residual: Float64Array;
  calculated: number[][];
  rowStart: Int32Array;
  cols: Int32Array;
  vals: Float64Array;
  rays: Float32Array[];
}

function forward(tracer: RayTracer, slowness: Float64Array, shots: InversionShot[]): ForwardResult {
  const rowStart: number[] = [0];
  const cols: number[] = [];
  const vals: number[] = [];
  const residual: number[] = [];
  const calculated: number[][] = [];
  const rays: Float32Array[] = [];
  let sumSq = 0;
  let sumAbs = 0;
  for (const shot of shots) {
    tracer.run(slowness, shot.sourceX, shot.sourceZ);
    const times: number[] = [];
    for (const r of shot.receivers) {
      const ray = tracer.ray(r.x, r.z);
      times.push(ray.time);
      for (let k = 0; k < ray.nodes.length; k++) {
        cols.push(ray.nodes[k]!);
        vals.push(ray.lengths[k]!);
      }
      rowStart.push(cols.length);
      const res = r.time - ray.time;
      residual.push(res);
      sumSq += res * res;
      sumAbs += Math.abs(res);
      rays.push(Float32Array.from(ray.points));
    }
    calculated.push(times);
  }
  return {
    rms: Math.sqrt(sumSq / Math.max(1, residual.length)),
    meanAbs: sumAbs / Math.max(1, residual.length),
    residual: Float64Array.from(residual),
    calculated,
    rowStart: Int32Array.from(rowStart),
    cols: Int32Array.from(cols),
    vals: Float64Array.from(vals),
    rays,
  };
}

/**
 * Traveltime tomography. The model is ln(slowness) on the grid nodes; each
 * iteration traces rays, then solves a smoothness-regularised least-squares
 * problem for the model update with CGLS. The best model found is returned.
 */
export function invert(input: InversionInput, onProgress?: (p: InversionProgress) => void): InversionResult {
  const { shots, params } = input;
  const rayCount = shots.reduce((n, s) => n + s.receivers.length, 0);
  if (rayCount === 0) throw new Error('no picks to invert');

  const { grid, active, depthBelowSurface } = buildGrid(input);
  const { nx, nz } = grid;
  const n = nx * nz;
  const tracer = new RayTracer(grid, active);

  // Starting model: velocity increasing linearly with depth below the surface.
  const model = new Float64Array(n); // ln(slowness)
  const slowness = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const fraction = Math.min(1, depthBelowSurface[k]! / params.depth);
    const v = params.vTop + (params.vBottom - params.vTop) * fraction;
    model[k] = -Math.log(Math.min(V_MAX, Math.max(V_MIN, v)));
    slowness[k] = Math.exp(model[k]!);
  }

  // Smoothness operator: first differences between neighbouring active nodes.
  const pairA: number[] = [];
  const pairB: number[] = [];
  const pairWeight: number[] = [];
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (!active[k]) continue;
      if (i + 1 < nx && active[k + 1]) {
        pairA.push(k);
        pairB.push(k + 1);
        pairWeight.push(1);
      }
      if (j + 1 < nz && active[k + nx]) {
        pairA.push(k);
        pairB.push(k + nx);
        pairWeight.push(VERTICAL_WEIGHT);
      }
    }
  }
  const pairCount = pairA.length;
  let smoothNorm = 0;
  for (let p = 0; p < pairCount; p++) smoothNorm += 2 * pairWeight[p]! ** 2;

  const rmsHistory: number[] = [];
  let best: { fwd: ForwardResult; model: Float64Array } | null = null;

  for (let iteration = 0; ; iteration++) {
    const fwd = forward(tracer, slowness, shots);
    rmsHistory.push(fwd.rms);
    if (!best || fwd.meanAbs < best.fwd.meanAbs) best = { fwd, model: model.slice() };
    onProgress?.({ iteration, iterations: params.iterations, rms: fwd.rms });
    if (iteration >= params.iterations) break;

    // Huber weights: residuals far beyond the typical misfit (bad picks) count
    // linearly instead of quadratically, so a few outliers do not bend the model.
    const magnitudes = Array.from(fwd.residual, Math.abs).sort((a, b) => a - b);
    const scale = Math.max(1e-6, 1.4826 * magnitudes[magnitudes.length >> 1]!);
    const weights = new Float64Array(rayCount);
    for (let r = 0; r < rayCount; r++) {
      weights[r] = Math.min(1, (HUBER_THRESHOLD * scale) / Math.max(1e-12, Math.abs(fwd.residual[r]!)));
    }

    // Jacobian with respect to ln(slowness): path length times slowness.
    const { rowStart, cols } = fwd;
    const vals = fwd.vals.slice();
    let dataNorm = 0;
    for (let r = 0; r < rayCount; r++) {
      for (let e = rowStart[r]!; e < rowStart[r + 1]!; e++) {
        vals[e]! *= slowness[cols[e]!]! * weights[r]!;
        dataNorm += vals[e]! ** 2;
      }
    }

    // Smoothing starts strong and relaxes, so large structures are fitted first.
    const cooling = Math.max(0.1, 0.7 ** iteration);
    const lambda = Math.sqrt((params.smoothing * cooling * dataNorm) / smoothNorm);
    const damping = 0.05 * lambda;

    // Stacked system: [G; lambda*L; damping*I] dm = [residual; -lambda*L*m; 0].
    const rows = rayCount + pairCount + n;
    const rhs = new Float64Array(rows);
    for (let r = 0; r < rayCount; r++) rhs[r] = fwd.residual[r]! * weights[r]!;
    for (let p = 0; p < pairCount; p++) {
      rhs[rayCount + p] = -lambda * pairWeight[p]! * (model[pairB[p]!]! - model[pairA[p]!]!);
    }

    const multiply = (x: Float64Array, out: Float64Array): void => {
      for (let r = 0; r < rayCount; r++) {
        let sum = 0;
        for (let e = rowStart[r]!; e < rowStart[r + 1]!; e++) sum += vals[e]! * x[cols[e]!]!;
        out[r] = sum;
      }
      for (let p = 0; p < pairCount; p++) {
        out[rayCount + p] = lambda * pairWeight[p]! * (x[pairB[p]!]! - x[pairA[p]!]!);
      }
      for (let k = 0; k < n; k++) out[rayCount + pairCount + k] = damping * x[k]!;
    };
    const multiplyTranspose = (y: Float64Array, out: Float64Array): void => {
      out.fill(0);
      for (let r = 0; r < rayCount; r++) {
        const value = y[r]!;
        for (let e = rowStart[r]!; e < rowStart[r + 1]!; e++) out[cols[e]!]! += vals[e]! * value;
      }
      for (let p = 0; p < pairCount; p++) {
        const value = lambda * pairWeight[p]! * y[rayCount + p]!;
        out[pairB[p]!]! += value;
        out[pairA[p]!]! -= value;
      }
      for (let k = 0; k < n; k++) out[k]! += damping * y[rayCount + pairCount + k]!;
    };

    // CGLS.
    const update = new Float64Array(n);
    const r = rhs.slice();
    const s = new Float64Array(n);
    multiplyTranspose(r, s);
    const p = s.slice();
    const q = new Float64Array(rows);
    let gamma = 0;
    for (let k = 0; k < n; k++) gamma += s[k]! ** 2;
    const gamma0 = gamma;
    for (let it = 0; it < CGLS_ITERATIONS && gamma > 1e-12 * gamma0 && gamma > 0; it++) {
      multiply(p, q);
      let qq = 0;
      for (let k = 0; k < rows; k++) qq += q[k]! ** 2;
      if (!(qq > 0)) break;
      const alpha = gamma / qq;
      for (let k = 0; k < n; k++) update[k]! += alpha * p[k]!;
      for (let k = 0; k < rows; k++) r[k]! -= alpha * q[k]!;
      multiplyTranspose(r, s);
      let next = 0;
      for (let k = 0; k < n; k++) next += s[k]! ** 2;
      const beta = next / gamma;
      gamma = next;
      for (let k = 0; k < n; k++) p[k] = s[k]! + beta * p[k]!;
    }

    for (let k = 0; k < n; k++) {
      if (!active[k]) continue;
      const step = Math.max(-MAX_STEP, Math.min(MAX_STEP, update[k]!));
      model[k] = Math.max(-Math.log(V_MAX), Math.min(-Math.log(V_MIN), model[k]! + step));
      slowness[k] = Math.exp(model[k]!);
    }
  }

  const velocity = new Float32Array(n);
  for (let k = 0; k < n; k++) velocity[k] = active[k] ? Math.exp(-best.model[k]!) : NaN;
  const coverage = new Float32Array(n);
  for (let e = 0; e < best.fwd.cols.length; e++) coverage[best.fwd.cols[e]!]! += best.fwd.vals[e]!;

  const sortedResiduals = Array.from(best.fwd.residual, Math.abs).sort((a, b) => a - b);

  return {
    grid,
    active,
    velocity,
    coverage,
    rmsHistory,
    rms: best.fwd.rms,
    medianResidual: sortedResiduals[sortedResiduals.length >> 1]!,
    calculated: best.fwd.calculated,
    rays: best.fwd.rays,
  };
}

/** Starting values for the inversion form, estimated from geometry and picks. */
export function suggestParams(shots: InversionShot[]): InversionParams {
  const median = (values: number[], fallback: number): number => {
    if (values.length === 0) return fallback;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[sorted.length >> 1]!;
  };
  const round = (value: number, step: number): number => Math.max(step, Math.round(value / step) * step);

  const spacings: number[] = [];
  const nearVelocities: number[] = [];
  const farVelocities: number[] = [];
  let maxOffset = 0;
  for (const shot of shots) {
    const xs = shot.receivers.map((r) => r.x).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) if (xs[i]! - xs[i - 1]! > 0) spacings.push(xs[i]! - xs[i - 1]!);

    // Each side of the source is a separate time-distance branch.
    for (const side of [-1, 1]) {
      const branch = shot.receivers
        .map((r) => ({ offset: (r.x - shot.sourceX) * side, time: r.time }))
        .filter((r) => r.offset > 0 && r.time > 0)
        .sort((a, b) => a.offset - b.offset);
      if (branch.length === 0) continue;
      maxOffset = Math.max(maxOffset, branch[branch.length - 1]!.offset);
      // Near the source the direct wave gives the surface velocity...
      for (const r of branch.slice(0, 2)) nearVelocities.push(r.offset / r.time);
      // ...and the slope of the far half gives the fastest refractor reached.
      // The median of pairwise slopes (Theil-Sen) ignores a few bad picks.
      const far = branch.slice(branch.length >> 1);
      const slopes: number[] = [];
      for (let i = 0; i < far.length; i++) {
        for (let j = i + 1; j < far.length; j++) {
          const dx = far[j]!.offset - far[i]!.offset;
          if (dx > 0) slopes.push((far[j]!.time - far[i]!.time) / dx);
        }
      }
      const slope = median(slopes, 0);
      if (far.length >= 4 && slope > 0) farVelocities.push(1 / slope);
    }
  }
  const spacing = median(spacings, 2);
  const vTop = Math.min(2000, Math.max(200, round(median(nearVelocities, 500), 50)));
  const refractor = median(farVelocities, 4 * vTop);
  return {
    cellSize: Number((spacing / 2).toPrecision(2)),
    depth: round(maxOffset > 0 ? maxOffset / 3 : 10 * spacing, 1),
    vTop,
    vBottom: Math.min(7000, Math.max(vTop * 1.5, round(refractor * 1.3, 100))),
    iterations: 10,
    smoothing: 1,
  };
}
