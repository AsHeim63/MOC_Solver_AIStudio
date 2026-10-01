// ═══════════════════════════════════════════════════════════════════════════════
// test_sweep.ts — Phase 1.2 Parameterized Pump-Trip Sweep Harness
// ═══════════════════════════════════════════════════════════════════════════════
//
// Purpose
//   Runs the pump-trip edge-case matrix (knowledge/edge_case_test_matrix.md
//   §4.1–4.9) against the authoritative solver (patched_23.4.28_1/src/solver.ts,
//   mirrored at ./src/solver in the AI Studio sandbox).
//
//   Each case is fed through a two-gate feasibility pre-check (L021); feasible
//   cases run; per-case metrics emit to results.csv.
//
// Fixes baked in (from AUDIT PLAN 2026-05-13, ten findings)
//   F1   DEFAULT geometry uses matrix §4.1 (endElev=20, pump.elev=10, res.head=30).
//        NOT test_jumps.ts (endElev=10, res.head=10). Regression baseline is
//        steady H[0]=43.22 m; wrong geometry yields 23.22 m and silent failure.
//   F5   Feasibility = velocity gate (v₀ > V_PHYSICAL_LIMIT → skip) THEN
//        sub-vapor gate (any steady H_i < H_vap_i → skip). D_01 passes sub-vapor
//        but fails velocity (v₀=63.7 m/s) per L021.
//   F6   Null-guard all reads of fullHistory[t].flows and fullHistory[t].vapors;
//        both are optional in SimulationResults (types.ts).
//   F7   First-exceed scan gates on `t > tripTime`; without this, t=0 returns
//        trivially because H[0] at steady state always exceeds itself by zero
//        and the > test is unsafe across float comparison.
//   F8   CSV includes `dt` and `simDuration` columns (LEARNINGS.md line 93).
//   F9   Named constants at top of file (DOMAIN-CONSTRAINTS §11).
//   F10  Feasibility loop iterates i = 0..N inclusive (N = first-pipe segment
//        count = 20 for single-pipe topology); 21 nodes total.
//   F11  Per-case metrics from results.nodes[0] directly (maxHead, minHead,
//        steadyHead, maxVaporVolume); fullHistory scanned ONLY for t_peak,
//        t_firstExceed, dt, simDuration, NaN_count.
//   F16  Every PipeSection in the cases array includes `id: string` (required
//        per types.ts:2).
//
// Accepted coverage gaps (L020)
//   fullHistory[t].flows = Q_out only. Q_in is not emitted. The following
//   checks are therefore UNCHECKABLE in Phase 1.2 without a solver-output
//   extension and are documented gaps, not silent omissions:
//     - Q_in NaN/Inf
//     - Q_in[0] < 0 (check-valve sign violation, DOMAIN §6)
//     - Mass conservation |Q_in[i] − Q_out[i]| < ε at non-cavity nodes
//
// Velocity-gated skips (expected, not bugs)
//   V_PHYSICAL_LIMIT = 10 m/s eliminates three matrix cases at the velocity
//   gate before any solver call:
//     - D_01 (D=0.10, Q0=0.5):  v0 = 63.7 m/s   — clearly non-physical
//     - D_02 (D=0.25, Q0=0.5):  v0 = 10.19 m/s  — marginal; matrix predicted
//                                                 "strong cavitation expected"
//     - Q_04 (D=0.5, Q0=2.0):   v0 = 10.19 m/s  — marginal; matrix predicted
//                                                 "very strong cavitation"
//   D_02 and Q_04 are reachable at v0 just above 10 m/s. Decision: keep the
//   gate at 10 m/s (engineering limit per L021); document the lost coverage
//   here. If those regimes are needed, pair small-D with smaller Q₀, or pair
//   large-Q₀ with larger D, per matrix §4.2 "design constraint" note.
//
// Case count
//   Matrix §7 reports 41 total. Actual enumeration in §4.1–4.9 yields 40
//   unique IDs: DEFAULT + 6 L + 4 D + 4 a + 4 f + 4 Q + 4 T + 4 R + 4 E + 5 C.
//   The matrix's "41" appears to be a counting error (DEFAULT double-counted
//   across its placeholder rows). This harness delivers the 40 actual unique
//   IDs from the matrix. Flagged for matrix doc correction.
//
// ═══════════════════════════════════════════════════════════════════════════════

