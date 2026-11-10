import './style.css';
import { autoPick } from './core/autopick';
import { createSyntheticSurvey } from './core/synthetic';
import { suggestParams, type InversionInput, type InversionParams, type InversionResult, type InversionShot } from './core/tomo/invert';
import { elevationAt, normalizeTopography, parseTopography, type Topography } from './core/topography';
import { createShotState, type Shot, type ShotState } from './core/types';
import { applyProject, modelToCsv, picksToCsv, projectToJson } from './io/export';
import { detectFormat } from './io/detect';
import { readSeismicFile, UnknownFormatError } from './io/read';
import { download, el } from './ui/dom';
import { ModelView } from './ui/modelview';
import { strings as t } from './ui/strings';
import { TimeDistancePlot } from './ui/ttplot';
import { WiggleView } from './ui/wiggle';
import type { InversionMessage } from './workers/inversion.worker';

type Tab = 'pick' | 'curves' | 'inversion';

const MAX_NODES = 400_000;

const state = {
  shots: [] as ShotState[],
  current: 0,
  tab: 'pick' as Tab,
  topography: '',
  params: null as InversionParams | null,
  paramsEdited: false,
  result: null as InversionResult | null,
  /** Calculated times per shot and trace, aligned with `shots`. */
  calculated: null as ((number | null)[] | null)[] | null,
  stale: false,
  /** Each entry is one user action, which may have changed several shots. */
  undo: [] as { shot: ShotState; picks: (number | null)[] }[][],
  worker: null as Worker | null,
  /** True while the start screen is shown, even with shots loaded. */
  home: true,
  /** True while the loaded shots are the built-in example. */
  exampleLoaded: false,
};

// ---------------------------------------------------------------- elements

const message = el('p', { className: 'message', hidden: true });
message.setAttribute('role', 'status');

function showMessage(lines: string | string[], kind: 'info' | 'error' = 'info'): void {
  const list = Array.isArray(lines) ? lines : [lines];
  message.hidden = list.length === 0;
  message.className = `message ${kind}`;
  message.replaceChildren(...list.flatMap((line, i) => (i === 0 ? [line] : [el('br'), line])));
}

const fileInput = el('input', { type: 'file', multiple: true, hidden: true });
const projectInput = el('input', { type: 'file', hidden: true });

const button = (label: string, onclick: () => void, className = ''): HTMLButtonElement =>
  el('button', { type: 'button', textContent: label, onclick, className });

const saveProjectButton = button(t.saveProject, saveProject, 'secondary');
saveProjectButton.title = t.saveProjectHint;
const openProjectButton = button(t.openProject, () => projectInput.click(), 'secondary');
openProjectButton.title = t.openProjectHint;
// Light theme by default; the choice is remembered in this browser.
const THEME_KEY = 'seismic-navigator-theme';
function storedTheme(): 'light' | 'dark' {
  try {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}
function applyTheme(theme: 'light' | 'dark'): void {
  document.documentElement.dataset.theme = theme;
  themeButton.textContent = theme === 'dark' ? t.useLightTheme : t.useDarkTheme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage may be blocked; the theme still applies for this visit.
  }
}
const themeButton = button('', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  refresh();
  if (state.result && !state.home) modelView.draw();
}, 'secondary');
applyTheme(storedTheme());

const resumeButton = button('', () => ((state.home = false), refresh()));
const sessionRow = el('div', { className: 'row center' }, [resumeButton, button(t.resetSession, confirmReset, 'secondary')]);

const emptyState = el('div', { className: 'drop-zone' }, [
  sessionRow,
  el('p', { className: 'drop-title', textContent: t.dropHint }),
  el('div', { className: 'row center' }, [
    button(t.openFiles, () => fileInput.click()),
    button(t.loadExample, loadExample, 'secondary'),
  ]),
  el('p', { className: 'muted', textContent: t.formatsNote }),
  el('p', { className: 'muted', textContent: t.privacyNote }),
  el('p', { className: 'muted', textContent: t.projectNote }),
]);

