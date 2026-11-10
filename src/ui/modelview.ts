import type { InversionResult } from '../core/tomo/invert';
import { colorAt, cssColorAt } from './colormap';
import { formatTick, niceTicks, prepareCanvas, readTheme } from './dom';
import { strings as t } from './strings';

const MARGIN = { left: 58, top: 30, right: 92, bottom: 44 };

export interface Station {
  x: number;
  z: number;
}

/** Velocity model as a colour image with stations, rays and a colour scale. */
export class ModelView {
  result: InversionResult | null = null;
  sources: Station[] = [];
  receivers: Station[] = [];
  showRays = true;
  /** Fade out the part of the model that no ray crosses. */
  maskUncovered = true;
  private image: HTMLCanvasElement | null = null;
  private range: [number, number] = [0, 1];
  private covered: Uint8Array = new Uint8Array(0);
  private transform: { px(x: number): number; py(z: number): number; scaleX: number; scaleZ: number } | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly callbacks: { hover(text: string): void },
  ) {
    canvas.addEventListener('pointermove', (e) => this.hover(e));
    canvas.addEventListener('pointerleave', () => this.callbacks.hover(''));
    new ResizeObserver(() => this.draw()).observe(canvas.parentElement ?? canvas);
  }

  /** Rebuilds the cached image; call after changing `result` or `maskUncovered`. */
  update(): void {
    const result = this.result;
    this.image = null;
    if (!result) return this.draw();
    const { grid, active, velocity, coverage } = result;
    const { nx, nz } = grid;

    // A node counts as covered down to the deepest ray in its column.
    this.covered = new Uint8Array(nx * nz);
    for (let i = 0; i < nx; i++) {
      let deepest = -1;
      for (let j = 0; j < nz; j++) if (coverage[j * nx + i]! > 0) deepest = j;
      for (let j = 0; j <= deepest; j++) if (active[j * nx + i]) this.covered[j * nx + i] = 1;
    }

    let low = Infinity;
    let high = -Infinity;
    for (let k = 0; k < nx * nz; k++) {
      if (!active[k] || (this.maskUncovered && !this.covered[k])) continue;
      low = Math.min(low, velocity[k]!);
      high = Math.max(high, velocity[k]!);
    }
    if (!(high > low)) {
      low = Number.isFinite(low) ? low * 0.9 : 0;
      high = Number.isFinite(high) ? high * 1.1 : 1;
    }
    this.range = [low, high];

    const image = document.createElement('canvas');
    image.width = nx;
    image.height = nz;
    const ictx = image.getContext('2d')!;
    const data = ictx.createImageData(nx, nz);
    for (let k = 0; k < nx * nz; k++) {
      if (!active[k]) continue;
      colorAt((velocity[k]! - low) / (high - low), data.data, 4 * k);
      data.data[4 * k + 3] = this.maskUncovered && !this.covered[k] ? 45 : 255;
    }
    ictx.putImageData(data, 0, 0);
    this.image = image;
    this.draw();
  }

  draw(): void {
    const result = this.result;
    const available = (this.canvas.parentElement?.clientWidth ?? 600) - 2;
    if (!result || !this.image) {
      this.canvas.style.height = '160px';
      const { ctx, width, height } = prepareCanvas(this.canvas);
      const theme = readTheme();
      ctx.font = theme.font;
      ctx.fillStyle = theme.muted;
      ctx.textAlign = 'center';
      ctx.fillText(t.noModelYet, width / 2, height / 2);
      this.transform = null;
      return;
    }
    const { grid } = result;
    const xMin = grid.x0 - grid.h / 2;
    const xMax = grid.x0 + (grid.nx - 0.5) * grid.h;
    const zMax = grid.zTop + grid.h / 2;
    const zMin = grid.zTop - (grid.nz - 0.5) * grid.h;

    // True scale when it fits; otherwise exaggerate the vertical or narrow the plot.
    let plotWidth = Math.max(120, available - MARGIN.left - MARGIN.right);
    const scaleX = plotWidth / (xMax - xMin);
    let exaggeration = 1;
    let plotHeight = (zMax - zMin) * scaleX;
    if (plotHeight < 200) {
      exaggeration = Math.ceil(200 / plotHeight);
      plotHeight *= exaggeration;
    } else if (plotHeight > 520) {
      plotWidth *= 520 / plotHeight;
      plotHeight = 520;
    }
    this.canvas.style.height = `${Math.round(plotHeight + MARGIN.top + MARGIN.bottom)}px`;
    const { ctx } = prepareCanvas(this.canvas);
    const theme = readTheme();
    ctx.font = theme.font;

    const px = (x: number): number => MARGIN.left + ((x - xMin) / (xMax - xMin)) * plotWidth;
    const py = (z: number): number => MARGIN.top + ((zMax - z) / (zMax - zMin)) * plotHeight;
    this.transform = { px, py, scaleX: plotWidth / (xMax - xMin), scaleZ: plotHeight / (zMax - zMin) };

    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.image, MARGIN.left, MARGIN.top, plotWidth, plotHeight);

    ctx.save();
    ctx.beginPath();
    ctx.rect(MARGIN.left, MARGIN.top, plotWidth, plotHeight);
    ctx.clip();
    if (this.showRays) {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 0.75;
      ctx.beginPath();
      for (const ray of result.rays) {
        for (let i = 0; i + 1 < ray.length; i += 2) {
          if (i === 0) ctx.moveTo(px(ray[i]!), py(ray[i + 1]!));
          else ctx.lineTo(px(ray[i]!), py(ray[i + 1]!));
        }
      }
      ctx.stroke();
    }
    ctx.restore();

    // Stations: receivers as small ticks, sources as triangles above the surface.
    ctx.fillStyle = theme.text;
    for (const r of this.receivers) ctx.fillRect(px(r.x) - 1, py(r.z) - 6, 2, 6);
    ctx.fillStyle = theme.pick;
    ctx.strokeStyle = theme.surface;
    ctx.lineWidth = 1;
    for (const s of this.sources) {
      const x = px(s.x);
      const y = py(s.z);
      ctx.beginPath();
      ctx.moveTo(x, y - 1);
      ctx.lineTo(x - 5, y - 10);
      ctx.lineTo(x + 5, y - 10);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // Axes.
    ctx.fillStyle = theme.muted;
    ctx.strokeStyle = theme.grid;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const tick of niceTicks(xMin, xMax, Math.max(3, plotWidth / 80))) {
      ctx.fillText(formatTick(tick), px(tick), MARGIN.top + plotHeight + 6);
    }
    ctx.fillText(t.axisPosition, MARGIN.left + plotWidth / 2, MARGIN.top + plotHeight + 24);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const tick of niceTicks(zMin, zMax, Math.max(2, plotHeight / 45))) {
      ctx.fillText(formatTick(tick), MARGIN.left - 6, py(tick));
    }
    ctx.save();
    ctx.translate(14, MARGIN.top + plotHeight / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText(t.axisElevation, 0, 0);
    ctx.restore();
    ctx.strokeRect(MARGIN.left + 0.5, MARGIN.top + 0.5, plotWidth, plotHeight);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(exaggeration > 1 ? t.verticalExaggeration(exaggeration) : t.trueScale, MARGIN.left, MARGIN.top - 8);

    // Colour scale.
    const barX = MARGIN.left + plotWidth + 18;
    const barHeight = Math.min(plotHeight, 260);
    const [low, high] = this.range;
    for (let row = 0; row < barHeight; row++) {
      ctx.fillStyle = cssColorAt(1 - row / (barHeight - 1));
      ctx.fillRect(barX, MARGIN.top + row, 14, 1.5);
    }
    ctx.strokeRect(barX + 0.5, MARGIN.top + 0.5, 14, barHeight);
    ctx.fillStyle = theme.muted;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const tick of niceTicks(low, high, 5)) {
      ctx.fillText(formatTick(tick), barX + 19, MARGIN.top + (1 - (tick - low) / (high - low)) * (barHeight - 1));
    }
    ctx.textBaseline = 'bottom';
    ctx.fillText(t.velocityUnit, barX, MARGIN.top - 8);
  }

  private hover(event: PointerEvent): void {
    const result = this.result;
    const transform = this.transform;
    if (!result || !transform) return;
    const rect = this.canvas.getBoundingClientRect();
    const { grid } = result;
    const x = grid.x0 - grid.h / 2 + (event.clientX - rect.left - MARGIN.left) / transform.scaleX;
    const z = grid.zTop + grid.h / 2 - (event.clientY - rect.top - MARGIN.top) / transform.scaleZ;
    const i = Math.round((x - grid.x0) / grid.h);
    const j = Math.round((grid.zTop - z) / grid.h);
    if (i < 0 || i >= grid.nx || j < 0 || j >= grid.nz || !result.active[j * grid.nx + i]) {
      return this.callbacks.hover('');
    }
    const k = j * grid.nx + i;
    this.callbacks.hover(
      `x = ${x.toFixed(1)} m · ${t.elevationLabel} = ${z.toFixed(1)} m · v = ${Math.round(result.velocity[k]!)} m/s` +
        (this.covered[k] ? '' : ` · ${t.noCoverage}`),
    );
  }
}
