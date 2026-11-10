import { describe, expect, it } from 'vitest';
import { detectFormat } from './detect';

function segy(formatCode: number, littleEndian: boolean): ArrayBuffer {
  const buffer = new ArrayBuffer(3600);
  new DataView(buffer).setUint16(3224, formatCode, littleEndian);
  return buffer;
}

function seg2(littleEndian: boolean): ArrayBuffer {
  const buffer = new ArrayBuffer(32);
  new DataView(buffer).setUint16(0, 0x3a55, littleEndian);
  return buffer;
}

describe('detectFormat', () => {
  it('detects little-endian SEG-2', () => {
    expect(detectFormat(seg2(true))).toEqual({ format: 'seg2', littleEndian: true });
  });

  it('detects big-endian SEG-2', () => {
    expect(detectFormat(seg2(false))).toEqual({ format: 'seg2', littleEndian: false });
  });

  it('detects big-endian SEG-Y by its format code', () => {
    expect(detectFormat(segy(1, false))).toEqual({ format: 'segy', littleEndian: false });
  });

  it('detects little-endian SEG-Y', () => {
    expect(detectFormat(segy(5, true))).toEqual({ format: 'segy', littleEndian: true });
  });

  it('rejects a SEG-Y sized buffer with an invalid format code', () => {
    expect(detectFormat(segy(0, false))).toBeNull();
  });

  it('rejects empty and unrelated buffers', () => {
    expect(detectFormat(new ArrayBuffer(0))).toBeNull();
    expect(detectFormat(new TextEncoder().encode('not seismic data').buffer)).toBeNull();
  });
});