const tabButtons: Record<Tab, HTMLButtonElement> = {
  pick: button(t.tabPick, () => setTab('pick'), 'tab'),
  curves: button(t.tabCurves, () => setTab('curves'), 'tab'),
  inversion: button(t.tabInversion, () => setTab('inversion'), 'tab'),
};
const tabBar = el('nav', { className: 'tabs' }, Object.values(tabButtons));

// Picking tab.
const shotList = el('ul', { className: 'shot-list' });
const wiggleCanvas = el('canvas', { className: 'wiggle' });
const pickReadout = el('span', { className: 'readout' });
const wiggle = new WiggleView(wiggleCanvas, {
  beforeEdit: () => pushUndo([currentShot()]),
  picksChanged: () => picksChanged(),
  hover: (text) => (pickReadout.textContent = text),
  viewChanged: () => syncTimeInput(),
});

const gainInput = el('input', { type: 'range', min: '0.2', max: '12', step: '0.1', value: String(wiggle.gain) });
const gainValue = el('span', { className: 'value', textContent: wiggle.gain.toFixed(1) });
gainInput.oninput = () => {
  wiggle.gain = Number(gainInput.value);
  gainValue.textContent = wiggle.gain.toFixed(1);
  wiggle.requestDraw();
};
const checkbox = (label: string, checked: boolean, onchange: (value: boolean) => void): HTMLLabelElement => {
  const input = el('input', { type: 'checkbox', checked });
  input.onchange = () => onchange(input.checked);
  return el('label', { className: 'check' }, [input, label]);
};
const timeInput = el('input', { type: 'number', min: '1', step: '10', className: 'short' });
timeInput.onchange = () => {
  const value = Number(timeInput.value) / 1000;
  const [start, end] = wiggle.fullRange();
  if (value > start && value < end) {
    wiggle.tMin = Math.max(start, Math.min(wiggle.tMin, value - 1e-3));
    if (!(wiggle.tMax > wiggle.tMin)) wiggle.tMin = start;
    wiggle.tMax = value;
  } else {
    wiggle.resetTime();
  }
  syncTimeInput();
  wiggle.requestDraw();
};
function syncTimeInput(): void {
  const [, end] = wiggle.fullRange();
  timeInput.value = ((wiggle.tMax > wiggle.tMin ? wiggle.tMax : end) * 1000).toFixed(0);
}

const undoButton = button(t.undo, undo, 'secondary');
const toolbar = el('div', { className: 'toolbar' }, [
  el('label', { className: 'field inline' }, [t.gain, gainInput, gainValue]),
  checkbox(t.clip, wiggle.clip, (v) => ((wiggle.clip = v), wiggle.requestDraw())),
  checkbox(t.fill, wiggle.fill, (v) => ((wiggle.fill = v), wiggle.requestDraw())),
  checkbox(t.density, wiggle.density, (v) => ((wiggle.density = v), wiggle.requestDraw())),
  el('label', { className: 'field inline' }, [t.timeMax, timeInput]),
  button(t.timeAll, () => (wiggle.resetTime(), syncTimeInput()), 'secondary'),
  el('span', { className: 'spacer' }),
  button(t.autoPickShot, () => runAutoPick([currentShot()])),
  button(t.autoPickAll, () => runAutoPick(state.shots), 'secondary'),
  undoButton,
  button(t.clearPicks, clearPicks, 'secondary'),
]);

const numberInput = (step = 'any'): HTMLInputElement => el('input', { type: 'number', step, className: 'short' });
const field = (label: string, input: HTMLElement): HTMLLabelElement => el('label', { className: 'field' }, [label, input]);

