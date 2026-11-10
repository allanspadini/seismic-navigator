/** Surface profile as points sorted by x; elevation is interpolated linearly. */
export type Topography = { x: number; z: number }[];

/** Parses "x z" lines (space, tab, comma or semicolon separated). Bad lines are skipped. */
export function parseTopography(text: string): Topography {
  const points: Topography = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/[\s,;]+/).filter(Boolean);
    if (parts.length < 2) continue;
    const x = Number(parts[0]!.replace(',', '.'));
    const z = Number(parts[1]!.replace(',', '.'));
    if (Number.isFinite(x) && Number.isFinite(z)) points.push({ x, z });
  }
  return normalizeTopography(points);
}

/** Sorts by x and averages points that share the same x. */
export function normalizeTopography(points: Topography): Topography {
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const out: Topography = [];
  let count = 0;
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-9) {
      last.z = (last.z * count + p.z) / (count + 1);
      count++;
    } else {
      out.push({ x: p.x, z: p.z });
      count = 1;
    }
  }
  return out;
}

/** Elevation at x; constant beyond the ends, 0 for an empty profile. */
export function elevationAt(topo: Topography, x: number): number {
  const n = topo.length;
  if (n === 0) return 0;
  if (x <= topo[0]!.x) return topo[0]!.z;
  if (x >= topo[n - 1]!.x) return topo[n - 1]!.z;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (topo[mid]!.x <= x) lo = mid;
    else hi = mid;
  }
  const a = topo[lo]!;
  const b = topo[hi]!;
  return a.z + ((b.z - a.z) * (x - a.x)) / (b.x - a.x);
}
