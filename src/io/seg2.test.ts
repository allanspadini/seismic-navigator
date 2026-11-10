import { describe, expect, it } from 'vitest';
import { parseSeg2 } from './seg2';

function stringBlock(lines: string[]): number[] {
  const bytes: number[] = [];
  for (const line of lines) {
    const length = 2 + line.length + 1;
    bytes.push(length & 0xff, length >> 8);
    for (const ch of line) bytes.push(ch.charCodeAt(0));
    bytes.push(0);
  }
  bytes.push(0, 0);
  while (bytes.length % 4 !== 0) bytes.push(0);
  return bytes;
}

interface TraceSpec {
  strings: string[];
  format: number;
  data: (view: DataView, offset: number) => void;
  dataBytes: number;
  samples: number;
}

function buildSeg2(traces: TraceSpec[]): ArrayBuffer {
  const pointerBytes = 4 * traces.length;
  const blocks = traces.map((t) => stringBlock(t.strings));
  let size = 32 + pointerBytes + 4;
  const pointers = traces.map((t, i) => {
    const p = size;
    size += 32 + blocks[i]!.length + t.dataBytes;
    return p;
  });
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  view.setUint16(0, 0x3a55, true);
  view.setUint16(2, 1, true);
  view.setUint16(4, pointerBytes, true);
  view.setUint16(6, traces.length, true);
  traces.forEach((t, i) => {
    const p = pointers[i]!;
    view.setUint32(32 + 4 * i, p, true);
    view.setUint16(p, 0x4422, true);
    view.setUint16(p + 2, 32 + blocks[i]!.length, true);
    view.setUint32(p + 4, t.dataBytes, true);
    view.setUint32(p + 8, t.samples, true);
    view.setUint8(p + 12, t.format);
    blocks[i]!.forEach((b, k) => view.setUint8(p + 32 + k, b));
    t.data(view, p + 32 + blocks[i]!.length);
  });
  return buffer;
}

describe('parseSeg2', () => {
  it('reads float32 traces with geometry, delay and scaling', () => {
    const buffer = buildSeg2(
      [0, 1].map((k) => ({
        strings: [
          'SAMPLE_INTERVAL 0.000125',
          'DELAY -0.010',
          `RECEIVER_LOCATION ${(5 + 2 * k).toFixed(2)}`,
          'SOURCE_LOCATION -3.50',
          'DESCALING_FACTOR 0.5',
          'STACK 2',
        ],
        format: 4,
        samples: 3,
        dataBytes: 12,
        data: (view: DataView, offset: number) => {
          [4, -8, 12].forEach((v, i) => view.setFloat32(offset + 4 * i, v + k, true));
        },
      })),
    );
    const shot = parseSeg2(buffer, 'a.dat');
    expect(shot.source).toEqual({ x: -3.5, z: 0 });
    expect(shot.traces).toHaveLength(2);
    expect(shot.traces[0]!.sampleInterval).toBeCloseTo(0.000125, 9);
    expect(shot.traces[0]!.delay).toBeCloseTo(-0.01, 9);
    expect(shot.traces[1]!.receiver).toEqual({ x: 7, z: 0 });
    expect(Array.from(shot.traces[0]!.samples)).toEqual([1, -2, 3]);
    expect(Array.from(shot.traces[1]!.samples)).toEqual([1.25, -1.75, 3.25]);
  });

  it('reads int16, int32 and 20-bit floating point samples', () => {
    const base = { strings: ['SAMPLE_INTERVAL 0.001'] };
    const buffer = buildSeg2([
      {
        ...base,
        format: 1,
        samples: 2,
        dataBytes: 4,
        data: (v, o) => {
          v.setInt16(o, -7, true);
          v.setInt16(o + 2, 300, true);
        },
      },
      {
        ...base,
        format: 2,
        samples: 2,
        dataBytes: 8,
        data: (v, o) => {
          v.setInt32(o, 100000, true);
          v.setInt32(o + 4, -5, true);
        },
      },
      {
        ...base,
        format: 3,
        samples: 4,
        dataBytes: 10,
        data: (v, o) => {
          v.setUint16(o, 0x3210, true); // exponents 0, 1, 2, 3
          [5, -5, 3, 1].forEach((m, i) => v.setInt16(o + 2 + 2 * i, m, true));
        },
      },
    ]);
    const shot = parseSeg2(buffer, 'b.dat');
    expect(Array.from(shot.traces[0]!.samples)).toEqual([-7, 300]);
    expect(Array.from(shot.traces[1]!.samples)).toEqual([100000, -5]);
    expect(Array.from(shot.traces[2]!.samples)).toEqual([5, -10, 12, 8]);
    expect(shot.source).toBeNull();
    expect(shot.traces[0]!.receiver).toBeNull();
  });

  it('rejects files without the SEG-2 block id', () => {
    expect(() => parseSeg2(new ArrayBuffer(64), 'x')).toThrow(/SEG-2/);
  });
});