const sourceInput = numberInput();
const firstInput = numberInput();
const spacingInput = numberInput();
const geometryWarning = el('p', { className: 'warning', textContent: t.geometryMissing });
const topographyInput = el('textarea', { rows: 4, spellcheck: false });
const topographyCount = el('span', { className: 'muted' });
topographyInput.oninput = () => {
  state.topography = topographyInput.value;
  updateTopographyCount();
  markStale();
};
function updateTopographyCount(): void {
  topographyCount.textContent = state.topography.trim() ? t.topographyCount(parseTopography(state.topography).length) : '';
}
const geometryPanel = el('details', { className: 'panel' }, [
  el('summary', { textContent: t.geometryHeading }),
  geometryWarning,
  el('div', { className: 'row' }, [
    field(t.sourceX, sourceInput),
    field(t.firstReceiverX, firstInput),
    field(t.receiverSpacing, spacingInput),
    button(t.applyToShot, () => applyGeometry(false)),
    button(t.applyReceiversToAll, () => applyGeometry(true), 'secondary'),
  ]),
  el('h3', { textContent: t.topographyHeading }),
  el('p', { className: 'muted', textContent: t.topographyHint }),
  topographyInput,
  topographyCount,
]);

const pickPanel = el('section', { className: 'tab-panel pick-panel' }, [
  el('aside', {}, [
    el('h2', { textContent: t.shotsHeading }),
    shotList,
    button(t.openFiles, () => fileInput.click(), 'secondary wide'),
  ]),
  el('div', { className: 'work' }, [
    toolbar,
    geometryPanel,
    wiggleCanvas,
    el('p', { className: 'status' }, [pickReadout]),
    el('p', { className: 'muted', textContent: t.pickHelp }),
  ]),
]);

// Time-distance tab.
const curvesCanvas = el('canvas', { className: 'curves' });
const curvesReadout = el('span', { className: 'readout' });
const curves = new TimeDistancePlot(curvesCanvas, {
  hover: (text) => (curvesReadout.textContent = text),
  select: (shot) => selectShot(shot),
});
const legendItem = (className: string, label: string): HTMLSpanElement =>
  el('span', { className: 'legend-item' }, [el('span', { className: `swatch ${className}` }), label]);
const calculatedLegend = legendItem('calculated', t.legendCalculated);
const curvesPanel = el('section', { className: 'tab-panel' }, [
  el('div', { className: 'toolbar' }, [
    el('div', { className: 'legend' }, [
      legendItem('current', t.legendCurrent),
      legendItem('others', t.legendOthers),
      calculatedLegend,
      legendItem('source', t.legendSource),
    ]),
    el('span', { className: 'spacer' }),
    button(t.exportPicks, () => download('picks.csv', picksToCsv(state.shots), 'text/csv')),
  ]),
  curvesCanvas,
  el('p', { className: 'status' }, [curvesReadout]),
  el('p', { className: 'muted', textContent: t.curvesHelp }),
]);

// Inversion tab.
const paramInputs = {
  cellSize: numberInput(),
  depth: numberInput(),
  vTop: numberInput('10'),
  vBottom: numberInput('10'),
  iterations: numberInput('1'),
  smoothing: numberInput(),
};
for (const input of Object.values(paramInputs)) input.oninput = () => (state.paramsEdited = true);
const runButton = button(t.runInversion, runInversion);
const cancelButton = button(t.cancel, cancelInversion, 'secondary');
cancelButton.hidden = true;
const progressBar = el('progress', { max: 1, value: 0, hidden: true });
const inversionStatus = el('p', { className: 'status' });
inversionStatus.setAttribute('role', 'status');
const picksSummary = el('p', { className: 'muted' });
const staleNote = el('p', { className: 'warning', textContent: t.staleResult, hidden: true });
const resultSummary = el('p', { className: 'result-summary' });
const outlierNote = el('p', { className: 'warning', textContent: t.outlierHint, hidden: true });
const rmsList = el('p', { className: 'muted' });
const modelCanvas = el('canvas', { className: 'model' });
const modelReadout = el('span', { className: 'readout' });
const modelView = new ModelView(modelCanvas, { hover: (text) => (modelReadout.textContent = text) });
const exportModelButton = button(t.exportModel, () => state.result && download('modelo_vp.csv', modelToCsv(state.result), 'text/csv'), 'secondary');
const exportImageButton = button(
  t.exportImage,
  () => modelCanvas.toBlob((blob) => blob && download('modelo_vp.png', blob)),
  'secondary',
);
const resultTools = el('div', { className: 'toolbar' }, [
  checkbox(t.showRays, modelView.showRays, (v) => ((modelView.showRays = v), modelView.draw())),
  checkbox(t.maskUncovered, modelView.maskUncovered, (v) => ((modelView.maskUncovered = v), modelView.update())),
  el('span', { className: 'spacer' }),
  exportModelButton,
  exportImageButton,
]);
const coverageNote = el('p', { className: 'muted', textContent: t.coverageNote });
const inversionPanel = el('section', { className: 'tab-panel' }, [
  picksSummary,
  el('div', { className: 'row' }, [
    field(t.cellSize, paramInputs.cellSize),
    field(t.depth, paramInputs.depth),
    field(t.vTop, paramInputs.vTop),
    field(t.vBottom, paramInputs.vBottom),
    field(t.iterations, paramInputs.iterations),
    field(t.smoothing, paramInputs.smoothing),
  ]),
  el('div', { className: 'row' }, [
    runButton,
    cancelButton,
    button(t.estimateParams, () => fillParams(true), 'secondary'),
    progressBar,
  ]),
  inversionStatus,
  staleNote,
  resultSummary,
  outlierNote,
  resultTools,
  el('div', { className: 'model-wrap' }, [modelCanvas]),
  el('p', { className: 'status' }, [modelReadout]),
  rmsList,
  coverageNote,
]);

