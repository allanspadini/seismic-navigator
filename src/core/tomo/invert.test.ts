import { describe, expect, it } from 'vitest';
import { autoPick } from '../autopick';
import { createSyntheticSurvey, syntheticVelocity } from '../synthetic';
import { invert, suggestParams, type InversionShot } from './invert';

const survey = createSyntheticSurvey();

function toInversionShots(times: number[][]): InversionShot[] {
  return survey.shots.map((shot, s) => ({
    sourceX: shot.source!.x,
    sourceZ: 0,
    receivers: shot.traces.map((t, k) => ({ x: t.receiver!.x, z: 0, time: times[s]![k]! })),
  }));
}

describe('autoPick', () => {
  it('picks the synthetic first arrivals within 2.5 ms', () => {
    let worst = 0;
    survey.shots.forEach((shot, s) => {
      shot.traces.forEach((trace, k) => {
        const pick = autoPick(trace.samples, trace.sampleInterval, trace.delay);
        expect(pick).not.toBeNull();
        worst = Math.max(worst, Math.abs(pick! - survey.arrivalTimes[s]![k]!));
      });
    });
    expect(worst).toBeLessThan(0.0025);
  });

  it('returns null for a flat trace', () => {
    expect(autoPick(new Float32Array(200), 0.001, 0)).toBeNull();
  });
});

describe('invert', () => {
  it('fits the synthetic survey and recovers its structure', () => {
    const shots = toInversionShots(survey.arrivalTimes);
    const params = suggestParams(shots);
    const result = invert({ shots, topography: [], params });
    expect(result.rms).toBeLessThan(0.0008);
    expect(result.rms).toBeLessThan(0.25 * result.rmsHistory[0]!);

    // Compare with the true model where there is ray coverage.
    const { grid, velocity, coverage } = result;
    let sum = 0;
    let count = 0;
    for (let j = 0; j < grid.nz; j++) {
      for (let i = 0; i < grid.nx; i++) {
        const k = j * grid.nx + i;
        if (coverage[k]! <= 0) continue;
        const truth = syntheticVelocity(grid.x0 + i * grid.h, j * grid.h);
        sum += Math.abs(Math.log(velocity[k]! / truth));
        count++;
      }
    }
    expect(sum / count).toBeLessThan(0.35);

    const at = (x: number, depth: number): number =>
      velocity[Math.round(depth / grid.h) * grid.nx + Math.round((x - grid.x0) / grid.h)]!;
    expect(at(23, 1)).toBeLessThan(800);
    expect(at(23, 14)).toBeGreaterThan(1800);
  });

  it('handles topography', () => {
    const shots: InversionShot[] = [0, 20, 40].map((sourceX) => ({
      sourceX,
      sourceZ: 100 + 0.1 * sourceX,
      receivers: Array.from({ length: 11 }, (_, i) => {
        const x = 4 * i;
        const z = 100 + 0.1 * x;
        return { x, z, time: Math.hypot(x - sourceX, z - (100 + 0.1 * sourceX)) / 1000 + 1e-4 };
      }).filter((r) => r.x !== sourceX),
    }));
    const result = invert({
      shots,
      topography: [
        { x: 0, z: 100 },
        { x: 40, z: 104 },
      ],
      params: { cellSize: 1, depth: 10, vTop: 800, vBottom: 1500, iterations: 6, smoothing: 1 },
    });
    expect(result.grid.zTop).toBeCloseTo(104, 6);
    expect(result.active[0]).toBe(0); // top-left corner is air
    expect(result.rms).toBeLessThan(0.0006);
    expect(Number.isNaN(result.velocity[0]!)).toBe(true);
  });

  it('rejects input without picks', () => {
    expect(() =>
      invert({
        shots: [],
        topography: [],
        params: { cellSize: 1, depth: 10, vTop: 500, vBottom: 2000, iterations: 1, smoothing: 1 },
      }),
    ).toThrow();
  });
});
