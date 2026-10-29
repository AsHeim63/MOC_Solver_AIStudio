// Q25: the project file — every user input in one JSON file ("Save project" / "Open project").
// Pure: build the file from the inputs, or parse + check a file and return the inputs or null.
// A file is taken whole or not at all (null = refused, nothing changes).
import type { PipeSection, PumpParams } from './types';
import type { Operation, ValveSource } from './scenario_control';

export const PROJECT_VERSION = 1;

export interface ProjectInputs {
  operation: Operation;
  valveSource: ValveSource;
  pipes: PipeSection[];
  pump: PumpParams;
  sourceElevation: number;
  outletPressure: number;
  inletPressure: number;
  valve: { kv0: number; t0: number; tClose: number; exponent: number; checkValve: boolean };
  pumpCurve: { Q: string; H: string }[];
  suctionPressure: string;   // as typed (m), like the curve cells
  preferences: { airValves: boolean };
}

export const projectText = (p: ProjectInputs): string =>
  JSON.stringify({ app: 'HydroGuard project', version: PROJECT_VERSION, ...p }, null, 2);

const obj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const nums = (o: Record<string, unknown>, keys: string[]) => keys.every(k => num(o[k]));

/** The inputs in `text`, or null if it is not a valid project file of this version. */
export function parseProject(text: string): ProjectInputs | null {
  let j: unknown;
  try { j = JSON.parse(text); } catch { return null; }
  if (!obj(j) || j.version !== PROJECT_VERSION) return null;
  const { pipes, pump, valve, pumpCurve, preferences } = j;
  const ok =
    (j.operation === 'pump-operation' || j.operation === 'valve-operation') &&
    (j.valveSource === 'pump' || j.valveSource === 'reservoir') &&
    Array.isArray(pipes) && pipes.length > 0 &&
    pipes.every(p => obj(p) && typeof p.id === 'string' &&
                     nums(p, ['length', 'diameter', 'waveSpeed', 'frictionFactor', 'endElevation'])) &&
    obj(pump) && nums(pump, ['initialHead', 'initialFlow', 'tripTime', 'haltTime', 'elevation']) &&
    nums(j, ['sourceElevation', 'outletPressure', 'inletPressure']) &&
    obj(valve) && nums(valve, ['kv0', 't0', 'tClose', 'exponent']) && typeof valve.checkValve === 'boolean' &&
    Array.isArray(pumpCurve) && pumpCurve.every(r => obj(r) && typeof r.Q === 'string' && typeof r.H === 'string') &&
    typeof j.suctionPressure === 'string' &&
    obj(preferences) && typeof preferences.airValves === 'boolean';
  if (!ok) return null;
  const p = j as unknown as ProjectInputs;
  return {
    operation: p.operation, valveSource: p.valveSource, pipes: p.pipes, pump: p.pump,
    sourceElevation: p.sourceElevation, outletPressure: p.outletPressure, inletPressure: p.inletPressure,
    valve: p.valve, pumpCurve: p.pumpCurve, suctionPressure: p.suctionPressure, preferences: p.preferences,
  };
}
