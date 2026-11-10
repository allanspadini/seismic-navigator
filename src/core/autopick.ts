/**
 * Automatic first-arrival pick for one trace, using the Akaike Information
 * Criterion (AIC) on the part of the trace that precedes its strongest
 * sample. Returns the pick time in seconds, or null when the trace is flat.
 *
 * It is an aid: results always need visual review.
 */
export function autoPick(samples: Float32Array, sampleInterval: number, delay: number): number | null {
  const n = samples.length;
  if (n < 16) return null;

  let mean = 0;
  for (let i = 0; i < n; i++) mean += samples[i]!;
  mean /= n;

  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(samples[i]! - mean));
  if (!(peak > 0)) return null;

  let peakIndex = 0;
  for (let i = 0; i < n; i++) if (Math.abs(samples[i]! - mean) === peak) peakIndex = i;
  const limit = Math.min(n, peakIndex + 1);
  if (limit < 16) return delay + peakIndex * sampleInterval;

  // Prefix sums give the variance of any segment in O(1).
  const sum = new Float64Array(limit + 1);
  const sumSq = new Float64Array(limit + 1);
  for (let i = 0; i < limit; i++) {
    const v = samples[i]! - mean;
    sum[i + 1] = sum[i]! + v;
    sumSq[i + 1] = sumSq[i]! + v * v;
  }
  const floor = (peak * 1e-6) ** 2;
  const variance = (a: number, b: number): number => {
    const count = b - a;
    const m = (sum[b]! - sum[a]!) / count;
    return Math.max((sumSq[b]! - sumSq[a]!) / count - m * m, floor);
  };

  const aicPick = (end: number): number => {
    let best = -1;
    let bestAic = Infinity;
    for (let k = 4; k <= end - 4; k++) {
      const aic = k * Math.log(variance(0, k)) + (end - k) * Math.log(variance(k, end));
      if (aic < bestAic) {
        bestAic = aic;
        best = k;
      }
    }
    return best;
  };

  // The window first ends at the strongest sample. It is then shortened to just
  // past the pick and the pick repeated, so a weak first arrival ahead of a
  // stronger later phase is not missed.
  let end = limit;
  let pick = aicPick(end);
  for (let pass = 0; pass < 4 && pick >= 0; pass++) {
    const shorter = pick + Math.max(8, Math.round(0.15 * pick));
    if (shorter >= end || shorter < 16) break;
    end = shorter;
    pick = aicPick(end);
  }
  if (pick < 0) return null;
  return delay + pick * sampleInterval;
}
