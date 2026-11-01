// ── hold_filter.ts — Q31: ignore pressures and air pockets that last less than 0.2 s ─────────────────
// ANSWERS 2026-10-31: events shorter than HOLD_S are filtered out, in the −8 m "add an air valve"
// decision (air_valves.ts ruling (4)) and in the graphs (max/min lines, air-pocket volumes). Applied
// after the run; the solver's run and its time history stay untouched. When one time step is
// HOLD_S or longer, the filter does nothing.

import { SimulationResults } from './solver';

export const HOLD_S = 0.2;   // [s] shortest event that counts (ANSWERS 2026-10-31)
/** [s] float slack on frame times (t = step·dt in the solver), so a span of exactly HOLD_S counts. */
const TIME_TOL_S = 1e-9;
/** [m³] the solver's liquid-state gas seed: V_g is reset to it whenever a node is liquid
 *  (solver.ts 803/1324/1341). */
const V_SEED_M3 = 1e-12;

/** "Held for at least HOLD_S" = the span from first to last sample >= HOLD_S (as in the Q30 harness).
 *  Returns, per start sample k, the first sample j with t_j − t_k >= HOLD_S (j = length: no window
 *  starts at k), or null when the filter does nothing:
 *  - one time step >= HOLD_S (row: the filter does nothing);
 *  - the whole run spans less than HOLD_S: nothing can be held that long, so the raw values are kept
 *    (the conservative side for the −8 m decision).
 *  Times are read sample by sample, so uneven spacing is handled; the solver writes one frame per
 *  step anyway (t = step·baseDt, solver.ts fullHistory.push). */
function holdEnds(r: SimulationResults): number[] | null {
    const t = r.fullHistory.map(f => f.time), N = t.length;
    if (N < 2 || t[N - 1] - t[0] < HOLD_S - TIME_TOL_S) return null;
    for (let k = 1; k < N; k++) if (t[k] - t[k - 1] >= HOLD_S - TIME_TOL_S) return null;
    const end: number[] = [];
    for (let k = 0, j = 0; k < N; k++) {
        while (j < N && t[j] - t[k] < HOLD_S - TIME_TOL_S) j++;
        end.push(j);
    }
    return end;
}

/** Lowest value held for at least HOLD_S (the least, over every window [k, end[k]], of that window's
 *  largest; longer windows can only be larger); s = −1 gives the highest value held. Monotonic deque. */
function held(xs: number[], end: number[], s: 1 | -1): number {
    const q: number[] = [];
    let head = 0, j = 0, best = Infinity;
    for (let k = 0; k < xs.length && end[k] < xs.length; k++) {
        for (; j <= end[k]; j++) {
            while (q.length > head && s * xs[q[q.length - 1]] <= s * xs[j]) q.pop();
            q.push(j);
        }
        while (q[head] < k) head++;
        best = Math.min(best, s * xs[q[head]]);
    }
    return s * best;
}

/** Volumes with every sample outside a pocket lasting at least HOLD_S set to 0. A pocket = an unbroken
 *  run of samples above the node's gas floor: the larger of its t = 0 volume (the solver's free-gas
 *  seed ALPHA_G0·dx·A, solver.ts 1615/1625) and V_SEED_M3. At or below the floor is residual gas. */
function pockets(vols: number[], end: number[]): number[] {
    const floor = Math.max(vols[0] ?? 0, V_SEED_M3), out = new Array<number>(vols.length).fill(0);
    for (let k = 0; k < vols.length;) {
        if (!(vols[k] > floor)) { k++; continue; }
        let e = k;
        while (e < vols.length && vols[e] > floor) e++;
        if (end[k] < e) for (let j = k; j < e; j++) out[j] = vols[j];   // t[e−1] − t[k] >= HOLD_S
        k = e;
    }
    return out;
}

/** A copy of r whose nodes' minHead / maxHead are the lowest / highest head held for at least HOLD_S
 *  and maxVaporVolume the peak of the node's pockets that last at least HOLD_S (the same reading as the
 *  vapour chart, heldPockets). r is not changed. */
export function holdFilter<R extends SimulationResults>(r: R): R {
    const end = holdEnds(r), H = r.fullHistory;
    if (!end) return { ...r, nodes: r.nodes.map(nd => ({ ...nd })) };
    const withVapors = H.every(f => f.vapors);
    return {
        ...r,
        nodes: r.nodes.map((nd, i) => {
            const h = H.map(f => f.heads[i]);
            return { ...nd, minHead: held(h, end, 1), maxHead: held(h, end, -1),
                     maxVaporVolume: withVapors
                         ? pockets(H.map(f => f.vapors![i]), end).reduce((a, v) => Math.max(a, v), 0)
                         : nd.maxVaporVolume };
        }),
    };
}

/** Q31 graph: a node's vapour/air volume over time, only pockets that last at least HOLD_S shown
 *  (pockets() above); unchanged when the filter does nothing. */
export function heldPockets(r: SimulationResults, vols: number[]): number[] {
    const end = holdEnds(r);
    return end ? pockets(vols, end) : vols.slice();
}
