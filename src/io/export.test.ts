import { describe, expect, it } from 'vitest';
import { createShotState, type ShotState } from '../core/types';
import { applyProject, picksToCsv, projectToJson } from './export';

function shot(name: string): ShotState {
  const trace = (x: number) => ({ samples: new Float32Array(4), sampleInterval: 0.001, delay: 0, receiver: { x, z: 0 } });
  return createShotState({ name, source: { x: -2, z: 0 }, traces: [trace(0), trace(2), trace(4)] });
}

describe('export', () => {
  it('writes only picked traces to CSV, in milliseconds', () => {
    const s = shot('a "1".dat');
    s.picks = [0.0105, null, 0.02];
    expect(picksToCsv([s])).toBe(
      'shot,source_x_m,source_z_m,channel,receiver_x_m,receiver_z_m,time_ms\n' +
        '"a ""1"".dat",-2,0,1,0,0,10.5\n' +
        '"a ""1"".dat",-2,0,3,4,0,20\n',
    );
  });

  it('round-trips a project by shot name', () => {
    const a = shot('a');
    a.picks = [0.01, null, 0.03];
    a.sourceX = 7;
    a.receiverX = [1, 3, 5];
    const json = projectToJson([a], '0 10\n5 11', null);

    const fresh = [shot('a'), shot('b')];
    const { matched, project } = applyProject(json, fresh);
    expect(matched).toBe(1);
    expect(project.topography).toBe('0 10\n5 11');
    expect(fresh[0]!.picks).toEqual([0.01, null, 0.03]);
    expect(fresh[0]!.sourceX).toBe(7);
    expect(fresh[0]!.receiverX).toEqual([1, 3, 5]);
    expect(fresh[1]!.picks).toEqual([null, null, null]);
  });

  it('rejects files that are not projects', () => {
    expect(() => applyProject('{"x":1}', [])).toThrow();
  });
});