const panels: Record<Tab, HTMLElement> = { pick: pickPanel, curves: curvesPanel, inversion: inversionPanel };
const workspace = el('div', { className: 'workspace' }, [tabBar, pickPanel, curvesPanel, inversionPanel]);

document.querySelector<HTMLDivElement>('#app')!.append(
  el('header', { className: 'app-header' }, [
    el('div', {}, [
      el('h1', {}, [el('button', { type: 'button', className: 'home-link', textContent: t.appTitle, title: t.goHome, onclick: goHome })]),
      el('p', { className: 'muted', textContent: t.appSubtitle }),
    ]),
    el('div', { className: 'row' }, [button(t.openFiles, () => fileInput.click()), openProjectButton, saveProjectButton, themeButton]),
  ]),
  message,
  emptyState,
  workspace,
  fileInput,
  projectInput,
);

// ------------------------------------------------------------------ actions

function goHome(): void {
  state.home = true;
  showMessage([]);
  refresh();
}

function confirmReset(): void {
  if (!window.confirm(t.resetConfirm)) return;
  resetSession();
  showMessage([]);
  refresh();
}

/** Drops every shot, pick and result. */
function resetSession(): void {
  cancelInversion(true);
  state.shots = [];
  state.current = 0;
  state.result = null;
  state.calculated = null;
  state.stale = false;
  state.undo = [];
  state.exampleLoaded = false;
  state.topography = '';
  state.params = null;
  state.paramsEdited = false;
  topographyInput.value = '';
  updateTopographyCount();
  for (const input of Object.values(paramInputs)) input.value = '';
  resultSummary.textContent = '';
  rmsList.textContent = '';
  outlierNote.hidden = true;
  modelView.result = null;
  modelView.update();
}

function currentShot(): ShotState {
  return state.shots[state.current]!;
}

function setTab(tab: Tab): void {
  state.tab = tab;
  for (const key of Object.keys(panels) as Tab[]) {
    panels[key].hidden = key !== tab;
    tabButtons[key].classList.toggle('active', key === tab);
    tabButtons[key].setAttribute('aria-pressed', String(key === tab));
  }
  if (tab === 'inversion') fillParams(false);
  refresh();
}