import { runWaterHammerSimulation } from './src/solver';
import * as fs from 'fs';
import type { PipeSection, PumpParams, ReservoirParams, SimulationResults } from './src/types';

// ─── F9: Named constants (DOMAIN-CONSTRAINTS §11) ──────────────────────────────
const G                      = 9.81;       // m/s²
const VAPOR_H_REL_MAG        = 9.8;        // |VAPOR_H_REL| → H_vap = Z − 9.8 (gauge)
const MAX_HEAD_LIMIT         = 1e6;        // m — hard-fail threshold (matrix §5.1)
const V_PHYSICAL_LIMIT       = 10;         // m/s — engineering velocity ceiling (L021)
const REG_HEAD_TOL           = 0.02;       // ±2% regression tolerance for heads/times
const REG_VGAS_TOL           = 0.10;       // ±10% regression tolerance for V_g (secondary)
const DEFAULT_STEADY_H0      = 43.22;      // m  (LEARNINGS.md verified reference)
const DEFAULT_PEAK_H0        = 205.9;      // m
const DEFAULT_T_PEAK         = 18.35;      // s
const DEFAULT_T_FIRST_EXCEED = 16.75;      // s
const DEFAULT_VGAS_MAX       = 1.1;        // m³ (secondary metric, ±10%)
const FIRST_PIPE_SEGMENTS    = 20;         // solver.ts:1087 — baseDt uses L/20/a; N=20 for first pipe

// ─── Case definition ───────────────────────────────────────────────────────────
interface CaseDef {
  id:        string;
  L:         number;   // m
  D:         number;   // m
  a:         number;   // m/s
  f:         number;
  Q0:        number;   // m³/s
  tripTime:  number;   // s
  haltTime:  number;   // s
  resHead:   number;   // m
  endElev:   number;   // m
  pumpElev:  number;   // m
}

