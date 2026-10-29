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
    returns:     boolean;   // the QPRV held its node at the closing pressure, closed, and the head there
                            // stayed ≤ the closing pressure in the last 10 % of the run
    amplitude:   number;    // half the head swing at the QPRV after it closed [m]; 0 if it never opened
    maxHead:     number;    // max head over the line [m]
}

export interface QprvStudy {
    stage1:  SimulationResults;                                    // Unprotected run (no QPRV)
    stage2:  SimulationResults;                                    // run with the chosen QPRV
    qprv:    { size_mm: number; Kv: number; closingTime: number }; // the chosen QPRV
    maxHead: number;                                               // max head over the line in stage 2 [m]
    tried:   QprvTrial[];                                          // every candidate run, chosen included
}

export const QPRV_AMP_TIE_M  = 0.01;   // amplitudes within this are a tie [m] (numerics)
const RETURN_TOL_M           = 0.01;   // closing-pressure check tolerance [m] (numerics)
const COARSE_STEPS           = 6;      // first pass: fastest, maximal and 5 times between, per size

export const peakAll = (r: SimulationResults): number => Math.max(...r.nodes.map(n => n.maxHead));

/** The row's order, amplitude with the tie tolerance: o strictly better than c. */
const better = (o: QprvTrial, c: QprvTrial): boolean => {
    if (o.returns !== c.returns) return o.returns;
    if (Math.abs(o.amplitude - c.amplitude) > QPRV_AMP_TIE_M) return o.amplitude < c.amplitude;
    if (o.closingTime !== c.closingTime) return o.closingTime < c.closingTime;
    return o.size_mm < c.size_mm;
};

/** Returns and amplitude from the solver's QPRV telemetry (the QPRV is at the valve node, the last). */
function judge(r: SimulationResults): { returns: boolean; amplitude: number } {
    const op = r.qprv?.opening ?? [], H_open = r.qprv?.H_open ?? Infinity;
    const n = r.nodes.length - 1, h = r.fullHistory, T1 = h[h.length - 1].time;
    const endHeads = (from: number) => h.slice(from).map(e => e.heads[n]);
    const half = (hs: number[]) => (Math.max(...hs) - Math.min(...hs)) / 2;
    const tail = endHeads(h.findIndex(e => e.time >= 0.9 * T1));
    const held = r.nodes[n].maxHead <= H_open + RETURN_TOL_M && Math.max(...tail) <= H_open + RETURN_TOL_M;
    let last = op.length - 1;
    while (last >= 0 && !(op[last] > 0)) last--;
    if (last < 0) return { returns: held, amplitude: 0 };                              // never opened
    if (last === op.length - 1) return { returns: false, amplitude: half(tail) };      // still open at the end
    return { returns: held, amplitude: half(endHeads(last + 1)) };
}

export function sizeQprv(scenario: Scenario, inputs: DispatchInputs): QprvStudy {
    if (scenario === 'pump-trip') throw new Error(`QPRV sizing is for valve-closure scenarios only, not '${scenario}'.`);
    const base: DispatchInputs = { ...inputs, qprv: undefined };
    const stage1 = dispatchSimulation(scenario, base);
    const tried: QprvTrial[] = [];
    const run = (size_mm: number, closingTime: number, Kv: number) =>
        dispatchSimulation(scenario, { ...base, qprv: { size_mm, closingTime, Kv } });
    const trial = (size_mm: number, closingTime: number): QprvTrial => {
        const seen = tried.find(t => t.size_mm === size_mm && t.closingTime === closingTime);
        if (seen) return seen;
        const Kv = SURGE_VALVE_TABLE[size_mm][2];
        const r = run(size_mm, closingTime, Kv);   // not kept (memory); the chosen one is run again
        const t = { size_mm, closingTime, Kv, ...judge(r), maxHead: peakAll(r) };
        tried.push(t);
        return t;
    };

    // The row's order as a sort comparator, the amplitude seen through `amp`.
    const order = (amp: (x: number) => number) => (a: QprvTrial, b: QprvTrial) =>
        Number(b.returns) - Number(a.returns) || amp(a.amplitude) - amp(b.amplitude) ||
        a.closingTime - b.closingTime || a.size_mm - b.size_mm;
    // Search order: the amplitude in QPRV_AMP_TIE_M steps (transitive, so the pattern search below
    // cannot cycle; the tolerance relation `better` can).
    const key = order(x => Math.round(x / QPRV_AMP_TIE_M));

    // Per size: whole seconds; a coarse pass over [fastest, maximal], then halve the step around the
    // best time until 1 s (both 1 s neighbours of the size's best are run).
    for (const size of Object.keys(SURGE_VALVE_TABLE).map(Number).sort((a, b) => a - b)) {
        const [lo, hi] = SURGE_VALVE_TABLE[size];
        const clamp = (t: number) => Math.min(hi, Math.max(lo, Math.round(t)));
        let best = trial(size, lo);
        for (let k = 1; k <= COARSE_STEPS; k++) {
            const t = trial(size, clamp(lo + (k * (hi - lo)) / COARSE_STEPS));
            if (key(t, best) < 0) best = t;
        }
        for (let step = Math.ceil((hi - lo) / COARSE_STEPS / 2); step >= 1; step = step === 1 ? 0 : Math.ceil(step / 2)) {
            for (let moved = true; moved;) {
                moved = false;
                for (const t of [best.closingTime - step, best.closingTime + step].map(clamp).map(x => trial(size, x))) {
                    if (key(t, best) < 0) { best = t; moved = true; }
                }
            }
        }
    }

    // The choice: a candidate no tried one beats; the order's tie tolerance can, in principle, leave
    // none (a cycle) — then the row's order without the tolerance decides.
    const sorted = [...tried].sort(order(x => x));
    const chosen = sorted.find(c => !tried.some(o => better(o, c))) ?? sorted[0];
    const stage2 = run(chosen.size_mm, chosen.closingTime, chosen.Kv);
    return { stage1, stage2, qprv: { size_mm: chosen.size_mm, Kv: chosen.Kv, closingTime: chosen.closingTime },
             maxHead: chosen.maxHead, tried };
}
