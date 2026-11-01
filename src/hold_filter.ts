// ── hold_filter.ts — Q31: ignore pressures and air pockets that last less than 0.2 s ─────────────────
// ANSWERS 2026-10-31: events shorter than HOLD_S are filtered out, in the −8 m "add an air valve"
// decision (air_valves.ts ruling (4)) and in the graphs (max/min lines, air-pocket volumes). Applied
// after the run; the solver's run and its time history stay untouched. When one time step is
// HOLD_S or longer, the filter does nothing.

import { SimulationResults } from './solver';

export const HOLD_S = 0.2;   // [s] shortest event that counts (ANSWERS 2026-10-31)

/** Samples that span HOLD_S at the run's time step (1 = one step is >= HOLD_S: no filtering). */
function holdSamples(r: SimulationResults): number {
    const H = r.fullHistory;
    if (H.length < 2) return 1;
    const dt = (H[H.length - 1].time - H[0].time) / (H.length - 1);
    return Math.min(H.length, Math.max(1, Math.ceil(HOLD_S / dt - 1e-9)));
}

/** Lowest value held for n consecutive samples (the least, over every n-sample window, of that
 *  window's largest); s = −1 gives the highest value held. Monotonic deque, one pass. */
function held(xs: number[], n: number, s: 1 | -1): number {
    const q: number[] = [];
    let head = 0, best = Infinity;
    for (let k = 0; k < xs.length; k++) {
        const y = s * xs[k];
        while (q.length > head && s * xs[q[q.length - 1]] <= y) q.pop();
        q.push(k);
        if (q[head] <= k - n) head++;
        if (k >= n - 1) best = Math.min(best, s * xs[q[head]]);
    }
    return s * best;
}

/** A copy of r whose nodes' minHead / maxHead are the lowest / highest head held for at least HOLD_S
 *  and maxVaporVolume the largest vapour/air volume present for at least HOLD_S. r is not changed. */
export function holdFilter<R extends SimulationResults>(r: R): R {
    const n = holdSamples(r), H = r.fullHistory;
    if (n <= 1) return { ...r, nodes: r.nodes.map(nd => ({ ...nd })) };
    return {
        ...r,
        nodes: r.nodes.map((nd, i) => {
            const h = H.map(f => f.heads[i]);
            return { ...nd, minHead: held(h, n, 1), maxHead: held(h, n, -1),
                     maxVaporVolume: H[0].vapors ? held(H.map(f => f.vapors![i]), n, -1) : nd.maxVaporVolume };
        }),
    };
}

/** Q31 graph: a node's vapour/air volume over time with the pockets that last less than HOLD_S set to 0
 *  (a pocket = an unbroken run of samples with volume > 0). */
export function heldPockets(r: SimulationResults, vols: number[]): number[] {
    const n = holdSamples(r), out = vols.slice();
    for (let k = 0; k < vols.length;) {
        if (!(vols[k] > 0)) { k++; continue; }
        let e = k;
        while (e < vols.length && vols[e] > 0) e++;
        if (e - k < n) out.fill(0, k, e);
        k = e;
    }
    return out;
}