// ─── 40 unique cases from matrix §4.1–4.9 ──────────────────────────────────────
const CASES: CaseDef[] = [
  // §4.1 OAT — Pipe length L (7 entries, includes DEFAULT)
  { id: 'L_01',    L:    10, D: 0.5, a:   10, f: 0.02,  Q0: 0.5,  tripTime: 2, haltTime: 5,    resHead: 30, endElev: 20, pumpElev: 10 },
  { id: 'L_02',    L:    50, D: 0.5, a:  200, f: 0.02,  Q0: 0.5,  tripTime: 2, haltTime: 5,    resHead: 30, endElev: 20, pumpElev: 10 },
  { id: 'L_03',    L:   100, D: 0.5, a: 1000, f: 0.02,  Q0: 0.5,  tripTime: 2, haltTime: 5,    resHead: 30, endElev: 20, pumpElev: 10 },
  { id: 'L_04',    L:   200, D: 0.5, a: 1000, f: 0.02,  Q0: 0.5,  tripTime: 2, haltTime: 5,    resHead: 30, endElev: 20, pumpElev: 10 },
  { id: 'DEFAULT', L:  1000, D: 0.5, a: 1000, f: 0.02,  Q0: 0.5,  tripTime: 2, haltTime: 5,    resHead: 30, endElev: 20, pumpElev: 10 },
  { id: 'L_05',    L:  5000, D: 0.5, a: 1000, f: 0.02,  Q0: 0.5,  tripTime: 2, haltTime: 5,    resHead: 30, endElev: 20, pumpElev: 10 },
  { id: 'L_06',    L: 10000, D: 0.5, a: 1000, f: 0.02,  Q0: 0.5,  tripTime: 2, haltTime: 5,    resHead: 30, endElev: 20, pumpElev: 10 },

  // §4.2 OAT — Diameter D (4 non-default)
  { id: 'D_01',    L: 1000, D: 0.10, a: 1000, f: 0.02,  Q0: 0.5,  tripTime: 2, haltTime: 5,    resHead: 30, endElev: 20, pumpElev: 10 },
  { id: 'D_02',    L: 1000, D: 0.25, a: 1000, f: 0.02,  Q0: 0.5,  tripTime: 2, haltTime: 5,    resHead: 30, endElev: 20, pumpElev: 10 },
  { id: 'D_03',    L: 1000, D: 1.00, a: 1000, f: 0.02,  Q0: 0.5,  tripTime: 2, haltTime: 5,    resHead: 30, endElev: 20, pumpElev: 10 },
  { id: 'D_04',    L: 1000, D: 1.50, a: 1000, f: 0.02,  Q0: 0.5,  tripTime: 2, haltTime: 5,    resHead: 30, endElev: 20, pumpElev: 10 },

  // §4.3 OAT — Wave speed a (4 non-default)
  { id: 'A_01',    L: 1000, D: 0.5, a:  200, f: 0.02,  Q0: 0.5,  tripTime: 2, haltTime: 5,    resHead: 30, endElev: 20, pumpElev: 10 },
  { id: 'A_02',    L: 1000, D: 0.5, a:  500, f: 0.02,  Q0: 0.5,  tripTime: 2, haltTime: 5,    resHead: 30, endElev: 20, pumpElev: 10 },
  { id: 'A_03',    L: 1000, D: 0.5, a: 1200, f: 0.02,  Q0: 0.5,  tripTime: 2, haltTime: 5,    resHead: 30, endElev: 20, pumpElev: 10 },
  { id: 'A_04',    L: 1000, D: 0.5, a: 1400, f: 0.02,  Q0: 0.5,  tripTime: 2, haltTime: 5,    resHead: 30, endElev: 20, pumpElev: 10 },

  // §4.4 OAT — Friction f (4 non-default)
  { id: 'F_01',    L: 1000, D: 0.5, a: 1000, f: 0.005, Q0: 0.5,  tripTime: 2, haltTime: 5,    resHead: 30, endElev: 20, pumpElev: 10 },
  { id: 'F_02',    L: 1000, D: 0.5, a: 1000, f: 0.01,  Q0: 0.5,  tripTime: 2, haltTime: 5,    resHead: 30, endElev: 20, pumpElev: 10 },
  { id: 'F_03',    L: 1000, D: 0.5, a: 1000, f: 0.035, Q0: 0.5,  tripTime: 2, haltTime: 5,    resHead: 30, endElev: 20, pumpElev: 10 },
  { id: 'F_04',    L: 1000, D: 0.5, a: 1000, f: 0.05,  Q0: 0.5,  tripTime: 2, haltTime: 5,    resHead: 30, endElev: 20, pumpElev: 10 },

  // §4.5 OAT — Initial flow Q₀ (4 non-default)
  { id: 'Q_01',    L: 1000, D: 0.5, a: 1000, f: 0.02,  Q0: 0.05, tripTime: 2, haltTime: 5,    resHead: 30, endElev: 20, pumpElev: 10 },
  { id: 'Q_02',    L: 1000, D: 0.5, a: 1000, f: 0.02,  Q0: 0.2,  tripTime: 2, haltTime: 5,    resHead: 30, endElev: 20, pumpElev: 10 },
  { id: 'Q_03',    L: 1000, D: 0.5, a: 1000, f: 0.02,  Q0: 1.0,  tripTime: 2, haltTime: 5,    resHead: 30, endElev: 20, pumpElev: 10 },
  { id: 'Q_04',    L: 1000, D: 0.5, a: 1000, f: 0.02,  Q0: 2.0,  tripTime: 2, haltTime: 5,    resHead: 30, endElev: 20, pumpElev: 10 },

  // §4.6 OAT — trip→halt duration (4 non-default)
  { id: 'T_01',    L: 1000, D: 0.5, a: 1000, f: 0.02,  Q0: 0.5,  tripTime: 2, haltTime: 2.1,  resHead: 30, endElev: 20, pumpElev: 10 },
  { id: 'T_02',    L: 1000, D: 0.5, a: 1000, f: 0.02,  Q0: 0.5,  tripTime: 2, haltTime: 3,    resHead: 30, endElev: 20, pumpElev: 10 },
  { id: 'T_03',    L: 1000, D: 0.5, a: 1000, f: 0.02,  Q0: 0.5,  tripTime: 2, haltTime: 12,   resHead: 30, endElev: 20, pumpElev: 10 },
  { id: 'T_04',    L: 1000, D: 0.5, a: 1000, f: 0.02,  Q0: 0.5,  tripTime: 2, haltTime: 32,   resHead: 30, endElev: 20, pumpElev: 10 },

  // §4.7 OAT — Reservoir head (4 non-default)
  { id: 'R_01',    L: 1000, D: 0.5, a: 1000, f: 0.02,  Q0: 0.5,  tripTime: 2, haltTime: 5,    resHead:   5, endElev: 20, pumpElev: 10 },
  { id: 'R_02',    L: 1000, D: 0.5, a: 1000, f: 0.02,  Q0: 0.5,  tripTime: 2, haltTime: 5,    resHead:  15, endElev: 20, pumpElev: 10 },
  { id: 'R_03',    L: 1000, D: 0.5, a: 1000, f: 0.02,  Q0: 0.5,  tripTime: 2, haltTime: 5,    resHead:  60, endElev: 20, pumpElev: 10 },
  { id: 'R_04',    L: 1000, D: 0.5, a: 1000, f: 0.02,  Q0: 0.5,  tripTime: 2, haltTime: 5,    resHead: 100, endElev: 20, pumpElev: 10 },

  // §4.8 OAT — End elevation (4 non-default)
  { id: 'E_01',    L: 1000, D: 0.5, a: 1000, f: 0.02,  Q0: 0.5,  tripTime: 2, haltTime: 5,    resHead: 30, endElev: -10, pumpElev: 10 },
  { id: 'E_02',    L: 1000, D: 0.5, a: 1000, f: 0.02,  Q0: 0.5,  tripTime: 2, haltTime: 5,    resHead: 30, endElev:   0, pumpElev: 10 },
  { id: 'E_03',    L: 1000, D: 0.5, a: 1000, f: 0.02,  Q0: 0.5,  tripTime: 2, haltTime: 5,    resHead: 30, endElev: 100, pumpElev: 10 },
  { id: 'E_04',    L: 1000, D: 0.5, a: 1000, f: 0.02,  Q0: 0.5,  tripTime: 2, haltTime: 5,    resHead: 30, endElev: 200, pumpElev: 10 },

  // §4.9 Combined-stress (5 cases)
  { id: 'C_01',    L:   100, D: 0.3, a: 1000, f: 0.02,  Q0: 0.3,  tripTime: 2, haltTime: 2.1,  resHead: 30, endElev:  50, pumpElev: 10 },
  { id: 'C_02',    L:  5000, D: 0.5, a: 1000, f: 0.005, Q0: 0.5,  tripTime: 2, haltTime: 32,   resHead: 30, endElev:  20, pumpElev: 10 },
  { id: 'C_03',    L:   500, D: 0.4, a:  800, f: 0.03,  Q0: 0.6,  tripTime: 2, haltTime: 4,    resHead: 80, endElev:  80, pumpElev: 10 },
  { id: 'C_04',    L:    10, D: 0.2, a:   10, f: 0.02,  Q0: 0.05, tripTime: 2, haltTime: 2.5,  resHead: 30, endElev:  12, pumpElev: 10 },
  { id: 'C_05',    L:  1000, D: 0.5, a: 1000, f: 0.05,  Q0: 1.5,  tripTime: 2, haltTime: 2.1,  resHead: 30, endElev:  20, pumpElev: 10 },
];

