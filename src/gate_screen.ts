// ── gate_screen.ts — what Screen 2 draws, as data (Row 3.11 Unit C, D-5c) ───────────────────────
//
// Screen 2 renders two things and computes neither: the steady state, through `gate_view.ts`'s
// projection, and Unit B's `GateReport`, verbatim. This file is the thin layer between those and the
// JSX, kept out of `App.tsx` so a harness (`gate_screen_S70.ts`) can prove the chart's data IS the
// engine's rows rather than a re-derivation of them.
//
// THE LINE (PLAN_S68.md §1.2, PLAN_S69.md §3): no head, pressure, margin or velocity is computed
// here. Each chart point copies a `NodeRow`; the vapour line is `VAPOR_HEAD_AT`, imported, the one
// vapour floor in the program. The only arithmetic is unit display (m3/h, bar).
//
// SERIES-ONLY. Node-to-reach attribution assumes each reach's nodes are the contiguous range
// firstNode..lastNode, which holds on a series main (BACKLOG: pipeIds/pipeParams pairing).

import { VAPOR_HEAD_AT, GateCode, G } from './solver';
import { GateCheck, GateReport } from './gate_checks';
import { NodeRow, ReachRow, ProfileView } from './gate_view';

/** Display-only unit factor: 1 m of water = rho*g/1e5 bar, rho = 1000 kg/m3, g = solver G. */
export const BAR_PER_M = 1000 * G / 1e5;