/** Redraws everything that depends on the shots, picks or result. */
function refresh(): void {
  const hasShots = state.shots.length > 0;
  const showHome = state.home || !hasShots;
  emptyState.hidden = !showHome;
  workspace.hidden = showHome;
  saveProjectButton.disabled = !hasShots;
  openProjectButton.disabled = !hasShots;
  sessionRow.hidden = !hasShots;
  resumeButton.textContent = t.resumeSession(state.shots.length);
  if (showHome) return;
  state.current = Math.min(state.current, state.shots.length - 1);

  renderShotList();
  undoButton.disabled = state.undo.length === 0;

  const hasResult = state.result !== null;
  wiggle.shot = currentShot();
  wiggle.calculated = state.calculated?.[state.current] ?? null;
  curves.shots = state.shots;
  curves.current = state.current;
  curves.calculated = state.calculated;
  calculatedLegend.hidden = !hasResult;

  if (state.tab === 'pick') wiggle.requestDraw();
  if (state.tab === 'curves') curves.draw();
  if (state.tab === 'inversion') {
    const picked = state.shots.filter((s) => s.picks.some((p) => p !== null));
    picksSummary.textContent = t.picksSummary(
      picked.reduce((n, s) => n + s.picks.filter((p) => p !== null).length, 0),
      picked.length,
    );
    staleNote.hidden = !(hasResult && state.stale);
    resultTools.hidden = !hasResult;
    coverageNote.hidden = !hasResult;
    modelView.draw();
  }
}

function renderShotList(): void {
  shotList.replaceChildren(
    ...state.shots.map((shot, index) => {
      const picked = shot.picks.filter((p) => p !== null).length;
      const select = el('button', { type: 'button', className: 'shot', onclick: () => selectShot(index) }, [
        el('span', { className: 'shot-name', textContent: shot.name }),
        el('span', { className: 'shot-info' }, [
          t.pickCount(picked, shot.traces.length),
          ...(shot.hasFileGeometry ? [] : [el('span', { className: 'badge', textContent: t.geometryMissingBadge })]),
        ]),
      ]);
      if (index === state.current) select.setAttribute('aria-current', 'true');
      const remove = el('button', { type: 'button', className: 'remove', textContent: '×', title: t.removeShot, onclick: () => removeShot(index) });
      remove.setAttribute('aria-label', `${t.removeShot}: ${shot.name}`);
      return el('li', {}, [select, remove]);
    }),
  );
}

function renderGeometry(): void {
  const shot = currentShot();
  geometryWarning.hidden = shot.hasFileGeometry;
  if (!shot.hasFileGeometry) geometryPanel.open = true;
  const xs = shot.receiverX;
  sourceInput.value = String(shot.sourceX);
  firstInput.value = String(xs[0] ?? 0);
  spacingInput.value = String(xs.length > 1 ? Number(((xs[xs.length - 1]! - xs[0]!) / (xs.length - 1)).toFixed(6)) : 1);
}

function selectShot(index: number): void {
  state.current = Math.max(0, Math.min(state.shots.length - 1, index));
  renderGeometry();
  // Keep the time window while it fits the new record.
  wiggle.shot = currentShot();
  const [start, end] = wiggle.fullRange();
  if (wiggle.tMax > end || wiggle.tMin < start) wiggle.resetTime();
  syncTimeInput();
  refresh();
}

function removeShot(index: number): void {
  const [removed] = state.shots.splice(index, 1);
  state.undo = state.undo.map((group) => group.filter((u) => u.shot !== removed)).filter((group) => group.length > 0);
  if (state.calculated) state.calculated.splice(index, 1);
  if (index < state.current) state.current--;
  markStale();
  if (state.shots.length > 0) selectShot(state.current);
  else refresh();
}

function markStale(): void {
  if (state.result) state.stale = true;
  if (state.tab === 'inversion') staleNote.hidden = !(state.result && state.stale);
}

function picksChanged(): void {
  markStale();
  renderShotList();
  undoButton.disabled = state.undo.length === 0;
}

function pushUndo(shots: ShotState[]): void {
  state.undo.push(shots.map((shot) => ({ shot, picks: [...shot.picks] })));
  if (state.undo.length > 100) state.undo.shift();
}