// ─── Result record ─────────────────────────────────────────────────────────────
interface CaseResult {
  case_id:        string;
  status:         'ok' | 'skip' | 'crash';
  steady_H0:      number | '';
  peak_H0:        number | '';
  t_peak:         number | '';
  t_firstExceed:  number | '';
  V_gas_max:      number | '';
  V_gas_max_global: number | '';
  V_gas_max_per_node: string;
  H_at_2L_a:      number | '';
  H_tail_mean:    number | '';
  H_tail_std:     number | '';
  NaN_count:      number | '';
  dt:             number | '';
  simDuration:    number | '';
  skip_reason:    string;
}

// ─── F5: Feasibility pre-check (two gates: velocity, then sub-vapor steady) ────
// F10: loop iterates i = 0..N inclusive (N+1 nodes); N=20 for single pipe.
function feasibility(c: CaseDef): { feasible: boolean; reason: string } {
  const A  = Math.PI * (c.D / 2.0) ** 2;
  const v0 = c.Q0 / A;

  // Gate 1: velocity ceiling (L021 — catches D_01 even when no node goes sub-vapor)
  if (v0 > V_PHYSICAL_LIMIT) {
    return { feasible: false, reason: `velocity_exceeds_${V_PHYSICAL_LIMIT}mps(v0=${v0.toFixed(2)})` };
  }

  // Gate 2: sub-vapor steady state at any of the N+1 nodes
  // Steady pumpHead = res.head + total friction loss (solver INIT_STEADY_STATE)
  const N        = FIRST_PIPE_SEGMENTS;
  const dx       = c.L / N;
  const dH_per_dx = (c.f * dx * v0 * v0) / (2.0 * G * c.D);
  const pumpHead = c.resHead + N * dH_per_dx;

  for (let i = 0; i <= N; i++) {        // F10: 0..N inclusive (21 nodes)
    const Z_i   = c.pumpElev + (c.endElev - c.pumpElev) * (i / N);
    const H_i   = pumpHead - i * dH_per_dx;
    const H_vap = Z_i - VAPOR_H_REL_MAG;
    if (H_i < H_vap) {
      return { feasible: false, reason: `subvapor_steady_at_node_${i}(H=${H_i.toFixed(2)},H_vap=${H_vap.toFixed(2)})` };
    }
  }

  return { feasible: true, reason: '' };
}

