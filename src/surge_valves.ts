// ── surge_valves.ts — Q21: QPRV size and closing time found automatically (solver stage 2) ──────────
//
// Stage 1 = the Unprotected run (no QPRV). Then the Q19 QPRV (solver.ts SECTION 7h) is run for the
// table sizes and closing times in [fastest, maximal] of each size (Kv = the table default), and the
// candidate is chosen, in this priority (ruling 2026-10-28, builder/inputs/Q19_surge_valves.md):
// the head comes back to the closing pressure → the smallest surge amplitude after the QPRV closed →
// the shortest closing time → the smallest size (row Q21: "smallest size that meets it wins a tie").
// The run with the chosen QPRV is stage 2. Both runs are kept, as in air_valves.ts.

import { SimulationResults } from './solver';
import { dispatchSimulation, DispatchInputs, Scenario, SURGE_VALVE_TABLE } from './scenario_dispatch';

/** One candidate run (Kv = the table default of its size). */
export interface QprvTrial {
    size_mm:     number;
    closingTime: number;    // [s]
    Kv:          number;
    returns:     boolean;   // the QPRV held its node at the closing pressure (never above it), closed,
                            // and a full amplitude window followed its closure within the run
    amplitude:   number;    // half the head swing at the QPRV over the amplitude window after it
                            // closed [m]; 0 if it never opened
    maxHead:     number;    // max head over the line in the default-length run (40·L/a) [m]
}

export interface QprvStudy {
    stage1:  SimulationResults;                                    // Unprotected run (no QPRV)
    stage2:  SimulationResults;                                    // run with the chosen QPRV
    qprv:    { size_mm: number; Kv: number; closingTime: number }; // the chosen QPRV
    maxHead: number;                                               // max head over the line in stage 2 [m]
    tried:   QprvTrial[];                                          // every candidate run, chosen included
}

// Amplitudes are kept in steps of this [m] (numerics): candidates in the same step tie, so the row's
// order is a total order (a tolerance tie is not transitive and can cycle) and a best always exists.
export const QPRV_AMP_STEP_M = 0.02;
const RETURN_TOL_M           = 0.01;   // closing-pressure check tolerance [m] (numerics)
const COARSE_STEPS           = 6;      // first pass: fastest, maximal and 5 times between, per size
// Amplitude window after closure, in wave periods 4L/a, the same for every candidate of a study
// (builder reading, LOOK-AT Q21): one period holds a full swing; two leave margin for its phase.
const AMP_WINDOW_PERIODS     = 2;
// Full-scan margin (builder's, 2 x the largest halving miss measured): a size whose search best,
// less this, is still worse than the leader is not scanned in full.
const SCAN_REL               = 0.2;    // of the size's search-best amplitude
const SCAN_ABS_M             = 0.04;   // [m], 2 amplitude steps
const SIZES = Object.keys(SURGE_VALVE_TABLE).map(Number).sort((a, b) => a - b);

/** Largest of xs (a loop: a spread over a long history can overflow the call stack). */
function maxOf(xs: Iterable<number>): number {
    let m = -Infinity;
    for (const x of xs) if (x > m) m = x;
    return m;
}

export const peakAll = (r: SimulationResults): number => maxOf(r.nodes.map(n => n.maxHead));

/** The row's order as a sort comparator (< 0: a is better): returns → amplitude → closing time → size. */
export const qprvOrder = (a: QprvTrial, b: QprvTrial): number =>
    Number(b.returns) - Number(a.returns) || a.amplitude - b.amplitude ||
    a.closingTime - b.closingTime || a.size_mm - b.size_mm;

/**
 * Judges one study run (a candidate run longer than the default, solver QPRV telemetry; the QPRV is at
 * the valve node, the last). `nDefault` = entries of the default-length run (its steps are the first
 * ones of this run, bit-for-bit), `window` = the amplitude window after closure [s].
 */
function judge(r: SimulationResults, nDefault: number, window: number): Pick<QprvTrial, 'returns' | 'amplitude' | 'maxHead'> {
    const op = r.qprv?.opening ?? [], H_open = r.qprv?.H_open ?? Infinity;
    const n = r.nodes.length - 1, h = r.fullHistory, T1 = h[h.length - 1].time;
    const maxHead = maxOf(h.slice(0, nDefault).flatMap(e => e.heads));
    /** Half the swing of the head at the QPRV over [t0, t0 + window]. */
    const amp = (t0: number) => {
        const hs = h.filter(e => e.time >= t0 && e.time <= t0 + window).map(e => e.heads[n]);
        const half = (maxOf(hs) + maxOf(hs.map(x => -x))) / 2;   // (max − min) / 2
        return Math.round(half / QPRV_AMP_STEP_M) * QPRV_AMP_STEP_M;
    };
    const held = r.nodes[n].maxHead <= H_open + RETURN_TOL_M;   // never above the closing pressure
    let last = op.length - 1;
    while (last >= 0 && !(op[last] > 0)) last--;
    if (last < 0) return { returns: held, amplitude: 0, maxHead };                     // never opened
    const tClose = h[last + 1]?.time ?? Infinity;                                       // first shut sample
    if (tClose + window > T1) return { returns: false, amplitude: amp(T1 - window), maxHead };   // no full window
    return { returns: held, amplitude: amp(tClose), maxHead };
}

