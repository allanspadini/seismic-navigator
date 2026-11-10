import type { Shot, Trace } from '../core/types';

const TEXT_HEADER_BYTES = 3200;
const BINARY_HEADER_BYTES = 400;
const TRACE_HEADER_BYTES = 240;

const BYTES_PER_SAMPLE: Record<number, number> = { 1: 4, 2: 4, 3: 2, 5: 4, 8: 1 };

/** Converts a 32-bit IBM System/360 float (as an unsigned integer) to a number. */
export function ibmToNumber(bits: number): number {
  const fraction = bits & 0x00ffffff;
  if (fraction === 0) return 0;
  const sign = bits & 0x80000000 ? -1 : 1;
  const exponent = (bits >>> 24) & 0x7f;
  return sign * (fraction / 0x1000000) * 16 ** (exponent - 64);
}

/** SEG-Y scalar: positive multiplies, negative divides, zero means 1. */
function applyScalar(value: number, scalar: number): number {
  if (scalar > 0) return value * scalar;
  if (scalar < 0) return value / -scalar;
  return value;
}

interface RawTrace {
  trace: Trace;
  record: number;
  offset: number;
  sx: number;
  sy: number;
  gx: number;
  gy: number;
  sz: number;
  gz: number;
}

/**
 * Parses a SEG-Y file. A file may hold several shots; traces are split into
 * shots whenever the field record number changes.
 */
export function parseSegy(buffer: ArrayBuffer, name: string, littleEndian = false): Shot[] {
  const view = new DataView(buffer);
  const le = littleEndian;
  if (view.byteLength < TEXT_HEADER_BYTES + BINARY_HEADER_BYTES) throw new Error('SEG-Y: file too short');

  const fileInterval = view.getUint16(3216, le);
  const fileSamples = view.getUint16(3220, le);
  const format = view.getUint16(3224, le);
  const sampleBytes = BYTES_PER_SAMPLE[format];
  if (sampleBytes === undefined) throw new Error(`SEG-Y: unsupported data sample format code ${format}`);

  let p = TEXT_HEADER_BYTES + BINARY_HEADER_BYTES;
  const extendedHeaders = view.getInt16(3504, le);
  if (extendedHeaders > 0 && p + extendedHeaders * TEXT_HEADER_BYTES < view.byteLength) {
    p += extendedHeaders * TEXT_HEADER_BYTES;
  }

  const raw: RawTrace[] = [];
  while (p + TRACE_HEADER_BYTES <= view.byteLength) {
    const count = view.getUint16(p + 114, le) || fileSamples;
    const interval = view.getUint16(p + 116, le) || fileInterval;
    if (count === 0 || interval === 0) throw new Error('SEG-Y: missing sample count or sample interval');
    const dataStart = p + TRACE_HEADER_BYTES;
    if (dataStart + count * sampleBytes > view.byteLength) break; // truncated last trace

    const samples = new Float32Array(count);
    switch (format) {
      case 1:
        for (let i = 0; i < count; i++) samples[i] = ibmToNumber(view.getUint32(dataStart + 4 * i, le));
        break;
      case 2:
        for (let i = 0; i < count; i++) samples[i] = view.getInt32(dataStart + 4 * i, le);
        break;
      case 3:
        for (let i = 0; i < count; i++) samples[i] = view.getInt16(dataStart + 2 * i, le);
        break;
      case 5:
        for (let i = 0; i < count; i++) samples[i] = view.getFloat32(dataStart + 4 * i, le);
        break;
      case 8:
        for (let i = 0; i < count; i++) samples[i] = view.getInt8(dataStart + i);
        break;
    }

    const elevationScalar = view.getInt16(p + 68, le);
    const coordinateScalar = view.getInt16(p + 70, le);
    raw.push({
      trace: {
        samples,
        sampleInterval: interval * 1e-6,
        delay: view.getInt16(p + 108, le) * 1e-3,
        receiver: null,
      },
      record: view.getInt32(p + 8, le),
      offset: view.getInt32(p + 36, le),
      gz: applyScalar(view.getInt32(p + 40, le), elevationScalar),
      sz: applyScalar(view.getInt32(p + 44, le), elevationScalar),
      sx: applyScalar(view.getInt32(p + 72, le), coordinateScalar),
      sy: applyScalar(view.getInt32(p + 76, le), coordinateScalar),
      gx: applyScalar(view.getInt32(p + 80, le), coordinateScalar),
      gy: applyScalar(view.getInt32(p + 84, le), coordinateScalar),
    });
    p = dataStart + count * sampleBytes;
  }
  if (raw.length === 0) throw new Error('SEG-Y: no traces found');

  // Split into shots at each change of field record number.
  const groups: RawTrace[][] = [];
  for (const t of raw) {
    const last = groups[groups.length - 1];
    if (last && last[0]!.record === t.record) last.push(t);
    else groups.push([t]);
  }

  const hasCoordinates = raw.some((t) => t.gx !== 0 || t.gy !== 0 || t.sx !== 0 || t.sy !== 0);
  const hasOffsets = raw.some((t) => t.offset !== 0);

  // Profile direction: from the first to the last receiver of the first shot.
  // Positions are projected onto it, so lines not aligned with X still work.
  let ux = 1;
  let uy = 0;
  if (hasCoordinates) {
    const first = groups[0]![0]!;
    const last = groups[0]![groups[0]!.length - 1]!;
    const dx = last.gx - first.gx;
    const dy = last.gy - first.gy;
    const length = Math.hypot(dx, dy);
    if (length > 0 && dy !== 0) {
      ux = dx / length;
      uy = dy / length;
    }
  }

  return groups.map((group, index) => {
    const head = group[0]!;
    let source: Shot['source'] = null;
    if (hasCoordinates) {
      source = { x: head.sx * ux + head.sy * uy, z: head.sz };
      for (const t of group) t.trace.receiver = { x: t.gx * ux + t.gy * uy, z: t.gz };
    } else if (hasOffsets) {
      source = { x: 0, z: head.sz };
      for (const t of group) t.trace.receiver = { x: t.offset, z: t.gz };
    }
    const distinct = new Set(group.map((t) => t.trace.receiver?.x));
    if (group.length > 1 && distinct.size === 1) {
      source = null;
      for (const t of group) t.trace.receiver = null;
    }
    return {
      name: groups.length > 1 ? `${name} [${head.record || index + 1}]` : name,
      source,
      traces: group.map((t) => t.trace),
    };
  });
}