// ─── Run one case ──────────────────────────────────────────────────────────────
function runCase(c: CaseDef): CaseResult {
  const blank: CaseResult = {
    case_id: c.id, status: 'ok',
    steady_H0: '', peak_H0: '', t_peak: '', t_firstExceed: '',
    V_gas_max: '', V_gas_max_global: '', V_gas_max_per_node: '', H_at_2L_a: '', H_tail_mean: '', H_tail_std: '', NaN_count: '', dt: '', simDuration: '', skip_reason: '',
  };

  // F5 feasibility
  const feas = feasibility(c);
  if (!feas.feasible) {
    return { ...blank, status: 'skip', skip_reason: feas.reason };
  }

  // F16: PipeSection.id is required
  const pipes: PipeSection[] = [{
    id:             '1',
    length:         c.L,
    diameter:       c.D,
    waveSpeed:      c.a,
    frictionFactor: c.f,
    endElevation:   c.endElev,
  }];
  const pump: PumpParams = {
    initialHead: 100,         // UI-only, ignored by solver (LEARNINGS.md Phase 1.1)
    initialFlow: c.Q0,
    tripTime:    c.tripTime,
    haltTime:    c.haltTime,
    elevation:   c.pumpElev,
  };
  const reservoir: ReservoirParams = { head: c.resHead };

  let results: SimulationResults;
  try {
    results = runWaterHammerSimulation(pipes, pump, reservoir);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ...blank, status: 'crash', skip_reason: `solver_exception:${msg}` };
  }

  // F11: node-0 metrics direct from results.nodes[0]
  const n0         = results.nodes[0];
  const steady_H0  = n0.steadyHead;
  const peak_H0    = n0.maxHead;
  const V_gas_max  = n0.maxVaporVolume;

  // F11: fullHistory scanned ONLY for t_peak, t_firstExceed, dt, simDuration, NaN_count
  // F6: null-guard step.flows and step.vapors
  // F7: first-exceed gate on t > tripTime
  let t_peak:        number = NaN;
  let bestH0:        number = -Infinity;
  let t_firstExceed: number = NaN;
  let nanCount = 0;
  let V_gas_max_global = 0;
  const t_2L_a = (2 * c.L) / c.a;
  let H_at_2L_a_val = NaN;
  let H_at_2L_a_dist = Infinity;

  const history = results.fullHistory;
  const N_total = history.length > 0 ? history[0].heads.length : 0;
  const vGasPerNode: number[] = new Array(N_total).fill(0);
  for (let i = 0; i < history.length; i++) {
    const step = history[i];
    const H0   = step.heads[0];

    for (let n = 0; n < step.heads.length; n++) {
      const h = step.heads[n];
      if (!Number.isFinite(h) || Math.abs(h) > MAX_HEAD_LIMIT) nanCount++;
    }
    if (step.flows) {                                            // F6
      for (let n = 0; n < step.flows.length; n++) {
        if (!Number.isFinite(step.flows[n])) nanCount++;
      }
    }
    if (step.vapors) {                                           // F6
      for (let n = 0; n < step.vapors.length; n++) {
        const v = step.vapors[n];
        if (!Number.isFinite(v)) nanCount++;
        else {
          if (v > V_gas_max_global) V_gas_max_global = v;
          if (n < vGasPerNode.length && v > vGasPerNode[n]) vGasPerNode[n] = v;
        }
      }
    }
    
    if (Number.isFinite(H0)) {
      const distFromRefl = Math.abs(step.time - t_2L_a);
      if (distFromRefl < H_at_2L_a_dist) {
        H_at_2L_a_dist = distFromRefl;
        H_at_2L_a_val = H0;
      }
    }

    if (Number.isFinite(H0) && H0 > bestH0) {
      bestH0 = H0;
      t_peak = step.time;
    }
    if (!Number.isFinite(t_firstExceed) && step.time > c.tripTime && H0 > steady_H0) {   // F7
      t_firstExceed = step.time;
    }
  }

  const dt          = c.L / FIRST_PIPE_SEGMENTS / c.a;            // solver.ts:1087
  const simDuration = history.length > 0 ? history[history.length - 1].time : 0;

  const tailStartTime = 0.9 * simDuration;
  const tailH0: number[] = [];
  for (let i = 0; i < history.length; i++) {
    if (history[i].time >= tailStartTime) {
      const h = history[i].heads[0];
      if (Number.isFinite(h)) tailH0.push(h);
    }
  }
  const H_tail_mean = tailH0.length > 0
    ? tailH0.reduce((s, x) => s + x, 0) / tailH0.length
    : NaN;
  const H_tail_std = tailH0.length > 1
    ? Math.sqrt(tailH0.reduce((s, x) => s + (x - H_tail_mean) ** 2, 0) / (tailH0.length - 1))
    : NaN;

  return {
    case_id: c.id, status: 'ok',
    steady_H0, peak_H0,
    t_peak: Number.isFinite(t_peak) ? t_peak : '',
    t_firstExceed: Number.isFinite(t_firstExceed) ? t_firstExceed : '',
    V_gas_max, V_gas_max_global,
    V_gas_max_per_node: JSON.stringify(vGasPerNode),
    H_at_2L_a: Number.isFinite(H_at_2L_a_val) ? H_at_2L_a_val : '',
    H_tail_mean: Number.isFinite(H_tail_mean) ? H_tail_mean : '',
    H_tail_std:  Number.isFinite(H_tail_std)  ? H_tail_std  : '',
    NaN_count: nanCount,
    dt, simDuration, skip_reason: '',
  };
}

