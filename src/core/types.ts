/** Internal data model. All units are SI: metres, seconds, m/s. */

export interface Position {
  /** Distance along the profile (m). */
  x: number;
  /** Elevation (m). */
  z: number;
}

export interface Trace {
  samples: Float32Array;
  /** Sample interval (s). */
  sampleInterval: number;
  /** Time of the first sample relative to the shot instant (s). */
  delay: number;
  /** Receiver position; null when the file carries no usable geometry. */
  receiver: Position | null;
}

/** A shot as read from a file, before any editing by the user. */
export interface Shot {
  name: string;
  source: Position | null;
  traces: Trace[];
}

/** A shot in the working session: file data plus editable geometry and picks. */
export interface ShotState {
  name: string;
  traces: Trace[];
  sourceX: number;
  sourceZ: number;
  receiverX: number[];
  receiverZ: number[];
  /** First-arrival time (s) per trace; null where not picked. */
  picks: (number | null)[];
  /** False when the geometry had to be invented because the file had none. */
  hasFileGeometry: boolean;
}

export function createShotState(shot: Shot): ShotState {
  const n = shot.traces.length;
  const hasFileGeometry = shot.source !== null && shot.traces.every((t) => t.receiver !== null);
  return {
    name: shot.name,
    traces: shot.traces,
    sourceX: hasFileGeometry ? shot.source!.x : -1,
    sourceZ: hasFileGeometry ? shot.source!.z : 0,
    receiverX: shot.traces.map((t, i) => (hasFileGeometry ? t.receiver!.x : i)),
    receiverZ: shot.traces.map((t) => (hasFileGeometry ? t.receiver!.z : 0)),
    picks: new Array<number | null>(n).fill(null),
    hasFileGeometry,
  };
}
