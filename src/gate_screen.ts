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

import { VAPOR_HEAD_AT } from './solver';
import { GateCheck, GateReport } from './gate_checks';
import { NodeRow, ReachRow, ProfileView } from './gate_view';

/** Display-only unit factor: 1 m of water = rho*g/1e5 bar, rho = 1000 kg/m3, g = 9.81 (solver's G). */
export const BAR_PER_M = 1000 * 9.81 / 1e5;

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
 * Reaches with at least one node below the vapour line — the shaded spans. `!(margin >= 0)` rather
 * than `margin < 0`: the same NaN-rejecting form B7 uses (`FIND_INIT_ADMISSIBLE`, `!(H >= Hvap)`), so a
 * NaN head is shaded exactly where B7 flags it and chart and verdict cannot disagree.
 */
export function vapourCrossingReaches(view: ProfileView): ReachRow[] {
    return view.reaches.filter(r =>
        view.nodes.some(n => n.node >= r.firstNode && n.node <= r.lastNode && !(n.margin >= 0)));
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
 * PLAN_S68.md §1.3. `reContractBlocked` is the ONLY trigger for suppressing the numbers; a B7 keeps
 * them, because they are the finding's own evidence.
 */
export type SummaryMode = 'no-steady' | 'numbers' | 'evidence';

export function summaryMode(report: GateReport): SummaryMode {
    if (!report.steady) return 'no-steady';
    return report.reContractBlocked ? 'evidence' : 'numbers';
}

/** The B7 check, when it failed — its findings are shown verbatim beside the shaded reach. */
export function failedB7(report: GateReport): GateCheck | undefined {
    return report.checks.find(c => c.code === 'B7' && c.verdict === 'fail');
}

/** `Run Analysis` reads `runAnalysisAvailable` and nothing else (§1.1); the reason lists the blockers. */
export function runAnalysisState(report: GateReport): { available: boolean; reason: string } {
    if (report.runAnalysisAvailable) return { available: true, reason: '' };
    const codes = report.checks
        .filter(c => classifyCheck(c) === 'fail-blocking')
        .map(c => c.code);
    return {
        available: false,
        reason: `Run Analysis unavailable: ${report.blocking.length} blocking finding` +
                `${report.blocking.length === 1 ? '' : 's'} (${codes.join(', ')}). See the findings list.`,
    };
}