// ─── DEFAULT regression check (matrix §5.2) ────────────────────────────────────
function withinPct(actual: number, expected: number, pct: number): boolean {
  return Math.abs(actual - expected) / Math.abs(expected) <= pct;
}

function regressionReport(r: CaseResult): { pass: boolean; lines: string[] } {
  const lines: string[] = [];
  let pass = true;

  if (r.status !== 'ok') {
    lines.push(`DEFAULT case did not run cleanly: status=${r.status} reason=${r.skip_reason}`);
    return { pass: false, lines };
  }

  const check = (name: string, actual: number | '', expected: number, tol: number) => {
    if (actual === '' || !Number.isFinite(actual as number)) {
      lines.push(`  FAIL  ${name}: missing/non-finite`);
      pass = false;
      return;
    }
    const ok = withinPct(actual as number, expected, tol);
    const pctTxt = (tol * 100).toFixed(0);
    lines.push(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: actual=${(actual as number).toFixed(3)}, expected=${expected} ±${pctTxt}%`);
    if (!ok) pass = false;
  };

  lines.push('DEFAULT regression check (matrix §5.2):');
  check('steady_H0',     r.steady_H0,     DEFAULT_STEADY_H0,      REG_HEAD_TOL);
  check('peak_H0',       r.peak_H0,       DEFAULT_PEAK_H0,        REG_HEAD_TOL);
  check('t_peak',        r.t_peak,        DEFAULT_T_PEAK,         REG_HEAD_TOL);
  check('t_firstExceed', r.t_firstExceed, DEFAULT_T_FIRST_EXCEED, REG_HEAD_TOL);
  check('V_gas_max',     r.V_gas_max,     DEFAULT_VGAS_MAX,       REG_VGAS_TOL);

  return { pass, lines };
}

// ─── CSV emit ──────────────────────────────────────────────────────────────────
function toCsv(results: CaseResult[]): string {
  const header = 'case_id,status,steady_H0,peak_H0,t_peak,t_firstExceed,V_gas_max,V_gas_max_global,V_gas_max_per_node,H_at_2L_a,H_tail_mean,H_tail_std,NaN_count,dt,simDuration,skip_reason';
  const rows = results.map(r => [
    r.case_id, r.status,
    r.steady_H0, r.peak_H0, r.t_peak, r.t_firstExceed,
    r.V_gas_max, r.V_gas_max_global,
    `"${r.V_gas_max_per_node.replace(/"/g, '""')}"`,
    r.H_at_2L_a, r.H_tail_mean, r.H_tail_std,
    r.NaN_count, r.dt, r.simDuration,
    `"${r.skip_reason.replace(/"/g, '""')}"`,
  ].join(','));
  return [header, ...rows].join('\n') + '\n';
}

