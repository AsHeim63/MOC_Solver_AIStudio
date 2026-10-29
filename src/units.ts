// ── units.ts — user-chosen units (Metric / US), Q26 (plan findings/q8/PLAN_Q8.md) ───────────────────────
// Pure, no React. Input/display layer only: app state, storage, gate and solver stay in calc units
// (m, m³/s, m/s, m of water gauge, m³, Kv). Exact definitions: NIST SP 811 (2008) App. B.
// Pressure <-> head uses the solver's G (ANSWERS 2026-10-14 Q8 (2): G = 9.81 everywhere, psi included).
import { G } from './solver';

export const RHO_WATER = 1000;   // kg/m³ — the only rho in the program
const FT = 0.3048, IN = 0.0254, GAL = 3.785411784e-3;
export const PSI_PA = 6894.757293168;   // 1 lbf/in² [Pa]
/** Cv per Kv: Cv (gpm at 1 psi) = CV_PER_KV x Kv (m³/h at 1 bar). Pure unit ratio, no g. */
export const CV_PER_KV = (1 / 3600 / (GAL / 60)) / Math.sqrt(1e5 / PSI_PA);

export type Qty = 'pressure' | 'flow' | 'length' | 'diameter' | 'velocity' | 'volume' | 'valve';
export type UnitSystem = 'metric' | 'us';

/** Factor: 1 unit = k calc units. Valve Cv is handled by CV_PER_KV directly (exact division). */
const K: Record<Qty, Record<string, number>> = {
  pressure: { m: 1, barg: 1e5 / (RHO_WATER * G), kPag: 1e3 / (RHO_WATER * G), psig: PSI_PA / (RHO_WATER * G), ft: FT },
  flow: { 'm³/h': 1 / 3600, 'm³/s': 1, 'L/s': 1e-3, gpm: GAL / 60, 'ft³/s': FT ** 3 },
  length: { m: 1, ft: FT },
  diameter: { mm: 1e-3, in: IN },
  velocity: { 'm/s': 1, 'ft/s': FT },
  volume: { L: 1e-3, gal: GAL },
  valve: { Kv: 1 },
};

const factor = (qty: Qty, unit: string): number => {
  const k = K[qty]?.[unit];
  if (k === undefined) throw new Error(`unknown unit "${unit}" for ${qty}`);
  return k;
};

/** Typed value in `unit` -> calc unit. */
export function toCalc(qty: Qty, unit: string, v: number): number {
  if (qty === 'valve' && unit === 'Cv') return v / CV_PER_KV;
  return v * factor(qty, unit);
}

/** Calc unit -> value shown in `unit`. */
export function fromCalc(qty: Qty, unit: string, v: number): number {
  if (qty === 'valve' && unit === 'Cv') return v * CV_PER_KV;
  return v / factor(qty, unit);
}

/** Pressure and flow choices per system (default first); plan §2, D1. */
export const CHOICES: Record<UnitSystem, { pressure: string[]; flow: string[] }> = {
  metric: { pressure: ['m', 'barg', 'kPag'], flow: ['m³/h', 'm³/s', 'L/s'] },
  us: { pressure: ['psig', 'ft'], flow: ['gpm', 'ft³/s'] },
};

export interface UnitChoice { system: UnitSystem; pressure: string; flow: string }
export const DEFAULT_UNITS: UnitChoice = { system: 'metric', pressure: 'm', flow: 'm³/h' };

/** A stored choice if it is a valid one, else the default. */
export function validChoice(c: unknown): UnitChoice {
  const o = c as UnitChoice;
  if (o && (o.system === 'metric' || o.system === 'us') &&
      CHOICES[o.system].pressure.includes(o.pressure) && CHOICES[o.system].flow.includes(o.flow)) {
    return { system: o.system, pressure: o.pressure, flow: o.flow };
  }
  return DEFAULT_UNITS;
}

/** The unit of each quantity under a choice (the rest follow the system, plan §2). */
export function unitsOf(c: UnitChoice): Record<Qty, string> {
  const us = c.system === 'us';
  return {
    pressure: c.pressure, flow: c.flow, length: us ? 'ft' : 'm', diameter: us ? 'in' : 'mm',
    velocity: us ? 'ft/s' : 'm/s', volume: us ? 'gal' : 'L', valve: us ? 'Cv' : 'Kv',
  };
}

/** A pressure unit that is a height of water column (m, ft). */
export const isHeadUnit = (u: string): boolean => u === 'm' || u === 'ft';

/** Q27: decimals a result is shown with, per unit (any unit not listed: 2). */
const DEC: Record<string, number> = {
  'm³/h': 1, 'm³/s': 4, 'L/s': 1, gpm: 1, 'ft³/s': 3, barg: 3, kPag: 1, mm: 0, in: 2, 'm/s': 3, 'ft/s': 3, Kv: 1, Cv: 1,
};

/** Q27: a calc-unit (SI) result as shown in `unit`: fixed decimals (per unit unless given), no "-0". */
export function fmt(qty: Qty, unit: string, v: number, dec = DEC[unit] ?? 2): string {
  const s = fromCalc(qty, unit, v).toFixed(dec);
  return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s;
}

/** Q27: the unit a valve coefficient is defined in (Kv: m³/h at 1 bar; Cv: gpm at 1 psi). */
export const valveBasis = (unit: string): string => (unit === 'Cv' ? `${CHOICES.us.flow[0]} at 1 psi` : CHOICES.metric.flow[0]);

/** Q27: a chart axis in the shown unit. */
export interface Axis { domain: [number, number]; ticks: number[]; tick: (v: number) => string }

/** Q27: [lo, hi] (shown unit) widened to the smallest 1/2/5 x 10^k step that needs at most `maxN` intervals. */
export function niceAxis(lo: number, hi: number, maxN = 8): Axis {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1; }
  if (!(hi > lo)) { const d = Math.abs(lo) / 10 || 1; lo -= d; hi += d; }
  for (let k = Math.floor(Math.log10((hi - lo) / maxN)); ; k++) {
    for (const m of [1, 2, 5]) {
      const step = m * 10 ** k, a = Math.floor(lo / step), b = Math.ceil(hi / step);
      if (b - a > maxN) continue;
      const dec = Math.max(0, -k);
      const tick = (v: number) => { const s = v.toFixed(dec); return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s; };
      const ticks = Array.from({ length: b - a + 1 }, (_, i) => Number(((a + i) * step).toFixed(dec)));
      return { domain: [ticks[0], ticks[ticks.length - 1]], ticks, tick };
    }
  }
}

/** Q27: a valve size given in mm, shown in the diameter unit. */
export const fmtMm = (unit: string, mm: number): string => fmt('diameter', unit, mm / 1000);

type ProfileNode = { x: number; elevation: number; maxHead: number; minHead: number; steadyHead: number };
/** Q27: result nodes with their distance, elevation and heads in the length unit `unit`. */
export const nodesInLength = <N extends ProfileNode>(nodes: N[], unit: string): N[] =>
  nodes.map(n => {
    const L = (v: number) => fromCalc('length', unit, v);
    return { ...n, x: L(n.x), elevation: L(n.elevation), maxHead: L(n.maxHead), minHead: L(n.minHead), steadyHead: L(n.steadyHead) };
  });

/** Display form: 6 significant digits, no trailing zeros. */
export const show6 = (v: number): string => (Number.isFinite(v) ? String(Number(v.toPrecision(6))) : String(v));
