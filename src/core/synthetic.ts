import { RayTracer, type Grid } from './tomo/raytrace';
import type { Shot } from './types';

/** Velocity (m/s) of the synthetic ground at position x and depth below the surface. */
export function syntheticVelocity(x: number, depth: number): number {
  // Soil over weathered rock over bedrock; the bedrock top dips and undulates.
  const bedrock = 7 + 0.07 * x + 1.5 * Math.sin(x / 9);
  const soil = 450 + 60 * depth;
  if (depth < bedrock - 1) return soil;
  const rock = 2600 + 15 * (depth - bedrock);
  if (depth > bedrock + 1) return rock;
  const blend = (depth - (bedrock - 1)) / 2;
  return soil + (rock - soil) * blend;
}

/** Small deterministic generator, so the example is the same on every load. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * Builds a synthetic refraction survey: 24 geophones every 2 m and 7 shots,
 * with traces made of a damped wavelet at the modelled first-arrival time
 * plus noise. Used as the built-in example and in tests.
 */
export function createSyntheticSurvey(): { shots: Shot[]; arrivalTimes: number[][] } {
  const h = 0.5;
  const grid: Grid = { nx: 141, nz: 61, h, x0: -12, zTop: 0 };
  const active = new Uint8Array(grid.nx * grid.nz).fill(1);
  const slowness = new Float64Array(grid.nx * grid.nz);
  for (let j = 0; j < grid.nz; j++) {
    for (let i = 0; i < grid.nx; i++) slowness[j * grid.nx + i] = 1 / syntheticVelocity(grid.x0 + i * h, j * h);
  }
  const tracer = new RayTracer(grid, active);

  const receivers = Array.from({ length: 24 }, (_, i) => 2 * i);
  const sources = [-10, -1, 11, 23, 35, 47, 56];
  const sampleInterval = 0.00025;
  const sampleCount = 600;
  const frequency = 90;
  const rand = random(7);
  const gaussian = (): number => {
    const u = Math.max(rand(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };

  const arrivalTimes: number[][] = [];
  const shots = sources.map((sourceX, index) => {
    tracer.run(slowness, sourceX, 0);
    const times = receivers.map((x) => tracer.ray(x, 0).time);
    arrivalTimes.push(times);
    const traces = receivers.map((x, k) => {
      const samples = new Float32Array(sampleCount);
      const amplitude = 1 / (1 + Math.abs(x - sourceX) / 8);
      const noise = 0.012;
      for (let i = 0; i < sampleCount; i++) {
        const t = i * sampleInterval - times[k]!;
        let value = noise * gaussian();
        if (t >= 0) value -= amplitude * Math.sin(2 * Math.PI * frequency * t) * Math.exp(-t * 55) * Math.min(1, t * 400);
        samples[i] = value;
      }
      return { samples, sampleInterval, delay: 0, receiver: { x, z: 0 } };
    });
    return { name: `sintetico_${index + 1}`, source: { x: sourceX, z: 0 }, traces };
  });
  return { shots, arrivalTimes };
}
