// ── surge_valves.ts — Q29: QPRV size and closing time by Assaf's 2026-10-29 process (solver stage 2) ──
//
// builder/inputs/Q19_surge_valves.md, 2026-10-29 sections 1-3, for the Q19 QPRV (solver.ts SECTION 7h)
// at the end-valve node (the last; O2). Stage 1 = the Unprotected run (no QPRV). Every candidate runs
// for the Unprotected run time + its closing time (§3); stage 2 = the chosen candidate's run. Both
// runs are kept, as in air_valves.ts. Replaces the Q21 search (row Q29).

import { SimulationResults, SAV_STATIC_FIRST_MIN, SAV_LOW_FROM, SAV_HIGH_M } from './solver';
import { dispatchSimulation, DispatchInputs, Scenario, SURGE_VALVE_TABLE, SavInput, QprvInput } from './scenario_dispatch';

export const QPRV_NOTE_STEPPED = 'Stepped Closure Add-on Required';
const QPRV_TOL_M     = 0.01;   // "below / back at the set pressure" tolerance [m] (numerics)
const QPRV_FALL_S    = 5;      // §3: the head falls below the set pressure within 5 s of the opening
const QPRV_MAX_STEPS = 40;     // §3 lengthening cap: 40 steps of 10 % = 5 · t0 (builder; LOOK-AT Q29)

/** One candidate run (Kv = the table default of its size). */
export interface QprvTrial {
    size_mm:     number;
    closingTime: number;    // [s]
    Kv:          number;
    opened:      boolean;   // the QPRV opened at all
    fallsIn:     number;    // [s] from the first opening to the head at the QPRV first below the set
                            // pressure; Infinity if it never falls below it
    minHead:     number;    // lowest head at the QPRV after that fall, before it is back at the set
                            // pressure (or the run ends) [m]; NaN if no fall
    reRises:     boolean;   // after that fall the head is back at the set pressure while the QPRV is
                            // still open, i.e. during its closing (§3)
}

export interface QprvStudy {
    stage1:       SimulationResults;   // Unprotected run (no QPRV), default length
    stage2:       SimulationResults;   // run with the chosen QPRV, qprv.runTime long
    qprv:         Required<Pick<QprvInput, 'size_mm' | 'Kv' | 'closingTime' | 'runTime'>> & { steppedClosure?: true };
    firstSize_mm: number;              // §1 first size
    runTime:      number;              // §3: Unprotected run time + chosen closing time [s]
    notes:        string[];            // QPRV_NOTE_STEPPED when §3's lengthening reached the size's
                                       // maximal closing time; and any unresolved step (shown in the UI)
    maxHead:      number;              // max head over the line in stage 2 [m]
    tried:        QprvTrial[];         // every candidate run, in run order, chosen included
}
const SIZES = Object.keys(SURGE_VALVE_TABLE).map(Number).sort((a, b) => a - b);

/** Largest of xs (a loop: a spread over a long history can overflow the call stack). */
function maxOf(xs: Iterable<number>): number {
    let m = -Infinity;
    for (const x of xs) if (x > m) m = x;
    return m;
}

export const peakAll = (r: SimulationResults): number => maxOf(r.nodes.map(n => n.maxHead));

/** §2: first QPRV closing time = 10·Tc (Tc = 2L/a, Joukowsky); above the size's maximal → maximal;
 *  below its fastest → 0.0005·d² + 0.38·d (d = size [mm], the SAV's §4.7 formula). */
export function qprvFirstClosingTime(size_mm: number, Tc: number): number {
    const [fastest, maximal] = SURGE_VALVE_TABLE[size_mm], t = 10 * Tc;
    return t > maximal ? maximal : t < fastest ? savFirstClosingTime(size_mm) : t;
}

/** Reads one candidate run at the QPRV node (solver telemetry `qprv`): opening, 5 s fall, minimum,
 *  re-rise during closing (QprvTrial). */
function judgeQprv(r: SimulationResults): Omit<QprvTrial, 'size_mm' | 'closingTime' | 'Kv'> {
    const h = r.fullHistory, op = r.qprv?.opening ?? [], set = (r.qprv?.H_open ?? Infinity) - QPRV_TOL_M;
    const n = r.nodes.length - 1, iO = op.findIndex(s => s > 0);
    if (iO < 0) return { opened: false, fallsIn: Infinity, minHead: NaN, reRises: false };
    let i = iO;
    while (i < h.length && !(h[i].heads[n] < set)) i++;
    if (i === h.length) return { opened: true, fallsIn: Infinity, minHead: NaN, reRises: false };
    const fallsIn = h[i].time - h[iO].time;
    let minHead = Infinity;
    for (; i < h.length && !(h[i].heads[n] >= set); i++) minHead = Math.min(minHead, h[i].heads[n]);
    return { opened: true, fallsIn, minHead, reRises: i < h.length && op[i - 1] > 0 };
}

