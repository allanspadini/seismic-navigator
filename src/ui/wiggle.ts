import type { ShotState } from '../core/types';
import { formatTick, niceTicks, prepareCanvas, readTheme } from './dom';
import { strings as t } from './strings';

export interface WiggleCallbacks {
  /** Called once before a picking gesture changes the picks (for undo). */
  beforeEdit(): void;
  picksChanged(): void;
  hover(text: string): void;
  viewChanged(): void;
}

interface Layout {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Plot position of each trace, in profile metres or trace index. */
  positions: number[];
  usesDistance: boolean;
  spacing: number;
  xMin: number;
  xMax: number;
  tMin: number;
  tMax: number;
}

const MARGIN = { left: 58, top: 46, right: 14, bottom: 12 };

/**
 * Wiggle display of one shot with first-arrival picking. Traces are drawn at
 * the receiver positions, time runs downwards, each trace is normalised by
 * its largest amplitude in the visible window and scaled by the gain.
 */
export class WiggleView {
  shot: ShotState | null = null;
  /** Calculated traveltimes (s) per trace, shown after an inversion. */
  calculated: (number | null)[] | null = null;
  gain = 1.5;
  clip = true;
  fill = true;
  density = false;
  /** Visible time window (s). tMax <= tMin shows the whole record. */
  tMin = 0;
  tMax = 0;

