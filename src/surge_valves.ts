// ── surge_valves.ts — Q21: QPRV size and closing time found automatically (solver stage 2) ──────────
//
// Stage 1 = the Unprotected run (no QPRV). Then the Q19 QPRV (solver.ts SECTION 7h) is run for the
// table sizes and closing times in [fastest, maximal] of each size (Kv = the table default), and the
// candidate is chosen, in this priority (ruling 2026-10-28, builder/inputs/Q19_surge_valves.md):
// the head comes back to the closing pressure → the smallest surge amplitude after the QPRV closed →
// the shortest closing time → the smallest size (row Q21: "smallest size that meets it wins a tie").
// The run with the chosen QPRV is stage 2. Both runs are kept, as in air_valves.ts.

import { SimulationResults, SAV_STATIC_FIRST_MIN, SAV_LOW_FROM, SAV_HIGH_M } from './solver';
import { dispatchSimulation, DispatchInputs, Scenario, SURGE_VALVE_TABLE, SavInput } from './scenario_dispatch';

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

/** The best of ts in the row's order (the earliest wins a full tie). */
const bestOf = (ts: QprvTrial[]): QprvTrial => ts.reduce((b, t) => (qprvOrder(t, b) < 0 ? t : b));

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
        let best = bestOf(Array.from({ length: COARSE_STEPS + 1 },
                                     (_, k) => trial(size, clamp(lo + (k * (hi - lo)) / COARSE_STEPS))));
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
    const scanned = new Set<number>();
    for (;;) {
        const lead = bestOf(tried);
        const next = SIZES.filter(size => {
            if (scanned.has(size)) return false;
            const b = bestOf(tried.filter(t => t.size_mm === size));
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
    const chosen = bestOf(tried);
    const stage2 = run(chosen.size_mm, chosen.closingTime, chosen.Kv);   // default length
    return { stage1, stage2, qprv: { size_mm: chosen.size_mm, Kv: chosen.Kv, closingTime: chosen.closingTime },
             maxHead: chosen.maxHead, tried };
}

// ── Q22: SAV size, closing time and hold-open found automatically ─────────────────────────────────────
//
// builder/inputs/Q19_surge_valves.md, 2026-10-29 sections 1 and 4, for the Q20 SAV (pump trip). Every
// run carries the air valves already placed (ANSWERS 2026-10-29 standing rule); the low set pressure
// comes from the Unprotected run (no devices, as the solver's own SAV_LOW_SET), the highest-surge time
// from the run with the air valves (ruling 2026-10-29). Gauge pressure p at node 0 (SAV + air valve, O2).

export const SAV_NOTE_EAS = 'Electrically Actuated SAV';
const SAV_HOLD_LEAD_S = 10;   // §4.4: hold open from the pump stop to (time of the highest surge − 10 s)

/** O4 low set and O5 high set, gauge [m]: low = midway (first minimum, static), or static / 2 when the
 *  minimum is atmospheric or below; high = pump working pressure + 7 m. */
export function savSetPressures(pStatic: number, firstMin: number, pWork: number): { low: number; high: number } {
    return { low: SAV_LOW_FROM(firstMin, pStatic), high: pWork + SAV_HIGH_M };
}

/** §1: d = √(Q·9e5/√P) [mm], Q [m³/s], P [m]; the smallest table size ≥ d (above the table: the largest). */
export function surgeValveFirstSize(Q: number, P: number): { d: number; size_mm: number } {
    if (!(Q > 0 && P > 0)) throw new Error(`Surge valve first size: Q (${Q}) and P (${P}) must be > 0.`);
    const d = Math.sqrt((Q * 9e5) / Math.sqrt(P));
    return { d, size_mm: SIZES.find(s => s >= d) ?? SIZES[SIZES.length - 1] };
}

/** §4.7: first closing time t = 0.0005·d² + 0.38·d [s], d = nominal size [mm]. */
export const savFirstClosingTime = (d_mm: number): number => 0.0005 * d_mm * d_mm + 0.38 * d_mm;

/** §4.8: t0 after k 10 % steps of t0 (k < 0 shortens), plus another 20 % of t0 when `margin`;
 *  kept to 0.1 s (worked example e allows rounding). */
export const savClosingTime = (t0: number, k: number, margin: boolean): number =>
    Math.round(t0 * (1 + 0.1 * k + (margin ? 0.2 : 0)) * 10) / 10;

/** One candidate run (Kv = the table default of its size). */
export interface SavTrial {
    size_mm:        number;
    closingTime:    number;    // [s]
    Kv:             number;
    holdOpenUntil?: number;    // [s] "Electrically Actuated SAV"
    rises:          boolean;   // p rose above static after max(pump stop, hold end) (§4.5/6)
    maxHead:        number;    // max head over the line in that run [m]
}

export interface SavStudy {
    stage1:       SimulationResults;   // run with the air valves placed, no SAV, default length
    stage2:       SimulationResults;   // run with the chosen SAV (same air valves), sav.runTime long
    sav:          Required<Pick<SavInput, 'size_mm' | 'Kv' | 'closingTime' | 'runTime'>> & { holdOpenUntil?: number };
    lowSet:       number;              // gauge at the SAV node [m] (from the Unprotected run)
    highSet:      number;
    firstSize_mm: number;              // §1 first size from lowSet and the steady flow
    runTime:      number;              // §4.1: Unprotected run time + chosen closing time, ≥ 40·L/a [s]
    notes:        string[];            // "Electrically Actuated SAV" iff holdOpenUntil is set; and any
                                       // unresolved or fallback step of the study (shown in the UI)
    maxHead:      number;              // max head over the line in stage 2 [m]
    tried:        SavTrial[];          // every candidate run, chosen included
}

export function sizeSav(scenario: Scenario, inputs: DispatchInputs): SavStudy {
    if (scenario !== 'pump-trip') throw new Error(`SAV sizing is for the pump-trip scenario only, not '${scenario}'.`);
    const base: DispatchInputs = { ...inputs, sav: undefined };
    const stage1 = dispatchSimulation(scenario, base);
    const unprot = dispatchSimulation(scenario, { ...base, airValves: undefined });
    const trip = inputs.pump.tripTime, z0 = stage1.nodes[0].elevation;
    const { Pst, pmin } = SAV_STATIC_FIRST_MIN(unprot, trip, inputs.reservoir.head);
    const { low: lowSet, high: highSet } = savSetPressures(Pst, pmin, stage1.nodes[0].steadyHead - z0);
    const first = surgeValveFirstSize(inputs.pump.initialFlow, lowSet), firstSize_mm = first.size_mm;
    const notes: string[] = [];
    if (first.d > firstSize_mm) {
        notes.push(`SAV first size: d = ${first.d.toFixed(1)} mm is above the largest table size; ${firstSize_mm} mm used`);
    }

    /** Max head over the line after the pump trip (the steady state left out) and its time [m, s]. */
    const postTripPeak = (r: SimulationResults) => {
        let t = -1, h = -Infinity;
        for (const e of r.fullHistory) if (e.time > trip) { const m = maxOf(e.heads); if (m > h) { h = m; t = e.time; } }
        return { t, h };
    };
    const holdEnd = postTripPeak(stage1).t - SAV_HOLD_LEAD_S;   // §4.3: highest surge, air-valve run

    /** First up-crossing of P_st by p after `from` (p below P_st first); −1 if none. `fromHold`: after
     *  the hold-open, p already above P_st counts as rising (the returning wave has arrived). */
    const risesAt = (r: SimulationResults, from: number, fromHold = false): number => {
        let below = fromHold;
        for (const e of r.fullHistory) {
            if (e.time <= from) continue;
            const p = e.heads[0] - z0;
            if (p < Pst) below = true; else if (below && p > Pst) return e.time;
        }
        return -1;
    };
    /** §4.8 / example e: p falls below the low set after the SAV's first closing ended (its opening
     *  back at 0 after first opening; solver telemetry). */
    const refalls = (r: SimulationResults): boolean => {
        const op = r.sav?.opening ?? [], H = r.fullHistory;
        let i = H.findIndex((e, j) => e.time > trip && op[j] > 0);
        if (i < 0) return false;
        while (i < H.length && op[i] > 0) i++;
        for (; i < H.length; i++) if (H[i].heads[0] - z0 < lowSet) return true;
        return false;
    };

    // §4.1: run time = Unprotected run time + closing time, never below the default 40·L/a (the
    // solver's own floor; same sum, same order as its travel time).
    const T_unprot = unprot.fullHistory[unprot.fullHistory.length - 1].time;
    const T_floor = 40.0 * base.pipes.reduce((s, p) => s + p.length / p.waveSpeed, 0.0);
    const tried: SavTrial[] = [];
    type Run = { t: SavTrial; peak: number; firstRise: number; refall: boolean };
    type SavSel = SavStudy['sav'];
    const run = (s: SavSel) => dispatchSimulation(scenario, { ...base, sav: s });
    const sel = (size_mm: number, closingTime: number, holdOpenUntil?: number): SavSel =>
        ({ size_mm, Kv: SURGE_VALVE_TABLE[size_mm][2], closingTime, runTime: Math.max(T_unprot + closingTime, T_floor),
           ...(holdOpenUntil !== undefined && { holdOpenUntil }) });
    const trial = (size_mm: number, closingTime: number, holdOpenUntil?: number): Run => {
        const s = sel(size_mm, closingTime, holdOpenUntil), r = run(s);   // r not kept (memory)
        const hold = holdOpenUntil !== undefined;
        const t: SavTrial = { size_mm, closingTime, Kv: s.Kv, ...(hold && { holdOpenUntil }),
                              rises: risesAt(r, Math.max(trip, holdOpenUntil ?? -Infinity), hold) > 0, maxHead: peakAll(r) };
        tried.push(t);
        return { t, peak: postTripPeak(r).h, firstRise: risesAt(r, trip), refall: refalls(r) };
    };
    const inRange = (size: number, t: number) => Math.min(SURGE_VALVE_TABLE[size][1], Math.max(SURGE_VALVE_TABLE[size][0], t));

    // §4.3-4.6 per size, first closing time: the pressure rises above static inside (pump stop,
    // t_max − 10 s) → held open to t_max − 10 s ("Electrically Actuated SAV"), run again.
    const bySize: Run[] = [];   // each size is visited once (down from the first size, or up from it)
    const atSize = (size: number): Run => {
        const ct = inRange(size, savClosingTime(savFirstClosingTime(size), 0, false));
        let r = trial(size, ct);
        if (r.firstRise > trip && r.firstRise < holdEnd) r = trial(size, ct, holdEnd);
        bySize.push(r);
        return r;
    };
    // §4.5: the first size does not rise → smaller sizes until one rises. §4.6: it rises → larger sizes
    // while they still rise; the lowest max head after the trip wins (the smaller size on a tie).
    let i = SIZES.indexOf(firstSize_mm), best = atSize(SIZES[i]);
    if (!best.t.rises) {
        while (i > 0 && !best.t.rises) best = atSize(SIZES[--i]);
        // Builder decision (LOOK-AT): no size rises above static → the lowest max head tried.
        if (!best.t.rises) {
            best = bySize.reduce((b, r) => (r.peak < b.peak ? r : b));
            notes.push(`SAV size: the pressure does not rise above static (${Pst.toFixed(2)} m) after the pump ` +
                       `stop with any size tried; ${best.t.size_mm} mm (lowest max head) chosen`);
        }
    } else {
        for (let j = i + 1; j < SIZES.length; j++) {
            const r = atSize(SIZES[j]);
            if (!r.t.rises) break;
            if (r.peak < best.peak) best = r;
        }
    }

    // §4.8 closing time of the chosen size (its hold kept): falls below the low set again → lengthen in
    // 10 % steps of t0 until it does not, then another 20 %; else shorten in 10 % steps while it neither
    // falls again nor stops rising, not below 1.5 · fastest. Capped at the size's maximal time (builder).
    const size = best.t.size_mm, hold = best.t.holdOpenUntil, t0 = savFirstClosingTime(size);
    const [fastest, maximal] = SURGE_VALVE_TABLE[size];
    let chosen = best;
    if (best.refall) {
        let k = 0, cur = best;
        while (cur.refall && cur.t.closingTime < maximal) cur = trial(size, inRange(size, savClosingTime(t0, ++k, false)), hold);
        chosen = cur.refall ? cur : trial(size, inRange(size, savClosingTime(t0, k, true)), hold);
        if (cur.refall) {
            notes.push(`SAV closing time: at the ${size} mm maximal closing time (${chosen.t.closingTime} s) the ` +
                       `pressure still falls below the low set (${lowSet.toFixed(2)} m) after the closing; not resolved`);
        }
    } else {
        for (let k = -1; ; k--) {
            const ct = savClosingTime(t0, k, false);
            if (ct < 1.5 * fastest) break;
            const r = trial(size, ct, hold);
            if (r.refall || !r.t.rises) break;
            chosen = r;
        }
    }

    const sav = sel(size, chosen.t.closingTime, hold);
    const stage2 = run(sav);
    return { stage1, stage2, sav, lowSet, highSet, firstSize_mm, runTime: sav.runTime,
             notes: [...(hold !== undefined ? [SAV_NOTE_EAS] : []), ...notes], maxHead: peakAll(stage2), tried };
}