function undo(): void {
  const group = state.undo.pop();
  if (!group) return;
  for (const entry of group) entry.shot.picks = entry.picks;
  markStale();
  // A single-shot action is shown where it happened.
  const index = group.length === 1 ? state.shots.indexOf(group[0]!.shot) : -1;
  if (index >= 0 && index !== state.current) return selectShot(index);
  refresh();
}

function clearPicks(): void {
  const shot = currentShot();
  if (!shot.picks.some((p) => p !== null)) return;
  pushUndo([shot]);
  shot.picks = shot.picks.map(() => null);
  markStale();
  refresh();
}

function runAutoPick(shots: ShotState[]): void {
  let count = 0;
  pushUndo(shots);
  for (const shot of shots) {
    shot.picks = shot.traces.map((trace) => {
      const pick = autoPick(trace.samples, trace.sampleInterval, trace.delay);
      if (pick !== null) count++;
      return pick;
    });
  }
  markStale();
  showMessage(t.autoPickDone(count));
  refresh();
}

function applyGeometry(receiversToAll: boolean): void {
  const source = Number(sourceInput.value);
  const first = Number(firstInput.value);
  const spacing = Number(spacingInput.value);
  const valid = [source, first, spacing].every((v) => Number.isFinite(v)) && spacing !== 0 && sourceInput.value !== '';
  if (!valid) return showMessage(t.invalidGeometry, 'error');
  const shot = currentShot();
  shot.sourceX = source;
  for (const target of receiversToAll ? state.shots : [shot]) {
    target.receiverX = target.traces.map((_, i) => Number((first + i * spacing).toFixed(6)));
  }
  // Other shots keep their warning: their source position was not confirmed.
  shot.hasFileGeometry = true;
  showMessage([]);
  markStale();
  renderGeometry();
  refresh();
}

function addShots(shots: Shot[], notes: string[]): number {
  let added = 0;
  for (const shot of shots) {
    if (state.shots.some((s) => s.name === shot.name)) {
      notes.push(t.duplicateShot(shot.name));
      continue;
    }
    state.shots.push(createShotState(shot));
    added++;
  }
  return added;
}

function afterLoad(added: number, notes: string[], failed: boolean): void {
  if (added > 0) {
    notes.unshift(t.loadedShots(added));
    state.home = false;
    markStale();
    const first = state.shots.length - added;
    if (state.shots.length === added) setTab('pick');
    selectShot(first);
  }
  showMessage(notes, failed ? 'error' : 'info');
  refresh();
}

async function loadFiles(files: Iterable<File> | null | undefined): Promise<void> {
  const sorted = Array.from(files ?? []).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (sorted.length === 0) return;
  const notes: string[] = [];
  const shots: Shot[] = [];
  let failed = false;
  for (const file of sorted) {
    try {
      shots.push(...readSeismicFile(await file.arrayBuffer(), file.name));
    } catch (error) {
      failed = true;
      notes.push(
        error instanceof UnknownFormatError
          ? t.unknownFormat(file.name)
          : t.readError(file.name, error instanceof Error ? error.message : String(error)),
      );
    }
  }
  // Real data replaces the built-in example instead of mixing with it.
  if (shots.length > 0 && state.exampleLoaded) {
    resetSession();
    notes.push(t.exampleReplaced);
  }
  afterLoad(addShots(shots, notes), notes, failed);
}

function loadExample(): void {
  const notes: string[] = [];
  const empty = state.shots.length === 0;
  const added = addShots(createSyntheticSurvey().shots, notes);
  if (empty && added > 0) state.exampleLoaded = true;
  afterLoad(added, notes, false);
}

function saveProject(): void {
  download('projeto.seismic-navigator.json', projectToJson(state.shots, state.topography, readParams()), 'application/json');
}

async function openProject(file: File | undefined): Promise<void> {
  if (!file) return;
  // A data file picked here by mistake is simply loaded as data.
  if (detectFormat(await file.slice(0, 3600).arrayBuffer())) return loadFiles([file]);
  try {
    const { matched, project } = applyProject(await file.text(), state.shots);
    state.topography = typeof project.topography === 'string' ? project.topography : '';
    topographyInput.value = state.topography;
    updateTopographyCount();
    if (project.params) {
      state.params = project.params;
      state.paramsEdited = true;
      writeParams(project.params);
    }
    state.undo = [];
    markStale();
    showMessage(t.projectApplied(matched, project.shots.length));
    selectShot(state.current);
  } catch {
    showMessage(t.projectInvalid, 'error');
  }
}

