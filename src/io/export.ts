import type { InversionParams, InversionResult } from '../core/tomo/invert';
import type { ShotState } from '../core/types';

function fmt(value: number, digits: number): string {
  return Number(value.toFixed(digits)).toString();
}

/** Picks of every shot as CSV; times in milliseconds. */
export function picksToCsv(shots: ShotState[]): string {
  const lines = ['shot,source_x_m,source_z_m,channel,receiver_x_m,receiver_z_m,time_ms'];
  for (const shot of shots) {
    shot.picks.forEach((pick, k) => {
      if (pick === null) return;
      lines.push(
        [
          `"${shot.name.replace(/"/g, '""')}"`,
          fmt(shot.sourceX, 3),
          fmt(shot.sourceZ, 3),
          k + 1,
          fmt(shot.receiverX[k]!, 3),
          fmt(shot.receiverZ[k]!, 3),
          fmt(pick * 1000, 4),
        ].join(','),
      );
    });
  }
  return lines.join('\n') + '\n';
}

/** Velocity model as CSV, one line per node below the surface. */
export function modelToCsv(result: InversionResult): string {
  const { grid, active, velocity, coverage } = result;
  const lines = ['x_m,z_m,velocity_m_s,ray_coverage_m'];
  for (let j = 0; j < grid.nz; j++) {
    for (let i = 0; i < grid.nx; i++) {
      const k = j * grid.nx + i;
      if (!active[k]) continue;
      lines.push(
        [fmt(grid.x0 + i * grid.h, 3), fmt(grid.zTop - j * grid.h, 3), fmt(velocity[k]!, 1), fmt(coverage[k]!, 3)].join(','),
      );
    }
  }
  return lines.join('\n') + '\n';
}

export interface ProjectFile {
  app: 'seismic-navigator';
  version: 1;
  topography: string;
  params: InversionParams | null;
  shots: {
    name: string;
    sourceX: number;
    sourceZ: number;
    receiverX: number[];
    receiverZ: number[];
    picks: (number | null)[];
  }[];
}

/** Session state without the traces: geometry, picks and inversion settings. */
export function projectToJson(shots: ShotState[], topography: string, params: InversionParams | null): string {
  const project: ProjectFile = {
    app: 'seismic-navigator',
    version: 1,
    topography,
    params,
    shots: shots.map((s) => ({
      name: s.name,
      sourceX: s.sourceX,
      sourceZ: s.sourceZ,
      receiverX: s.receiverX,
      receiverZ: s.receiverZ,
      picks: s.picks,
    })),
  };
  return JSON.stringify(project, null, 1);
}

/**
 * Applies a saved project to the loaded shots, matching by name and trace
 * count. Returns how many shots were matched.
 */
export function applyProject(text: string, shots: ShotState[]): { matched: number; project: ProjectFile } {
  const project = JSON.parse(text) as ProjectFile;
  if (project?.app !== 'seismic-navigator' || !Array.isArray(project.shots)) {
    throw new Error('not a Seismic Navigator project');
  }
  let matched = 0;
  for (const saved of project.shots) {
    const shot = shots.find((s) => s.name === saved.name && s.traces.length === saved.picks?.length);
    if (!shot) continue;
    const numbers = (values: unknown, fallback: number[]): number[] =>
      Array.isArray(values) && values.length === fallback.length && values.every((v) => typeof v === 'number')
        ? (values as number[])
        : fallback;
    shot.sourceX = typeof saved.sourceX === 'number' ? saved.sourceX : shot.sourceX;
    shot.sourceZ = typeof saved.sourceZ === 'number' ? saved.sourceZ : shot.sourceZ;
    shot.receiverX = numbers(saved.receiverX, shot.receiverX);
    shot.receiverZ = numbers(saved.receiverZ, shot.receiverZ);
    shot.picks = saved.picks.map((p) => (typeof p === 'number' && Number.isFinite(p) ? p : null));
    shot.hasFileGeometry = true;
    matched++;
  }
  return { matched, project };
}