  private gesture: 'pick' | 'erase' | null = null;
  private lastIndex = -1;
  private lastTime = 0;
  private frame = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly callbacks: WiggleCallbacks,
  ) {
    canvas.addEventListener('pointerdown', (e) => this.pointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.pointerMove(e));
    canvas.addEventListener('pointerup', () => this.endGesture());
    canvas.addEventListener('pointercancel', () => this.endGesture());
    canvas.addEventListener('pointerleave', () => this.callbacks.hover(''));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    new ResizeObserver(() => this.requestDraw()).observe(canvas);
  }

  /** Time span of the whole record (s). */
  fullRange(): [number, number] {
    let start = Infinity;
    let end = -Infinity;
    for (const trace of this.shot?.traces ?? []) {
      start = Math.min(start, trace.delay);
      end = Math.max(end, trace.delay + trace.samples.length * trace.sampleInterval);
    }
    return end > start ? [start, end] : [0, 1];
  }

  resetTime(): void {
    this.tMin = 0;
    this.tMax = 0;
    this.requestDraw();
  }

  requestDraw(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private layout(): Layout | null {
    const shot = this.shot;
    if (!shot || shot.traces.length === 0) return null;
    const width = this.canvas.clientWidth - MARGIN.left - MARGIN.right;
    const height = this.canvas.clientHeight - MARGIN.top - MARGIN.bottom;
    if (width < 20 || height < 20) return null;

    const xs = shot.receiverX;
    const usesDistance = xs.every((x) => Number.isFinite(x)) && new Set(xs).size === xs.length;
    const positions = usesDistance ? xs : xs.map((_, i) => i + 1);
    const sorted = [...positions].sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i]! - sorted[i - 1]!);
    gaps.sort((a, b) => a - b);
    const spacing = gaps.length > 0 ? gaps[gaps.length >> 1]! : 1;

    const [fullMin, fullMax] = this.fullRange();
    const windowed = this.tMax > this.tMin;
    return {
      left: MARGIN.left,
      top: MARGIN.top,
      width,
      height,
      positions,
      usesDistance,
      spacing,
      xMin: sorted[0]! - spacing,
      xMax: sorted[sorted.length - 1]! + spacing,
      tMin: windowed ? this.tMin : fullMin,
      tMax: windowed ? this.tMax : fullMax,
    };
  }

  draw(): void {
    const { ctx, width, height } = prepareCanvas(this.canvas);
    const theme = readTheme();
    ctx.font = theme.font;
    const shot = this.shot;
    const lay = this.layout();
    if (!shot || !lay) {
      ctx.fillStyle = theme.muted;
      ctx.textAlign = 'center';
      ctx.fillText(t.noShotSelected, width / 2, height / 2);
      return;
    }

    const px = (x: number): number => lay.left + ((x - lay.xMin) / (lay.xMax - lay.xMin)) * lay.width;
    const py = (time: number): number => lay.top + ((time - lay.tMin) / (lay.tMax - lay.tMin)) * lay.height;
    const bottom = lay.top + lay.height;
    const halfWidth = 0.5 * lay.spacing;

    // Time grid and axis.
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    for (const tick of niceTicks(lay.tMin * 1000, lay.tMax * 1000, Math.max(3, lay.height / 50))) {
      const y = Math.round(py(tick / 1000)) + 0.5;
      ctx.strokeStyle = theme.grid;
      ctx.beginPath();
      ctx.moveTo(lay.left, y);
      ctx.lineTo(lay.left + lay.width, y);
      ctx.stroke();
      ctx.fillStyle = theme.muted;
      ctx.fillText(formatTick(tick), lay.left - 6, y);
    }
    ctx.save();
    ctx.translate(14, lay.top + lay.height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillStyle = theme.muted;
    ctx.fillText(t.axisTime, 0, 0);
    ctx.restore();

    // Position axis: one label per receiver, thinned when crowded.
    const pixelsPerTrace = lay.width / Math.max(1, shot.traces.length + 1);
    const every = Math.max(1, Math.ceil(38 / pixelsPerTrace));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = theme.muted;
    lay.positions.forEach((position, k) => {
      if (k % every === 0) ctx.fillText(formatTick(Number(position.toFixed(2))), px(position), lay.top - 6);
    });
    ctx.textAlign = 'right';
    ctx.fillText(lay.usesDistance ? t.axisPosition : t.axisTraceNumber, lay.left + lay.width, 14);

    // Source marker, or an arrow when the source is outside the spread.
    if (lay.usesDistance) {
      const inside = shot.sourceX >= lay.xMin && shot.sourceX <= lay.xMax;
      const x = inside ? px(shot.sourceX) : shot.sourceX < lay.xMin ? lay.left + 6 : lay.left + lay.width - 6;
      ctx.fillStyle = theme.pick;
      ctx.beginPath();
      if (inside) {
        ctx.moveTo(x, lay.top - 1);
        ctx.lineTo(x - 6, lay.top - 11);
        ctx.lineTo(x + 6, lay.top - 11);
      } else {
        const dir = shot.sourceX < lay.xMin ? -1 : 1;
        ctx.moveTo(x + 6 * dir, lay.top - 22);
        ctx.lineTo(x - 4 * dir, lay.top - 28);
        ctx.lineTo(x - 4 * dir, lay.top - 16);
      }
      ctx.fill();
      ctx.textAlign = inside ? 'center' : shot.sourceX < lay.xMin ? 'left' : 'right';
      ctx.textBaseline = 'bottom';
      const label = `${t.sourceLabel} ${formatTick(Number(shot.sourceX.toFixed(2)))} m`;
      const labelX = inside ? Math.min(Math.max(x, lay.left + 40), lay.left + lay.width - 40) : x + (shot.sourceX < lay.xMin ? 10 : -10);
      ctx.fillText(label, labelX, inside ? lay.top - 22 : lay.top - 16);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(lay.left, lay.top, lay.width, lay.height);
    ctx.clip();

    const rows = Math.max(1, Math.round(lay.height));
    shot.traces.forEach((trace, k) => {
      const dt = trace.sampleInterval;
      const n = trace.samples.length;
      const i0 = Math.max(0, Math.floor((lay.tMin - trace.delay) / dt));
      const i1 = Math.min(n - 1, Math.ceil((lay.tMax - trace.delay) / dt));
      if (i1 <= i0) return;
      let peak = 0;
      for (let i = i0; i <= i1; i++) peak = Math.max(peak, Math.abs(trace.samples[i]!));
      if (!(peak > 0)) return;
      const scale = this.gain / peak;
      const base = px(lay.positions[k]!);
      const unit = px(lay.positions[k]! + halfWidth) - base;
      const limit = this.clip ? 1.9 : Infinity;

      if (this.density) {
        // Variable density: blue for negative, red for positive, neutral at zero.
        const columnWidth = Math.abs(px(lay.positions[k]! + halfWidth) - px(lay.positions[k]! - halfWidth));
        for (let row = 0; row < rows; row++) {
          const time = lay.tMin + ((row + 0.5) / rows) * (lay.tMax - lay.tMin);
          const i = Math.round((time - trace.delay) / dt);
          if (i < 0 || i >= n) continue;
          const a = Math.max(-1, Math.min(1, trace.samples[i]! * scale));
          const alpha = Math.abs(a);
          if (alpha < 0.03) continue;
          ctx.fillStyle = a > 0 ? `rgba(200,60,50,${alpha})` : `rgba(45,105,200,${alpha})`;
          ctx.fillRect(base - columnWidth / 2, lay.top + row, columnWidth, 1.02);
        }
      }

      // At most ~2 points per pixel row: keep the largest sample of each bin.
      const stride = Math.max(1, Math.floor((i1 - i0) / (2 * rows)));
      const xsPath: number[] = [];
      const ysPath: number[] = [];
      for (let i = i0; i <= i1; i += stride) {
        let pickIndex = i;
        if (stride > 1) {
          let largest = -1;
          for (let m = i; m < Math.min(i + stride, i1 + 1); m++) {
            const magnitude = Math.abs(trace.samples[m]!);
            if (magnitude > largest) {
              largest = magnitude;
              pickIndex = m;
            }
          }
        }
        const a = Math.max(-limit, Math.min(limit, trace.samples[pickIndex]! * scale));
        xsPath.push(a);
        ysPath.push(py(trace.delay + pickIndex * dt));
      }

      if (this.fill && !this.density) {
        ctx.fillStyle = theme.fill;
        ctx.beginPath();
        ctx.moveTo(base, ysPath[0]!);
        for (let m = 0; m < xsPath.length; m++) ctx.lineTo(base + Math.max(0, xsPath[m]!) * unit, ysPath[m]!);
        ctx.lineTo(base, ysPath[ysPath.length - 1]!);
        ctx.fill();
      }
      ctx.strokeStyle = theme.trace;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let m = 0; m < xsPath.length; m++) {
        if (m === 0) ctx.moveTo(base + xsPath[m]! * unit, ysPath[m]!);
        else ctx.lineTo(base + xsPath[m]! * unit, ysPath[m]!);
      }
      ctx.stroke();
    });

    // Calculated times (dashed) and picks (line plus a bar on each trace).
    const order = lay.positions.map((_, k) => k).sort((a, b) => lay.positions[a]! - lay.positions[b]!);
    const drawCurve = (values: (number | null)[], color: string, dashed: boolean): void => {
      ctx.strokeStyle = color;
      ctx.lineWidth = dashed ? 1.5 : 1.25;
      ctx.setLineDash(dashed ? [5, 4] : []);
      ctx.beginPath();
      let started = false;
      for (const k of order) {
        const value = values[k];
        if (value === null || value === undefined) {
          started = false;
          continue;
        }
        if (started) ctx.lineTo(px(lay.positions[k]!), py(value));
        else ctx.moveTo(px(lay.positions[k]!), py(value));
        started = true;
      }
      ctx.stroke();
      ctx.setLineDash([]);
    };
    if (this.calculated) drawCurve(this.calculated, theme.calc, true);
    drawCurve(shot.picks, theme.pick, false);
    ctx.strokeStyle = theme.pick;
    ctx.lineWidth = 2.5;
    const bar = Math.max(4, Math.min(14, Math.abs(px(halfWidth) - px(0)) * 0.8));
    ctx.beginPath();
    shot.picks.forEach((pick, k) => {
      if (pick === null) return;
      const x = px(lay.positions[k]!);
      ctx.moveTo(x - bar, py(pick));
      ctx.lineTo(x + bar, py(pick));
    });
    ctx.stroke();
    ctx.restore();

    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    ctx.strokeRect(lay.left + 0.5, lay.top + 0.5, lay.width, bottom - lay.top);
  }

  /** Trace index and time under a pointer event, or null outside the plot. */
  private locate(event: PointerEvent | WheelEvent): { index: number; time: number; lay: Layout } | null {
    const lay = this.layout();
    if (!lay) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < lay.left || x > lay.left + lay.width || y < lay.top || y > lay.top + lay.height) return null;
    const position = lay.xMin + ((x - lay.left) / lay.width) * (lay.xMax - lay.xMin);
    const time = lay.tMin + ((y - lay.top) / lay.height) * (lay.tMax - lay.tMin);
    let index = 0;
    let nearest = Infinity;
    lay.positions.forEach((p, k) => {
      const distance = Math.abs(p - position);
      if (distance < nearest) {
        nearest = distance;
        index = k;
      }
    });
    return { index, time, lay };
  }

  private pointerDown(event: PointerEvent): void {
    if (!this.shot || (event.button !== 0 && event.button !== 2)) return;
    const hit = this.locate(event);
    if (!hit) return;
    event.preventDefault();
    this.canvas.setPointerCapture(event.pointerId);
    this.gesture = event.button === 2 || event.ctrlKey || event.metaKey ? 'erase' : 'pick';
    this.lastIndex = -1;
    this.callbacks.beforeEdit();
    this.apply(hit.index, hit.time);
  }

  private pointerMove(event: PointerEvent): void {
    const hit = this.locate(event);
    if (!hit || !this.shot) {
      this.callbacks.hover('');
      return;
    }
    const position = hit.lay.usesDistance ? ` · x = ${formatTick(Number(hit.lay.positions[hit.index]!.toFixed(2)))} m` : '';
    this.callbacks.hover(`${t.traceLabel} ${hit.index + 1}${position} · t = ${(hit.time * 1000).toFixed(2)} ms`);
    if (this.gesture) this.apply(hit.index, hit.time);
  }

  private endGesture(): void {
    this.gesture = null;
    this.lastIndex = -1;
  }

  /** Sets or erases picks from the last applied trace up to this one. */
  private apply(index: number, time: number): void {
    const shot = this.shot;
    if (!shot || !this.gesture) return;
    const from = this.lastIndex < 0 ? index : this.lastIndex;
    const step = index >= from ? 1 : -1;
    for (let k = from; k !== index + step; k += step) {
      if (this.gesture === 'erase') {
        shot.picks[k] = null;
        continue;
      }
      // Traces skipped by a fast drag get a time interpolated along the drag.
      const fraction = index === from ? 1 : (k - from) / (index - from);
      const value = this.lastIndex < 0 ? time : this.lastTime + (time - this.lastTime) * fraction;
      const trace = shot.traces[k]!;
      const end = trace.delay + (trace.samples.length - 1) * trace.sampleInterval;
      shot.picks[k] = Math.max(trace.delay, Math.min(end, value));
    }
    this.lastIndex = index;
    this.lastTime = time;
    this.callbacks.picksChanged();
    this.requestDraw();
  }

  private wheel(event: WheelEvent): void {
    const hit = this.locate(event);
    if (!hit) return;
    event.preventDefault();
    const [fullMin, fullMax] = this.fullRange();
    const { tMin, tMax } = hit.lay;
    let newMin: number;
    let newMax: number;
    if (event.shiftKey) {
      const shift = (tMax - tMin) * 0.1 * Math.sign(event.deltaY || event.deltaX);
      newMin = tMin + shift;
      newMax = tMax + shift;
    } else {
      const factor = event.deltaY > 0 ? 1.25 : 0.8;
      newMin = hit.time - (hit.time - tMin) * factor;
      newMax = hit.time + (tMax - hit.time) * factor;
    }
    const span = Math.min(newMax - newMin, fullMax - fullMin);
    if (span < 1e-4) return;
    newMin = Math.max(fullMin, Math.min(fullMax - span, newMin));
    this.tMin = newMin;
    this.tMax = newMin + span;
    if (span >= fullMax - fullMin) this.tMax = this.tMin = 0;
    this.callbacks.viewChanged();
    this.requestDraw();
  }
}
