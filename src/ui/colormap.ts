// Viridis: perceptually uniform, monotonic in lightness and readable with
// colour-vision deficiency. Low velocity is dark, high velocity is light.
const STOPS = ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'];

const TABLE = new Uint8Array(256 * 3);
{
  const rgb = STOPS.map((hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)));
  for (let k = 0; k < 256; k++) {
    const position = (k / 255) * (rgb.length - 1);
    const a = Math.min(rgb.length - 2, Math.floor(position));
    const f = position - a;
    for (let c = 0; c < 3; c++) TABLE[3 * k + c] = Math.round(rgb[a]![c]! + (rgb[a + 1]![c]! - rgb[a]![c]!) * f);
  }
}

/** Writes the colour for a value in [0, 1] into `out` at `offset` (RGB). */
export function colorAt(value: number, out: Uint8ClampedArray, offset: number): void {
  const k = 3 * Math.max(0, Math.min(255, Math.round(value * 255)));
  out[offset] = TABLE[k]!;
  out[offset + 1] = TABLE[k + 1]!;
  out[offset + 2] = TABLE[k + 2]!;
}

export function cssColorAt(value: number): string {
  const rgb = new Uint8ClampedArray(3);
  colorAt(value, rgb, 0);
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}
