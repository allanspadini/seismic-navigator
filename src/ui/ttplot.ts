import type { ShotState } from '../core/types';
import { formatTick, niceTicks, prepareCanvas, readTheme } from './dom';
import { strings as t } from './strings';

const MARGIN = { left: 58, top: 16, right: 16, bottom: 44 };

interface Point {
  shot: number;
  trace: number;
  px: number;
  py: number;
}

/**
 * Time-distance curves of every shot on one plot, for quality control. The
 * current shot is emphasised; the others share one muted colour, so the plot
 * stays readable with any number of shots.
 */
export class TimeDistancePlot {
  shots: ShotState[] = [];
  current = 0;
  /** Calculated traveltimes (s) per shot and trace, after an inversion. */
  calculated: ((number | null)[] | null)[] | null = null;
  private points: Point[] = [];
  private hovered: Point | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly callbacks: { hover(text: string): void; select(shot: number): void },
  ) {
    canvas.addEventListener('pointermove', (e) => {
      const hit = this.nearest(e);
      if (hit !== this.hovered) {
        this.hovered = hit;
        this.draw();
      }
      if (!hit) return this.callbacks.hover('');
      const shot = this.shots[hit.shot]!;
      const offset = shot.receiverX[hit.trace]! - shot.sourceX;
      this.callbacks.hover(
        `${shot.name} · ${t.traceLabel} ${hit.trace + 1} · x = ${formatTick(Number(shot.receiverX[hit.trace]!.toFixed(2)))} m · ` +
          `${t.offsetLabel} ${formatTick(Number(offset.toFixed(2)))} m · t = ${(shot.picks[hit.trace]! * 1000).toFixed(2)} ms`,
      );
    });
    canvas.addEventListener('pointerleave', () => {
      this.hovered = null;
      this.callbacks.hover('');
      this.draw();
    });
    canvas.addEventListener('click', (e) => {
      const hit = this.nearest(e);
      if (hit) this.callbacks.select(hit.shot);
    });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  private nearest(event: MouseEvent): Point | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    let best: Point | null = null;
    let bestDistance = 14;
    for (const point of this.points) {
      const distance = Math.hypot(point.px - x, point.py - y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = point;
      }
    }
    return best;
  }

  draw(): void {
    const { ctx, width, height } = prepareCanvas(this.canvas);
    const theme = readTheme();
    ctx.font = theme.font;
    this.points = [];

    let xMin = Infinity;
    let xMax = -Infinity;
    let tMax = 0;
    let pickCount = 0;
    this.shots.forEach((shot, s) => {
      xMin = Math.min(xMin, shot.sourceX, ...shot.receiverX);
      xMax = Math.max(xMax, shot.sourceX, ...shot.receiverX);
      shot.picks.forEach((pick, k) => {
        if (pick === null) return;
        pickCount++;
        tMax = Math.max(tMax, pick, this.calculated?.[s]?.[k] ?? 0);
      });
    });
    if (pickCount === 0) {
      ctx.fillStyle = theme.muted;
      ctx.textAlign = 'center';
      ctx.fillText(t.noPicksYet, width / 2, height / 2);
      return;
    }
    const pad = Math.max(1e-9, (xMax - xMin) * 0.03);
    xMin -= pad;
    xMax += pad;
    tMax *= 1.06;

    const w = width - MARGIN.left - MARGIN.right;
    const h = height - MARGIN.top - MARGIN.bottom;
    const px = (x: number): number => MARGIN.left + ((x - xMin) / (xMax - xMin)) * w;
    const py = (time: number): number => MARGIN.top + h - (time / tMax) * h;

    ctx.lineWidth = 1;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (const tick of niceTicks(0, tMax * 1000, Math.max(3, h / 50))) {
      const y = Math.round(py(tick / 1000)) + 0.5;
      ctx.strokeStyle = theme.grid;
      ctx.beginPath();
      ctx.moveTo(MARGIN.left, y);
      ctx.lineTo(MARGIN.left + w, y);
      ctx.stroke();
      ctx.fillStyle = theme.muted;
      ctx.fillText(formatTick(tick), MARGIN.left - 6, y);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const tick of niceTicks(xMin, xMax, Math.max(3, w / 80))) {
      ctx.fillStyle = theme.muted;
      ctx.fillText(formatTick(tick), px(tick), MARGIN.top + h + 14);
    }
    ctx.fillText(t.axisPosition, MARGIN.left + w / 2, height - 14);
    ctx.save();
    ctx.translate(14, MARGIN.top + h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textBaseline = 'middle';
    ctx.fillText(t.axisTime, 0, 0);
    ctx.restore();

    const drawShot = (s: number, emphasised: boolean): void => {
      const shot = this.shots[s]!;
      const color = emphasised ? theme.accent : theme.muted;
      const order = shot.receiverX.map((_, k) => k).sort((a, b) => shot.receiverX[a]! - shot.receiverX[b]!);

      const curve = (values: (number | null)[], dashed: boolean): void => {
        ctx.beginPath();
        let started = false;
        let previous = 0;
        for (const k of order) {
          const value = values[k];
          if (value === null || value === undefined) {
            started = false;
            continue;
          }
          // The curve breaks where it crosses the source: two separate branches.
          const side = Math.sign(shot.receiverX[k]! - shot.sourceX);
          if (started && side === previous) ctx.lineTo(px(shot.receiverX[k]!), py(value));
          else ctx.moveTo(px(shot.receiverX[k]!), py(value));
          started = true;
          previous = side;
        }
        ctx.setLineDash(dashed ? [5, 4] : []);
        ctx.stroke();
        ctx.setLineDash([]);
      };

      ctx.globalAlpha = emphasised ? 1 : 0.55;
      ctx.strokeStyle = color;
      ctx.lineWidth = emphasised ? 2 : 1;
      curve(shot.picks, false);
      const calc = this.calculated?.[s];
      if (calc) {
        ctx.strokeStyle = emphasised ? theme.calc : theme.muted;
        ctx.lineWidth = emphasised ? 2 : 1;
        curve(calc, true);
      }
      ctx.fillStyle = color;
      const radius = emphasised ? 4 : 2.5;
      shot.picks.forEach((pick, k) => {
        if (pick === null) return;
        const x = px(shot.receiverX[k]!);
        const y = py(pick);
        this.points.push({ shot: s, trace: k, px: x, py: y });
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, 2 * Math.PI);
        ctx.fill();
      });
      // Source position on the time-zero line.
      const sx = px(shot.sourceX);
      const sy = py(0);
      ctx.beginPath();
      ctx.moveTo(sx, sy - 9);
      ctx.lineTo(sx - 6, sy + 1);
      ctx.lineTo(sx + 6, sy + 1);
      ctx.fill();
      ctx.globalAlpha = 1;
    };
    this.shots.forEach((_, s) => {
      if (s !== this.current) drawShot(s, false);
    });
    if (this.shots[this.current]) drawShot(this.current, true);

    if (this.hovered) {
      ctx.strokeStyle = theme.text;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(this.hovered.px, this.hovered.py, 7, 0, 2 * Math.PI);
      ctx.stroke();
    }
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    ctx.strokeRect(MARGIN.left + 0.5, MARGIN.top + 0.5, w, h);
  }
}
