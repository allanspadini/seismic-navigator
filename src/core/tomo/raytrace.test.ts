import { describe, expect, it } from 'vitest';
import { RayTracer, type Grid } from './raytrace';

function setup(nx: number, nz: number, h: number, velocity: (x: number, depth: number) => number) {
  const grid: Grid = { nx, nz, h, x0: 0, zTop: 0 };
  const active = new Uint8Array(nx * nz).fill(1);
  const slowness = new Float64Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) slowness[j * nx + i] = 1 / velocity(i * h, j * h);
  return { tracer: new RayTracer(grid, active), slowness };
}

describe('RayTracer', () => {
  it('matches straight rays in a homogeneous medium', () => {
    const { tracer, slowness } = setup(101, 41, 1, () => 1000);
    tracer.run(slowness, 3.3, 0);
    for (const [x, z] of [[50, 0], [97.4, 0], [60, -30], [10.2, -7.7], [3.9, 0], [3.3, 0]] as const) {
      const exact = Math.hypot(x - 3.3, z) / 1000;
      const ray = tracer.ray(x, z);
      expect(Math.abs(ray.time - exact)).toBeLessThan(0.01 * exact + 1e-5);
      const length = ray.lengths.reduce((a, b) => a + b, 0);
      expect(length / 1000).toBeCloseTo(ray.time, 9);
    }
  });

  it('matches the head wave of a two-layer model', () => {
    const v1 = 500;
    const v2 = 2000;
    const depth = 5;
    const { tracer, slowness } = setup(241, 61, 0.5, (_x, d) => (d < depth ? v1 : v2));
    tracer.run(slowness, 10, 0);
    // Edge costs use the mean slowness of both ends, so a sharp interface is
    // smeared upwards by up to half the longest edge (1.5 cells). Compare with
    // an interface half a cell up and allow for the rest in the tolerance.
    const effectiveDepth = depth - 0.25;
    const intercept = (2 * effectiveDepth * Math.sqrt(v2 * v2 - v1 * v1)) / (v1 * v2);
    for (const x of [12, 16, 40, 70, 110]) {
      const offset = x - 10;
      const exact = Math.min(offset / v1, offset / v2 + intercept);
      const ray = tracer.ray(x, 0);
      expect(Math.abs(ray.time - exact) / exact).toBeLessThan(0.05);
    }
  });

  it('keeps rays out of inactive (air) nodes', () => {
    const grid: Grid = { nx: 41, nz: 21, h: 1, x0: 0, zTop: 0 };
    const active = new Uint8Array(41 * 21).fill(1);
    // A 6 m deep trench between x = 15 and x = 25.
    for (let j = 0; j < 6; j++) for (let i = 15; i <= 25; i++) active[j * 41 + i] = 0;
    const slowness = new Float64Array(41 * 21).fill(1 / 1000);
    const tracer = new RayTracer(grid, active);
    tracer.run(slowness, 5, 0);
    const ray = tracer.ray(35, 0);
    expect(ray.time).toBeGreaterThan(30 / 1000);
    expect(ray.time).toBeLessThan(36 / 1000);
    for (const node of ray.nodes) expect(active[node]).toBe(1);
  });
});
