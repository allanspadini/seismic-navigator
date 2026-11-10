import { describe, expect, it } from 'vitest';
import { ibmToNumber, parseSegy } from './segy';

interface TraceSpec {
  record: number;
  sx: number;
  gx: number;
  samples: number[];
  sy?: number;
  gy?: number;
  offset?: number;
}

function buildSegy(format: number, traces: TraceSpec[], le = false, coordinateScalar = -10): ArrayBuffer {
  const bytes = { 1: 4, 2: 4, 3: 2, 5: 4, 8: 1 }[format]!;
  const ns = traces[0]!.samples.length;
  const buffer = new ArrayBuffer(3600 + traces.length * (240 + ns * bytes));
  const view = new DataView(buffer);
  view.setUint16(3216, 250, le);
  view.setUint16(3220, ns, le);
  view.setUint16(3224, format, le);
  traces.forEach((t, k) => {
    const p = 3600 + k * (240 + ns * bytes);
    view.setInt32(p + 8, t.record, le);
    view.setInt32(p + 36, t.offset ?? 0, le);
    view.setInt16(p + 70, coordinateScalar, le);
    view.setInt32(p + 72, t.sx, le);
    view.setInt32(p + 76, t.sy ?? 0, le);
    view.setInt32(p + 80, t.gx, le);
    view.setInt32(p + 84, t.gy ?? 0, le);
    view.setInt16(p + 108, -5, le);
    t.samples.forEach((s, i) => {
      const o = p + 240 + i * bytes;
      if (format === 5) view.setFloat32(o, s, le);
      else if (format === 2) view.setInt32(o, s, le);
      else if (format === 3) view.setInt16(o, s, le);
      else if (format === 8) view.setInt8(o, s);
      else view.setUint32(o, s, le);
    });
  });
  return buffer;
}

describe('ibmToNumber', () => {
  it('converts known IBM floats', () => {
    expect(ibmToNumber(0x41100000)).toBe(1);
    expect(ibmToNumber(0xc1100000)).toBe(-1);
    expect(ibmToNumber(0x42640000)).toBe(100);
    expect(ibmToNumber(0x40800000)).toBe(0.5);
    expect(ibmToNumber(0xc276a000)).toBe(-118.625);
    expect(ibmToNumber(0)).toBe(0);
  });
});

describe('parseSegy', () => {
  it('reads IEEE traces, applies scalars and splits shots by record number', () => {
    const buffer = buildSegy(5, [
      { record: 1, sx: -20, gx: 0, samples: [1, 2, 3] },
      { record: 1, sx: -20, gx: 25, samples: [4, 5, 6] },
      { record: 2, sx: 300, gx: 0, samples: [7, 8, 9] },
      { record: 2, sx: 300, gx: 25, samples: [1.5, 0, -1.5] },
    ]);
    const shots = parseSegy(buffer, 'line.sgy');
    expect(shots).toHaveLength(2);
    expect(shots[0]!.name).toBe('line.sgy [1]');
    expect(shots[0]!.source).toEqual({ x: -2, z: 0 });
    expect(shots[1]!.source).toEqual({ x: 30, z: 0 });
    expect(shots[0]!.traces[1]!.receiver).toEqual({ x: 2.5, z: 0 });
    expect(shots[0]!.traces[0]!.sampleInterval).toBeCloseTo(250e-6, 12);
    expect(shots[0]!.traces[0]!.delay).toBeCloseTo(-0.005, 12);
    expect(Array.from(shots[1]!.traces[1]!.samples)).toEqual([1.5, 0, -1.5]);
  });

  it('reads IBM floats and integer formats', () => {
    const ibm = parseSegy(buildSegy(1, [{ record: 1, sx: 0, gx: 10, samples: [0x41100000, 0xc276a000] }]), 'a');
    expect(Array.from(ibm[0]!.traces[0]!.samples)).toEqual([1, -118.625]);
    const i16 = parseSegy(buildSegy(3, [{ record: 1, sx: 0, gx: 10, samples: [-300, 12] }]), 'a');
    expect(Array.from(i16[0]!.traces[0]!.samples)).toEqual([-300, 12]);
    const i32 = parseSegy(buildSegy(2, [{ record: 1, sx: 0, gx: 10, samples: [-70000, 12] }]), 'a');
    expect(Array.from(i32[0]!.traces[0]!.samples)).toEqual([-70000, 12]);
    const i8 = parseSegy(buildSegy(8, [{ record: 1, sx: 0, gx: 10, samples: [-3, 12] }]), 'a');
    expect(Array.from(i8[0]!.traces[0]!.samples)).toEqual([-3, 12]);
  });

  it('reads little-endian files', () => {
    const shots = parseSegy(buildSegy(5, [{ record: 1, sx: 50, gx: 100, samples: [2.5] }], true), 'a', true);
    expect(shots[0]!.traces[0]!.receiver).toEqual({ x: 10, z: 0 });
    expect(Array.from(shots[0]!.traces[0]!.samples)).toEqual([2.5]);
  });

  it('projects coordinates onto the profile when the line is not along X', () => {
    const shots = parseSegy(
      buildSegy(
        5,
        [
          { record: 1, sx: 0, sy: 0, gx: 30, gy: 40, samples: [0] },
          { record: 1, sx: 0, sy: 0, gx: 60, gy: 80, samples: [0] },
        ],
        false,
        1,
      ),
      'a',
    );
    expect(shots[0]!.traces[0]!.receiver!.x).toBeCloseTo(50, 9);
    expect(shots[0]!.traces[1]!.receiver!.x).toBeCloseTo(100, 9);
    expect(shots[0]!.source!.x).toBeCloseTo(0, 9);
  });

  it('falls back to offsets, then to no geometry', () => {
    const offsets = parseSegy(
      buildSegy(5, [
        { record: 1, sx: 0, gx: 0, offset: 5, samples: [0] },
        { record: 1, sx: 0, gx: 0, offset: 7, samples: [0] },
      ]),
      'a',
    );
    expect(offsets[0]!.source).toEqual({ x: 0, z: 0 });
    expect(offsets[0]!.traces[1]!.receiver).toEqual({ x: 7, z: 0 });
    const none = parseSegy(
      buildSegy(5, [
        { record: 1, sx: 0, gx: 0, samples: [0] },
        { record: 1, sx: 0, gx: 0, samples: [0] },
      ]),
      'a',
    );
    expect(none[0]!.source).toBeNull();
    expect(none[0]!.traces[0]!.receiver).toBeNull();
  });
});
