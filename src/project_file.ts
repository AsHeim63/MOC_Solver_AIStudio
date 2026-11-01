// Q25: the project file — every user input in one JSON file ("Save project" / "Open project").
// Pure: build the file from the inputs, or parse + check a file and return the inputs or a refusal message.
// A file is taken whole or not at all (a message = refused, nothing changes).
import type { PipeSection, PumpParams } from './types';
import type { Operation, ValveSource, ValveType } from './scenario_control';
import { VALVE_TYPES } from './scenario_control';

export const PROJECT_VERSION = 1;

export interface ProjectInputs {
  operation: Operation;
  valveSource: ValveSource;
  pipes: PipeSection[];
  pump: PumpParams;
  sourceElevation: number;
  outletPressure: number;
  inletPressure: number;
  // Q36: type / a / b / rho optional — files saved before Q36 open with today's default valve.
  valve: { kv0: number; t0: number; tClose: number; exponent: number; checkValve: boolean;
           type?: ValveType; a?: number; b?: number; rho?: number };
  pumpCurve: { Q: string; H: string }[];
  suctionPressure: string;   // as typed (m), like the curve cells
  // Q45: qprv / sav optional — files saved before Q45 open with the QPRV/SAV ticks kept as before Open.
  preferences: { airValves: boolean; qprv?: boolean; sav?: boolean };
}

export const projectText = (p: ProjectInputs): string =>
  JSON.stringify({ app: 'HydroGuard project', version: PROJECT_VERSION, ...p }, null, 2);

const obj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const nums = (o: Record<string, unknown>, keys: readonly string[]) => keys.every(k => num(o[k]));
const pick = (o: object, keys: readonly string[]) =>
  Object.fromEntries(keys.map(k => [k, (o as Record<string, unknown>)[k]]));

const PIPE_NUMS = ['length', 'diameter', 'waveSpeed', 'frictionFactor', 'endElevation'] as const;
const PUMP_NUMS = ['initialHead', 'initialFlow', 'tripTime', 'haltTime', 'elevation'] as const;

const NOT_PROJECT = 'Not a project file — nothing changed';

/** The inputs in `text`, or the short refusal message if it is not a valid project file of this version.
 *  Values are checked with the positivity rules the gate/dispatch already apply (pipe length and diameter > 0
 *  (B8), Kv > 0 (B6)) plus friction factor >= 0 and unique non-empty pipe ids, so a refused value never opens. */
export function parseProject(text: string): ProjectInputs | string {
  let j: unknown;
  try { j = JSON.parse(text); } catch { return NOT_PROJECT; }
  if (!obj(j)) return NOT_PROJECT;
  if (num(j.version) && j.version !== PROJECT_VERSION)
    return `Project file version ${j.version} not supported — nothing changed`;
  if (j.version !== PROJECT_VERSION) return NOT_PROJECT;
  const { pipes, pump, valve, pumpCurve, preferences } = j;
  const ok =
    (j.operation === 'pump-operation' || j.operation === 'valve-operation') &&
    (j.valveSource === 'pump' || j.valveSource === 'reservoir') &&
    Array.isArray(pipes) && pipes.length > 0 &&
    pipes.every(p => obj(p) && typeof p.id === 'string' && p.id.trim() !== '' &&
                     nums(p, PIPE_NUMS) &&
                     (p.length as number) > 0 && (p.diameter as number) > 0 && (p.frictionFactor as number) >= 0) &&
    new Set(pipes.map(p => (p as { id: string }).id)).size === pipes.length &&
    obj(pump) && nums(pump, PUMP_NUMS) &&
    nums(j, ['sourceElevation', 'outletPressure', 'inletPressure']) &&
    obj(valve) && nums(valve, ['kv0', 't0', 'tClose', 'exponent']) && (valve.kv0 as number) > 0 &&
    typeof valve.checkValve === 'boolean' &&
    (valve.type === undefined || VALVE_TYPES.some(([k]) => k === valve.type)) &&
    ['a', 'b', 'rho'].every(k => valve[k] === undefined || num(valve[k])) &&
    Array.isArray(pumpCurve) && pumpCurve.every(r => obj(r) && typeof r.Q === 'string' && typeof r.H === 'string') &&
    typeof j.suctionPressure === 'string' &&
    obj(preferences) && typeof preferences.airValves === 'boolean' &&
    ['qprv', 'sav'].every(k => preferences[k] === undefined || typeof preferences[k] === 'boolean');
  if (!ok) return NOT_PROJECT;
  const p = j as unknown as ProjectInputs;
  // Rebuilt from the known fields only: no extra keys from the file reach the app state.
  return {
    operation: p.operation, valveSource: p.valveSource,
    pipes: p.pipes.map(q => pick(q, ['id', ...PIPE_NUMS]) as unknown as PipeSection),
    pump: pick(p.pump, PUMP_NUMS) as unknown as PumpParams,
    sourceElevation: p.sourceElevation, outletPressure: p.outletPressure, inletPressure: p.inletPressure,
    valve: p.valve, pumpCurve: p.pumpCurve, suctionPressure: p.suctionPressure,
    preferences: pick(p.preferences, ['airValves', 'qprv', 'sav'].filter(k => k in p.preferences)) as ProjectInputs['preferences'],
  };
}
