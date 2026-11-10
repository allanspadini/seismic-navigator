export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

export interface Theme {
  surface: string;
  text: string;
  muted: string;
  grid: string;
  trace: string;
  fill: string;
  pick: string;
  calc: string;
  accent: string;
  font: string;
}

/** Canvas colours come from the CSS custom properties, so they follow the theme. */
export function readTheme(): Theme {
  const style = getComputedStyle(document.documentElement);
  const get = (name: string): string => style.getPropertyValue(name).trim();
  return {
    surface: get('--surface'),
    text: get('--text'),
    muted: get('--muted'),
    grid: get('--border'),
    trace: get('--trace'),
    fill: get('--trace-fill'),
    pick: get('--pick'),
    calc: get('--calc'),
    accent: get('--accent'),
    font: '12px ' + (style.fontFamily || 'sans-serif'),
  };
}

/** Sizes the canvas backing store to its CSS box and returns a context in CSS pixels. */
export function prepareCanvas(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; width: number; height: number } {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

/** Tick positions at "nice" steps (1, 2, 5 × 10^n) covering [min, max]. */
export function niceTicks(min: number, max: number, target: number): number[] {
  const range = max - min;
  if (!(range > 0)) return [min];
  const rough = range / Math.max(1, target);
  const power = 10 ** Math.floor(Math.log10(rough));
  const ratio = rough / power;
  const step = (ratio < 1.5 ? 1 : ratio < 3.5 ? 2 : ratio < 7.5 ? 5 : 10) * power;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step - 1e-9) * step; v <= max + step * 1e-9; v += step) {
    ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  return ticks;
}

export function formatTick(value: number): string {
  return Number(value.toPrecision(6)).toString();
}

export function download(name: string, content: string | Blob, type = 'text/plain'): void {
  const blob = typeof content === 'string' ? new Blob([content], { type }) : content;
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
