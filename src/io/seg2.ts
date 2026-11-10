import type { Shot, Trace } from '../core/types';

const FILE_BLOCK_ID = 0x3a55;
const TRACE_BLOCK_ID = 0x4422;

/** Reads the `KEYWORD value` strings of a descriptor block. */
function readStrings(view: DataView, start: number, end: number, le: boolean): Map<string, string> {
  const strings = new Map<string, string>();
  let p = start;
  while (p + 2 <= end) {
    const length = view.getUint16(p, le);
    if (length < 2) break;
    const stop = Math.min(p + length, end);
    let text = '';
    for (let i = p + 2; i < stop; i++) {
      const byte = view.getUint8(i);
      if (byte === 0) break;
      text += String.fromCharCode(byte);
    }
    const match = /^(\S+)\s*([\s\S]*)$/.exec(text.trim());
    if (match) strings.set(match[1]!.toUpperCase(), match[2]!.trim());
    p += length;
  }
  return strings;
}

function firstNumber(text: string | undefined): number | null {
  if (text === undefined) return null;
  const value = parseFloat(text);
  return Number.isFinite(value) ? value : null;
}

function readSamples(view: DataView, offset: number, count: number, format: number, le: boolean): Float32Array {
  const out = new Float32Array(count);
  switch (format) {
    case 1:
      for (let i = 0; i < count; i++) out[i] = view.getInt16(offset + 2 * i, le);
      break;
    case 2:
      for (let i = 0; i < count; i++) out[i] = view.getInt32(offset + 4 * i, le);
      break;
    case 3: {
      // 20-bit floating point: groups of one exponent word (four 4-bit
      // exponents) followed by four 16-bit mantissas.
      const groups = Math.floor(count / 4);
      for (let g = 0; g < groups; g++) {
        const base = offset + 10 * g;
        const exponents = view.getUint16(base, le);
        for (let k = 0; k < 4; k++) {
          const mantissa = view.getInt16(base + 2 + 2 * k, le);
          out[4 * g + k] = mantissa * 2 ** ((exponents >> (4 * k)) & 0xf);
        }
      }
      break;
    }
    case 4:
      for (let i = 0; i < count; i++) out[i] = view.getFloat32(offset + 4 * i, le);
      break;
    case 5:
      for (let i = 0; i < count; i++) out[i] = view.getFloat64(offset + 8 * i, le);
      break;
    default:
      throw new Error(`SEG-2: unsupported data format code ${format}`);
  }
  return out;
}

function bytesNeeded(count: number, format: number): number {
  if (format === 1) return 2 * count;
  if (format === 3) return 10 * Math.floor(count / 4);
  if (format === 5) return 8 * count;
  return 4 * count;
}

/** Parses a SEG-2 file. One file is one shot. */
export function parseSeg2(buffer: ArrayBuffer, name: string): Shot {
  const view = new DataView(buffer);
  if (view.byteLength < 32) throw new Error('SEG-2: file too short');

  let le: boolean;
  if (view.getUint16(0, true) === FILE_BLOCK_ID) le = true;
  else if (view.getUint16(0, false) === FILE_BLOCK_ID) le = false;
  else throw new Error('SEG-2: missing file descriptor block');

  const pointerBytes = view.getUint16(4, le);
  const traceCount = view.getUint16(6, le);
  if (32 + 4 * traceCount > view.byteLength || 4 * traceCount > pointerBytes) {
    throw new Error('SEG-2: invalid trace pointer table');
  }

  const traces: Trace[] = [];
  let sourceX: number | null = null;

  for (let k = 0; k < traceCount; k++) {
    const p = view.getUint32(32 + 4 * k, le);
    if (p + 32 > view.byteLength || view.getUint16(p, le) !== TRACE_BLOCK_ID) {
      throw new Error(`SEG-2: invalid descriptor block for trace ${k + 1}`);
    }
    const blockSize = view.getUint16(p + 2, le);
    const sampleCount = view.getUint32(p + 8, le);
    const format = view.getUint8(p + 12);
    const dataStart = p + blockSize;
    if (dataStart + bytesNeeded(sampleCount, format) > view.byteLength) {
      throw new Error(`SEG-2: trace ${k + 1} runs past the end of the file`);
    }

    const strings = readStrings(view, p + 32, dataStart, le);
    const sampleInterval = firstNumber(strings.get('SAMPLE_INTERVAL'));
    if (sampleInterval === null || sampleInterval <= 0) {
      throw new Error(`SEG-2: trace ${k + 1} has no SAMPLE_INTERVAL`);
    }

    const samples = readSamples(view, dataStart, sampleCount, format, le);
    // True amplitude = sample * DESCALING_FACTOR / STACK.
    const descale = firstNumber(strings.get('DESCALING_FACTOR'));
    const stack = firstNumber(strings.get('STACK'));
    const scale = (descale ?? 1) / (stack !== null && stack > 0 ? stack : 1);
    if (scale !== 1 && Number.isFinite(scale) && scale !== 0) {
      for (let i = 0; i < samples.length; i++) samples[i]! *= scale;
    }

    const receiverX = firstNumber(strings.get('RECEIVER_LOCATION'));
    if (sourceX === null) sourceX = firstNumber(strings.get('SOURCE_LOCATION'));

    traces.push({
      samples,
      sampleInterval,
      delay: firstNumber(strings.get('DELAY')) ?? 0,
      receiver: receiverX === null ? null : { x: receiverX, z: 0 },
    });
  }

  // Identical positions for every channel mean the geometry was never set.
  const distinct = new Set(traces.map((t) => t.receiver?.x));
  if (traces.length > 1 && distinct.size === 1) for (const t of traces) t.receiver = null;

  return { name, source: sourceX === null ? null : { x: sourceX, z: 0 }, traces };
}
