import type { Shot } from '../core/types';
import { detectFormat } from './detect';
import { parseSeg2 } from './seg2';
import { parseSegy } from './segy';

export class UnknownFormatError extends Error {}

/** Reads a SEG-Y or SEG-2 file into shots. The format comes from the content. */
export function readSeismicFile(buffer: ArrayBuffer, name: string): Shot[] {
  const detected = detectFormat(buffer);
  if (!detected) throw new UnknownFormatError(name);
  if (detected.format === 'seg2') return [parseSeg2(buffer, name)];
  return parseSegy(buffer, name, detected.littleEndian);
}