// Temporary filter for Phase 1.4 confirmation run. Set to null to run all CASES.
const SELECT: ReadonlySet<string> | null = new Set(['DEFAULT', 'R_02', 'E_01', 'E_02', 'C_03']);

// ─── Main ──────────────────────────────────────────────────────────────────────
function main(): void {
  console.log(`Running ${CASES.length} cases…`);
  const results: CaseResult[] = [];

  for (const c of CASES) {
    if (SELECT && !SELECT.has(c.id)) continue;
    process.stdout.write(`  ${c.id.padEnd(8)} `);
    const r = runCase(c);
    results.push(r);
    if (r.status === 'ok') {
      console.log(`ok  H0_steady=${(r.steady_H0 as number).toFixed(2)} H0_peak=${(r.peak_H0 as number).toFixed(2)} NaN=${r.NaN_count}`);
    } else {
      console.log(`${r.status.padEnd(4)} ${r.skip_reason}`);
    }
  }

  const csv = toCsv(results);
  fs.writeFileSync('results.csv', csv);
  console.log(`\nWrote results.csv (${results.length} rows).`);

  const defaultRow = results.find(r => r.case_id === 'DEFAULT');
  if (!defaultRow) {
    console.log('\nWARNING: DEFAULT case not found in results — regression check skipped.');
    return;
  }
  const reg = regressionReport(defaultRow);
  console.log('');
  for (const line of reg.lines) console.log(line);
  console.log(`\nDEFAULT regression: ${reg.pass ? 'PASS' : 'FAIL'}`);
}

main();