// ---------------------------------------------------------------- inversion

interface PreparedInversion {
  input: InversionInput;
  /** For each inversion shot: its index in `state.shots` and the picked traces. */
  map: { shot: number; traces: number[] }[];
}

function stationElevation(topography: Topography, x: number, fallback: number): number {
  return topography.length > 0 ? elevationAt(topography, x) : fallback;
}

function prepareInversion(params: InversionParams): PreparedInversion {
  const userTopography = parseTopography(state.topography);
  const shots: InversionShot[] = [];
  const map: PreparedInversion['map'] = [];
  const stations: Topography = [];
  state.shots.forEach((shot, index) => {
    const traces: number[] = [];
    const receivers: InversionShot['receivers'] = [];
    shot.picks.forEach((pick, k) => {
      if (pick === null || !(pick > 0)) return;
      const x = shot.receiverX[k]!;
      const z = stationElevation(userTopography, x, shot.receiverZ[k]!);
      traces.push(k);
      receivers.push({ x, z, time: pick });
      stations.push({ x, z });
    });
    if (receivers.length === 0) return;
    const sourceZ = stationElevation(userTopography, shot.sourceX, shot.sourceZ);
    stations.push({ x: shot.sourceX, z: sourceZ });
    shots.push({ sourceX: shot.sourceX, sourceZ, receivers });
    map.push({ shot: index, traces });
  });
  return {
    input: { shots, topography: userTopography.length > 0 ? userTopography : normalizeTopography(stations), params },
    map,
  };
}

function readParams(): InversionParams | null {
  const values = Object.fromEntries(Object.entries(paramInputs).map(([key, input]) => [key, Number(input.value)])) as unknown as InversionParams;
  const valid =
    Object.values(paramInputs).every((input) => input.value !== '') &&
    Object.values(values).every((v) => Number.isFinite(v) && v > 0) &&
    values.depth > 2 * values.cellSize;
  if (!valid) return null;
  values.iterations = Math.max(1, Math.min(50, Math.round(values.iterations)));
  return values;
}

function writeParams(params: InversionParams): void {
  for (const key of Object.keys(paramInputs) as (keyof InversionParams)[]) paramInputs[key].value = String(params[key]);
}

/** Fills the form from the picks, unless the user already edited it. */
function fillParams(force: boolean): void {
  if (!force && (state.paramsEdited || paramInputs.cellSize.value !== '')) return;
  const { input } = prepareInversion({ cellSize: 1, depth: 10, vTop: 500, vBottom: 2000, iterations: 10, smoothing: 1 });
  if (input.shots.length === 0) {
    if (force) showMessage(t.needPicks, 'error');
    return;
  }
  state.params = suggestParams(input.shots);
  state.paramsEdited = false;
  writeParams(state.params);
}

function setRunning(running: boolean): void {
  runButton.disabled = running;
  cancelButton.hidden = !running;
  progressBar.hidden = !running;
}