export function sizeQprv(scenario: Scenario, inputs: DispatchInputs): QprvStudy {
    if (scenario === 'pump-trip') throw new Error(`QPRV sizing is for valve-closure scenarios only, not '${scenario}'.`);
    const base: DispatchInputs = { ...inputs, qprv: undefined };
    const stage1 = dispatchSimulation(scenario, base);
    const n = stage1.nodes.length - 1, T_unprot = stage1.fullHistory[stage1.fullHistory.length - 1].time;
    const Tc = base.pipes.reduce((s, p) => s + (2 * p.length) / p.waveSpeed, 0);

    // §1: Q = steady flow at the valve; P = set pressure (reference + 7 m), gauge at the valve node.
    // The set head is the solver's own H_open, read from one probe run (any size; not a candidate).
    const probe = dispatchSimulation(scenario, { ...base, qprv: { size_mm: SIZES[0], closingTime: SURGE_VALVE_TABLE[SIZES[0]][0] } });
    const first = surgeValveFirstSize(stage1.fullHistory[0].flows?.[n] ?? NaN, probe.qprv!.H_open - stage1.nodes[n].elevation);
    const notes: string[] = [];
    if (first.d > first.size_mm) {
        notes.push(`QPRV first size: d = ${first.d.toFixed(1)} mm is above the largest table size; ${first.size_mm} mm used`);
    }

    const tried: QprvTrial[] = [];
    type Run = { q: QprvStudy['qprv']; r: SimulationResults; t: QprvTrial };
    const trial = (size_mm: number, closingTime: number): Run => {
        const [, maximal, Kv] = SURGE_VALVE_TABLE[size_mm];
        const q: QprvStudy['qprv'] = { size_mm, Kv, closingTime, runTime: T_unprot + closingTime,
                                       ...(closingTime > maximal && { steppedClosure: true as const }) };
        const r = dispatchSimulation(scenario, { ...base, qprv: q });
        const t = { size_mm, closingTime, Kv, ...judgeQprv(r) };
        tried.push(t);
        return { q, r, t };
    };
    const atSize = (i: number) => trial(SIZES[i], qprvFirstClosingTime(SIZES[i], Tc));
    const passes = (x: Run) => x.t.fallsIn <= QPRV_FALL_S;

    // §3 size: the first size fails the 5 s check → next larger until one passes. It passes → next
    // smaller while that passes and its minimum after the opening is higher.
    let i = SIZES.indexOf(first.size_mm), best = atSize(i);
    if (!best.t.opened) {
        // Builder decision (LOOK-AT Q29): the head never reaches the set pressure; no size changes that.
        notes.push('QPRV does not open: the head stays below the set pressure');
    } else if (!passes(best)) {
        while (i < SIZES.length - 1 && !passes(best)) best = atSize(++i);
        if (!passes(best)) notes.push(`QPRV size: the head does not fall below the set pressure within ${QPRV_FALL_S} s of the opening with any size; ${best.t.size_mm} mm used`);
    } else {
        for (; i > 0; i--) {
            const s = atSize(i - 1);
            if (!(passes(s) && s.t.minHead > best.t.minHead)) break;
            best = s;
        }
    }

    // §3 closing time: back at the set pressure during closing → lengthen by 10 % of t0 until it is
    // not, then another 20 %. Reaching the size's maximal adds the note and lengthening goes on.
    let chosen = best;
    if (passes(best) && best.t.reRises) {
        const size = best.t.size_mm, t0 = best.t.closingTime, maximal = SURGE_VALVE_TABLE[size][1];
        let k = 0, cur = best, stepped = false;
        while (cur.t.reRises && k < QPRV_MAX_STEPS) {
            const c = t0 * (1 + 0.1 * ++k);
            stepped ||= c >= maximal;
            cur = trial(size, c);
        }
        if (cur.t.reRises) {
            chosen = cur;
            notes.push(`QPRV closing time: at ${cur.t.closingTime.toFixed(1)} s the head still comes back to the set pressure during closing; not resolved`);
        } else {
            chosen = trial(size, t0 * (1 + 0.1 * k + 0.2));
            stepped ||= chosen.t.closingTime >= maximal;
        }
        if (stepped) notes.unshift(QPRV_NOTE_STEPPED);
    }
    return { stage1, stage2: chosen.r, qprv: chosen.q, firstSize_mm: first.size_mm, runTime: chosen.q.runTime, notes,
             maxHead: peakAll(chosen.r), tried };
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
        if (cur.refall) {
            chosen = cur;
            notes.push(`SAV closing time: at the ${size} mm maximal closing time (${chosen.t.closingTime} s) the ` +
                       `pressure still falls below the low set (${lowSet.toFixed(2)} m) after the closing; not resolved`);
        } else chosen = trial(size, inRange(size, savClosingTime(t0, k, true)), hold);
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
    if (hold !== undefined) notes.unshift(SAV_NOTE_EAS);
    return { stage1, stage2, sav, lowSet, highSet, firstSize_mm, runTime: sav.runTime, notes, maxHead: peakAll(stage2), tried };
}
