export type SeismicFormat = 'segy' | 'seg2';

export interface DetectedFormat {
  format: SeismicFormat;
  littleEndian: boolean;
}

const SEGY_HEADER_BYTES = 3600;
const SEGY_FORMAT_CODE_OFFSET = 3224;
const SEGY_FORMAT_CODES = new Set([1, 2, 3, 5, 8]);

/**
 * Identifies the file format from its content (never from the extension).
 * Returns null when the buffer is neither SEG-2 nor SEG-Y.
 */
export function detectFormat(buffer: ArrayBuffer): DetectedFormat | null {
  const view = new DataView(buffer);

  if (view.byteLength >= 2) {
    // SEG-2 file descriptor block id is 0x3A55, stored in the file's byte order.
    if (view.getUint16(0, true) === 0x3a55) return { format: 'seg2', littleEndian: true };
    if (view.getUint16(0, false) === 0x3a55) return { format: 'seg2', littleEndian: false };
  }

  if (view.byteLength >= SEGY_HEADER_BYTES) {
    // SEG-Y has no magic number: a valid data sample format code is the best signal.
    // Big-endian is the standard, so it is tried first.
    if (SEGY_FORMAT_CODES.has(view.getUint16(SEGY_FORMAT_CODE_OFFSET, false))) {
      return { format: 'segy', littleEndian: false };
    }
    if (SEGY_FORMAT_CODES.has(view.getUint16(SEGY_FORMAT_CODE_OFFSET, true))) {
      return { format: 'segy', littleEndian: true };
    }
  }

  return null;
}