/** Display-only `toFixed` without a negative zero: a value that rounds to zero prints `0.00`, not `-0.00`. */
export function fixedNoNegZero(x: number, digits: number): string {
    const s = x.toFixed(digits);
    return /^-0\.?0*$/.test(s) ? s.slice(1) : s;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// The chart
// ════════════════════════════════════════════════════════════════════════════════════════════════

export interface GateChartPoint {
    /** The engine's node row, carried whole — the tooltip reads it, never a recomputed copy. */
    row:       NodeRow;
    distance:  number;
    elevation: number;
    head:      number;
    /** `VAPOR_HEAD_AT(elevation)` — the vapour line. */
    vapour:    number;
    /**
     * The reach(es) this point's flow and velocity are read from (PLAN_S68.md §1.2): the downstream
     * reach at a node; the upstream one at the terminal node; BOTH at a junction where the diameter
     * changes, because there is no single velocity there.
     */
    reaches:   ReachRow[];
}

export function buildGateChartData(view: ProfileView): GateChartPoint[] {
    const last = view.nodes.length - 1;
    return view.nodes.map(row => {
        const down = view.reaches.find(r => row.node >= r.firstNode && row.node < r.lastNode);
        const up   = view.reaches.find(r => row.node === r.lastNode);
        let reaches: ReachRow[];
        if (row.node === last || !down) reaches = up ? [up] : [];
        else if (up && up.diameter !== down.diameter) reaches = [up, down];
        else reaches = [down];
        return {
            row,
            distance:  row.distance,
            elevation: row.elevation,
            head:      row.head,
            vapour:    VAPOR_HEAD_AT(row.elevation),
            reaches,
        };
    });
}

/**
 * Below the vapour line. `!(margin >= 0)` rather than `margin < 0`: the same NaN-rejecting form B7
 * uses (`FIND_INIT_ADMISSIBLE`, `!(H >= Hvap)`), so a NaN head counts exactly where B7 flags it and
 * chart, tooltip and verdict cannot disagree. The one test, used by the shading and the tooltip.
 */
export function isBelowVapour(margin: number): boolean {
    return !(margin >= 0);
}

/** Reaches with at least one node below the vapour line — the shaded spans. */
export function vapourCrossingReaches(view: ProfileView): ReachRow[] {
    return view.reaches.filter(r =>
        view.nodes.some(n => n.node >= r.firstNode && n.node <= r.lastNode && isBelowVapour(n.margin)));
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// The tooltip — SPEC_S63.md §3.2, seven fields
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** Head and pressure travel as ONE value, so nothing can show one without the other (§2 D2). */
export interface HeadAndPressure { head: number; pressureM: number; pressureBar: number; }

export interface TooltipFields {
    distance:  number;
    elevation: number;
    headAndPressure: HeadAndPressure;
    /** One entry per reach in `GateChartPoint.reaches`: flow in m3/s and m3/h, velocity in m/s. */
    flow: { pipeId: string; m3s: number; m3h: number; velocity: number }[];
    margin:    number;
}

export function tooltipFields(p: GateChartPoint): TooltipFields {
    return {
        distance:  p.row.distance,
        elevation: p.row.elevation,
        headAndPressure: {
            head:        p.row.head,
            pressureM:   p.row.pressure,
            pressureBar: p.row.pressure * BAR_PER_M,
        },
        flow: p.reaches.map(r => ({
            pipeId: r.pipeId, m3s: r.flow, m3h: r.flow * 3600, velocity: r.velocity,
        })),
        margin: p.row.margin,
    };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// The report — read, never re-derived
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Four display classes over THREE verdicts. Verdict and severity are read separately (PLAN_S68.md
 * §4 6.2/6.3): `not-evaluated` is never drawn as a pass, and a failed advisory is never a failure.
 */
export type CheckClass = 'pass' | 'fail-blocking' | 'fail-advisory' | 'not-evaluated';

export function classifyCheck(c: GateCheck): CheckClass {
    switch (c.verdict) {
        case 'pass':          return 'pass';
        case 'not-evaluated': return 'not-evaluated';
        case 'fail':          return c.severity === 'blocking' ? 'fail-blocking' : 'fail-advisory';
    }
}

/**
 * Numbers are never hidden when a steady state exists (Assaf's rulings, `builder/ANSWERS.md`
 * 2026-10-02 Q2, which replace PLAN_S68.md §1.3's suppression): a partially filled pipe and a
 * non-turbulent flow both keep every number, each with its warning from `numberCaveats`.
 */
export type SummaryMode = 'no-steady' | 'numbers';

export function summaryMode(report: GateReport): SummaryMode {
    return report.steady ? 'numbers' : 'no-steady';
}

/** The B7 check, when it failed (drives `isPartiallyFilled`; exported for the S70 harness, S2/S5). */
export function failedB7(report: GateReport): GateCheck | undefined {
    return report.checks.find(c => c.code === 'B7' && c.verdict === 'fail');
}

// The ruled wording, verbatim (`builder/ANSWERS.md` 2026-10-02 Q2).
export const PARTIALLY_FILLED_WARNING =
    'Partially filled pipe — the calculation model does not cover this state. These numbers are not reliable.';
export const NON_TURBULENT_NOTE =
    'Non-turbulent flow — the calculation model does not cover this state. These numbers are not reliable.';

/**
 * Partially filled pipe: the steady state was computed and its pressure line is below vapour (B7
 * failed in the state phase). A B7 with no steady state is the input-phase reservoir check, which
 * never reaches Screen 2.
 */
export function isPartiallyFilled(report: GateReport): boolean {
    return !!report.steady && !!failedB7(report);
}

/**
 * The warnings shown beside the steady-state numbers (summary rail, chart, tooltip). Non-turbulent
 * reads the engine's own `reContractBlocked` flag — the Reynolds-contract guard's verdict — rather
 * than re-deriving a Reynolds number here.
 */
export function numberCaveats(report: GateReport): string[] {
    if (!report.steady) return [];
    const out: string[] = [];
    if (isPartiallyFilled(report)) out.push(PARTIALLY_FILLED_WARNING);
    if (report.reContractBlocked) out.push(NON_TURBULENT_NOTE);
    return out;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// What the user reads — D-6 (Assaf's rulings, `builder/ANSWERS.md` 2026-10-03 Q2 and 2026-10-04 Q3)
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// Every gate surface (header, Screen 2's rail, the modal) prints `gateMessage` and nothing else: no
// check codes, no list of which checks ran, no log. Pass = one line, then one plain "Note: ..." per
// advisory that fired. Fail = "System Check Failed:", then one short plain line per distinct problem.
// The line is picked by CODE, and a check counts only through its engine verdict and severity
// (`classifyCheck`), so an advisory can never print as a problem, nor a problem as a note (L169).

export const GATE_PASS_LINE  = 'All checks passed - transient simulation can be run';
export const GATE_FAIL_TITLE = 'System Check Failed:';
/** The state phase threw: no blocking check failed, yet there is no steady state to run from. */
export const STEADY_FAILED_LINE = 'Steady state could not be calculated';

/** One short plain line per blocking check (builder's wording, LOOK-AT 2026-10-03, not overruled). */
const PROBLEM_LINE: Record<GateCode, string> = {
    B1: 'Missing or invalid input value',
    B2: 'Zero flow - there is no transient to calculate',
    B3: 'Too low flow - non turbulent flow calculations are unreliable',
    B4: 'Negative pressure entered',
    B5: 'Insufficient pressure/head',
    B6: 'Invalid valve coefficient (Kv)',
    B7: 'Partially filled pipe section',
    B8: 'Pipe list empty, or a pipe with zero or negative length or diameter',
    B9: 'Invalid valve closure timing',
    // Advisories: the text after "Note: " (SPEC_S63.md §4.2's conditions, in plain words).
    A1: 'Low flow - the accuracy of the results has not been verified at this flow',
    A2: 'Velocity above 3 m/s',
    A3: 'Pressure line within 2 m of the vapour line',
    A4: 'A pipe segment is shorter than one calculation step',
    A5: 'Valve closes faster than one pressure-wave round trip - surge will be maximal',
};

export interface GateMessage {
    /** `report.runAnalysisAvailable`, read, never re-derived (§1.1). */
    passed: boolean;
    /** Distinct problems, B1…B9 order. Empty when `passed`. */
    problems: string[];
    /**
     * One distinct "Note: ..." per advisory check that failed, at most `MAX_NOTES` (enforced below,
     * not only argued). The engine has five advisories (A1…A5), so today the cap never cuts. If it
     * ever does, the first notes in check order are kept: which notes are "most significant" is not
     * ruled (ANSWERS 2026-10-04 Q3), see LOOK-AT.
     */
    notes: string[];
}

/** Assaf's cap (ANSWERS 2026-10-04 Q3): at most 5 notes. */
export const MAX_NOTES = 5;

export function gateMessage(report: GateReport): GateMessage {
    const problems: string[] = [];
    const notes: string[] = [];
    for (const c of report.checks) {
        const k = classifyCheck(c);
        if (k === 'fail-blocking' && !problems.includes(PROBLEM_LINE[c.code])) problems.push(PROBLEM_LINE[c.code]);
        const note = `Note: ${PROBLEM_LINE[c.code]}`;
        if (k === 'fail-advisory' && !notes.includes(note)) notes.push(note);
    }
    if (report.stateError !== undefined) problems.push(STEADY_FAILED_LINE);
    const passed = report.runAnalysisAvailable;
    return { passed, problems: passed ? [] : problems, notes: notes.slice(0, MAX_NOTES) };
}

/**
 * `Run Analysis` reads `runAnalysisAvailable` and nothing else (§1.1). It carries no reason text of
 * its own: the user reads why through `gateMessage` (GateMessageView), the one source of that text.
 */
export function runAnalysisState(report: GateReport): { available: boolean } {
    return { available: report.runAnalysisAvailable };
}

/**
 * Where `Acknowledge & Return` goes (PLAN_S68.md §5.3, MOCKUP_NOTES_S65.md §7.1). Routing is by
 * check code to owning screen, never by reading `finding.where`.
 *   - Gate 1 (`inputBlocked`): Screen 1 — every gate-1 fault is a field on it.
 *   - Gate 2, B7 only: stay on Screen 2 — B7 has no field; the shaded chart reach is where it is.
 *   - Gate 2, anything else (B2/B3/the Reynolds B1 -> the flow input; a geometry B1 -> the pipe
 *     table; a state phase that threw): Screen 1. Screen 2 has no editable table (Q2 built none).
 */
export function acknowledgeReturnTo(report: GateReport): 'input' | 'gate' {
    if (report.inputBlocked) return 'input';
    const failing = report.checks.filter(c => classifyCheck(c) === 'fail-blocking').map(c => c.code);
    const b7Only = report.stateError === undefined && failing.length > 0 && failing.every(c => c === 'B7');
    return b7Only ? 'gate' : 'input';
}

/** The 3-second auto-dismiss: only the genuinely clean case (PLAN_S68.md §4 6.6). Else it waits. */
export function modalAutoDismiss(report: GateReport): boolean {
    const m = gateMessage(report);
    return m.passed && m.notes.length === 0;
}