/** The study's runs: stage 1 and `trial(size, closing time)`, each candidate run once and kept in
 *  `tried` (exported for the full-scan check, findings/q21/scan_Q21.ts). */
export function qprvTrials(scenario: Scenario, inputs: DispatchInputs) {
    if (scenario === 'pump-trip') throw new Error(`QPRV sizing is for valve-closure scenarios only, not '${scenario}'.`);
    const base: DispatchInputs = { ...inputs, qprv: undefined };
    const stage1 = dispatchSimulation(scenario, base);
    // Each candidate runs for the default length (40·L/a, fixed for valve runs) + its closing time + the
    // amplitude window, so a QPRV that starts its last closing within the default run is seen shut and
    // followed by a full window.
    const nDefault = stage1.fullHistory.length, T_default = stage1.fullHistory[nDefault - 1].time;
    const window = AMP_WINDOW_PERIODS * 4 * base.pipes.reduce((s, p) => s + p.length / p.waveSpeed, 0);
    const tried: QprvTrial[] = [];
    const run = (size_mm: number, closingTime: number, Kv: number, runTime?: number) =>
        dispatchSimulation(scenario, { ...base, qprv: { size_mm, closingTime, Kv, runTime } });
    const trial = (size_mm: number, closingTime: number): QprvTrial => {
        const seen = tried.find(t => t.size_mm === size_mm && t.closingTime === closingTime);
        if (seen) return seen;
        const Kv = SURGE_VALVE_TABLE[size_mm][2];
        const r = run(size_mm, closingTime, Kv, T_default + closingTime + window);   // not kept (memory)
        const t = { size_mm, closingTime, Kv, ...judge(r, nDefault, window) };
        tried.push(t);
        return t;
    };
    return { stage1, tried, trial, run };
}

export function sizeQprv(scenario: Scenario, inputs: DispatchInputs): QprvStudy {
    const { stage1, tried, trial, run } = qprvTrials(scenario, inputs);
    // Per size: whole seconds; a coarse pass over [fastest, maximal], then halve the step around the
    // best time until 1 s (both 1 s neighbours of the size's best are run).
    for (const size of SIZES) {
        const [lo, hi] = SURGE_VALVE_TABLE[size];
        const clamp = (t: number) => Math.min(hi, Math.max(lo, Math.round(t)));
        let best = trial(size, lo);
        for (let k = 1; k <= COARSE_STEPS; k++) {
            const t = trial(size, clamp(lo + (k * (hi - lo)) / COARSE_STEPS));
            if (qprvOrder(t, best) < 0) best = t;
        }
        for (let step = Math.ceil((hi - lo) / COARSE_STEPS / 2); step >= 1; step = step === 1 ? 0 : Math.ceil(step / 2)) {
            for (let moved = true; moved;) {
                moved = false;
                for (const t of [best.closingTime - step, best.closingTime + step].map(clamp).map(x => trial(size, x))) {
                    if (qprvOrder(t, best) < 0) { best = t; moved = true; }
                }
            }
        }
    }

    // Every whole second of each size that could still tie or beat the leader (the halving misses dips:
    // measured up to 0.66 m / 9.9 % of a size's amplitude, findings/q21/fullscan_Q21.ts). A size's
    // optimistic candidate = its search best's `returns`, amplitude less SCAN_REL and SCAN_ABS_M, its
    // fastest time; it is scanned unless the leader is strictly better. Repeat until none is left (the
    // leader only improves, so this ends). All sizes scanned = 200-330 s per study, over the limit.
    const best = (ts: QprvTrial[]) => ts.reduce((b, t) => (qprvOrder(t, b) < 0 ? t : b));
    const scanned = new Set<number>();
    for (;;) {
        const lead = best(tried);
        const next = SIZES.filter(size => {
            if (scanned.has(size)) return false;
            const b = best(tried.filter(t => t.size_mm === size));
            const amplitude = Math.max(0, b.amplitude * (1 - SCAN_REL) - SCAN_ABS_M);
            return qprvOrder(lead, { ...b, amplitude, closingTime: SURGE_VALVE_TABLE[size][0] }) >= 0;
        });
        if (next.length === 0) break;
        for (const size of next) {
            const [lo, hi] = SURGE_VALVE_TABLE[size];
            for (let c = lo; c <= hi; c++) trial(size, c);
            scanned.add(size);
        }
    }
    const chosen = best(tried);
    const stage2 = run(chosen.size_mm, chosen.closingTime, chosen.Kv);   // default length
    return { stage1, stage2, qprv: { size_mm: chosen.size_mm, Kv: chosen.Kv, closingTime: chosen.closingTime },
             maxHead: chosen.maxHead, tried };
}