function runInversion(): void {
  if (paramInputs.cellSize.value === '') fillParams(true);
  const params = readParams();
  if (!params) return showMessage(t.invalidParams, 'error');
  const prepared = prepareInversion(params);
  if (prepared.input.shots.length === 0) return showMessage(t.needPicks, 'error');

  let xMin = Infinity;
  let xMax = -Infinity;
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const p of prepared.input.topography) {
    zMin = Math.min(zMin, p.z);
    zMax = Math.max(zMax, p.z);
  }
  for (const shot of prepared.input.shots) {
    for (const x of [shot.sourceX, ...shot.receivers.map((r) => r.x)]) {
      xMin = Math.min(xMin, x);
      xMax = Math.max(xMax, x);
    }
  }
  const nodes = Math.round(((xMax - xMin) / params.cellSize + 5) * ((zMax - zMin + params.depth) / params.cellSize + 2));
  if (nodes > MAX_NODES) return showMessage(t.gridTooLarge(nodes), 'error');

  showMessage([]);
  state.params = params;
  cancelInversion(true);
  setRunning(true);
  progressBar.value = 0;
  inversionStatus.textContent = t.running;

  const worker = new Worker(new URL('./workers/inversion.worker.ts', import.meta.url), { type: 'module' });
  state.worker = worker;
  worker.onmessage = (event: MessageEvent<InversionMessage>) => {
    const data = event.data;
    if (data.type === 'progress') {
      progressBar.value = data.iteration / Math.max(1, data.iterations);
      inversionStatus.textContent = t.progress(data.iteration, data.iterations, data.rms * 1000);
      return;
    }
    worker.terminate();
    state.worker = null;
    setRunning(false);
    if (data.type === 'error') {
      inversionStatus.textContent = '';
      return showMessage(`${t.inversionFailed} ${data.message}`, 'error');
    }
    showResult(data.result, prepared);
  };
  worker.onerror = (event) => {
    worker.terminate();
    state.worker = null;
    setRunning(false);
    inversionStatus.textContent = '';
    showMessage(`${t.inversionFailed} ${event.message}`, 'error');
  };
  worker.postMessage(prepared.input);
}

function cancelInversion(silent = false): void {
  if (!state.worker) return;
  state.worker.terminate();
  state.worker = null;
  setRunning(false);
  inversionStatus.textContent = silent === true ? '' : t.cancelled;
}

function showResult(result: InversionResult, prepared: PreparedInversion): void {
  state.result = result;
  state.stale = false;
  state.calculated = state.shots.map(() => null);
  prepared.map.forEach((entry, s) => {
    const shot = state.shots[entry.shot];
    if (!shot) return;
    const values = shot.picks.map(() => null as number | null);
    entry.traces.forEach((k, r) => (values[k] = result.calculated[s]![r]!));
    state.calculated![entry.shot] = values;
  });

  inversionStatus.textContent = '';
  resultSummary.textContent = t.resultSummary(
    result.rms * 1000,
    result.medianResidual * 1000,
    result.rmsHistory[0]! * 1000,
    result.grid.nx * result.grid.nz,
  );
  outlierNote.hidden = !(result.rms > 3 * result.medianResidual && result.rms > 0.001);
  rmsList.textContent = `${t.rmsHistory} ${result.rmsHistory.map((r) => (r * 1000).toFixed(2)).join(' → ')}`;
  modelView.result = result;
  modelView.sources = prepared.input.shots.map((s) => ({ x: s.sourceX, z: s.sourceZ }));
  const seen = new Set<number>();
  modelView.receivers = prepared.input.shots
    .flatMap((s) => s.receivers)
    .filter((r) => !seen.has(r.x) && seen.add(r.x))
    .map((r) => ({ x: r.x, z: r.z }));
  modelView.update();
  refresh();
}

// ------------------------------------------------------------------- events

fileInput.addEventListener('change', () => {
  void loadFiles(fileInput.files ? Array.from(fileInput.files) : null).then(() => (fileInput.value = ''));
});
projectInput.addEventListener('change', () => {
  void openProject(projectInput.files?.[0]).then(() => (projectInput.value = ''));
});
window.addEventListener('dragover', (event) => {
  event.preventDefault();
  emptyState.classList.add('dragging');
});
window.addEventListener('dragleave', () => emptyState.classList.remove('dragging'));
window.addEventListener('drop', (event) => {
  event.preventDefault();
  emptyState.classList.remove('dragging');
  void loadFiles(event.dataTransfer?.files ? Array.from(event.dataTransfer.files) : null);
});
window.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || state.shots.length === 0 || state.home) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    undo();
  } else if (state.tab !== 'inversion' && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault();
    selectShot(state.current + (event.key === 'ArrowDown' ? 1 : -1));
  }
});

setTab('pick');
