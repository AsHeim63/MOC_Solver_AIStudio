// ── air_valves.ts — Q14: air valve study (solver stage 2) ───────────────────────────────────────
//
// Stage 1 = today's transient run, unprotected. Then: an air valve at every high point whose
// stage-1 minimum pressure is below −1 m (gauge), and at a line end (inlet of the first pipe, or
// the downstream valve inlet) below −1 m (ruling 3, 2026-10-16); each inlet sized to the smallest
// orifice from the set that keeps the line at or above −1 m (ruling 1). Every valve is computed
// with a 12 mm outlet; it is shown as Non-Slam only when its air pocket grows beyond π·D², else as
// a regular air valve (ruling 2). The final protected run is stage 2. Both runs are kept.
// The air-valve boundary itself is the solver's CALC_AIR_VALVE_N (solver.ts SECTION 7g).

import { SimulationResults, PipeSection, AirValveBC } from './solver';
import { dispatchSimulation, DispatchInputs, Scenario } from './scenario_dispatch';

export const AIR_VALVE_SIZES_MM: readonly number[] = [25, 50, 75, 100, 150, 200, 250, 300, 350, 400, 500];
export const NON_SLAM_OUTLET_MM = 12;
export const MIN_GAUGE_HEAD_M   = -1;   // lowest allowed pressure with an air valve [m, gauge]

/** A sized air valve: the solver's AirValveBC (x, inlet_mm, outlet_mm = 12, ruling 2) plus its shown type. */
export interface AirValve extends AirValveBC {
    nonSlam:   boolean;   // shown type: true ⟺ stage-2 air pocket > π·D² (ruling 2)
}

export interface AirValveStudy {
    stage1:     SimulationResults;   // unprotected run
    stage2:     SimulationResults;   // final protected run
    valves:     AirValve[];
    unresolved: number[];            // x [m] of points still below −1 m in stage 2
}

interface Placed { node: number; k: number; nonSlam: boolean }

/** Minimum gauge pressure at node i [m]. */
const minGauge = (r: SimulationResults, i: number): number => r.nodes[i].minHead - r.nodes[i].elevation;

/** Nodes whose minimum gauge pressure is below −1 m. */
function lowNodes(r: SimulationResults): number[] {
    const out: number[] = [];
    r.nodes.forEach((_, i) => { if (minGauge(r, i) < MIN_GAUGE_HEAD_M) out.push(i); });
    return out;
}

/** Valve site = interior high point (higher than the node before it and not lower than the node
 *  after it: the first node of a flat top), or a line end (ruling 3). */
function isSite(r: SimulationResults, i: number): boolean {
    const z = (j: number) => r.nodes[j].elevation;
    return i === 0 || i === r.nodes.length - 1 || (z(i) > z(i - 1) && z(i) >= z(i + 1));
}

/** Smallest pipe inner diameter at a node (both pipes at a junction). */
function diameterAt(pipes: PipeSection[], x: number, half: number): number {
    let s = 0, D = Infinity;
    for (const p of pipes) {
        if (x >= s - half && x <= s + p.length + half) D = Math.min(D, p.diameter);
        s += p.length;
    }
    return Number.isFinite(D) ? D : pipes[pipes.length - 1].diameter;
}

export function sizeAirValves(scenario: Scenario, inputs: DispatchInputs): AirValveStudy {
    const base: DispatchInputs = { ...inputs, airValves: undefined };
    const stage1 = dispatchSimulation(scenario, base);
    const low1 = lowNodes(stage1);
    const last = AIR_VALVE_SIZES_MM.length - 1;
    const xOf = (i: number) => stage1.nodes[i].x;
    const toValves = (vs: Placed[]): AirValve[] => vs.map(v => {
        const d = AIR_VALVE_SIZES_MM[v.k];
        return { x: xOf(v.node), inlet_mm: d, outlet_mm: NON_SLAM_OUTLET_MM, nonSlam: v.nonSlam };
    });
    const run = (vs: Placed[]) => dispatchSimulation(scenario, { ...base, airValves: toValves(vs) });

    const placed: Placed[] = low1.filter(i => isSite(stage1, i)).map(node => ({ node, k: 0, nonSlam: false }));
    if (!placed.length) return { stage1, stage2: run([]), valves: [], unresolved: low1.map(xOf) };

    // A low node belongs to the nearest valve in its stage-1 low stretch (a contiguous run of low
    // nodes); low nodes with no valve in their stretch are reported, never "fixed" by a far valve.
    const lowSet = new Set(low1);
    const stretch = new Map<number, number>();            // node -> stretch id
    let sid = -1;
    for (let i = 0; i < stage1.nodes.length; i++) if (lowSet.has(i)) {
        if (!lowSet.has(i - 1)) sid++;
        stretch.set(i, sid);
    }
    const owner = (i: number): number => {
        const s = stretch.get(i);
        if (s === undefined) return -1;
        let best = -1;
        placed.forEach((v, j) => {
            if (s === stretch.get(v.node) &&
                (best < 0 || Math.abs(v.node - i) < Math.abs(placed[best].node - i))) best = j;
        });
        return best;
    };

    // Grow: raise the size of every valve that owns a low node, one step at a time, until no owned
    // node is low or the owners are all at the largest size. Then shrink: each valve one step down
    // while that adds no low node (smallest size per valve). Order: all valves together (interaction).
    const fit = (): SimulationResults => {
        let r = run(placed);
        for (;;) {
            const grow = new Set<number>();
            for (const i of lowNodes(r)) { const j = owner(i); if (j >= 0 && placed[j].k < last) grow.add(j); }
            if (!grow.size) break;
            for (const j of grow) placed[j].k++;
            r = run(placed);
        }
        for (let changed = true; changed;) {
            changed = false;
            for (const v of placed) {
                if (v.k === 0) continue;
                const was = new Set(lowNodes(r));
                v.k--;
                const r2 = run(placed);
                if (lowNodes(r2).every(i => was.has(i))) { r = r2; changed = true; } else v.k++;
            }
        }
        return r;
    };

    // A valve acts at one grid node. A grid neighbour of a site (same stage-1 low stretch) that the
    // site's valve cannot keep at −1 m even at the largest size (the 2·dx oscillation next to the
    // pocket) gets its own valve at the worst such node, and all are sized again. Other points
    // still below −1 m are reported (row (4)).
    const sites = placed.map(v => v.node);
    let stage2 = fit();
    for (;;) {
        const left = lowNodes(stage2).filter(i => owner(i) >= 0 && !placed.some(v => v.node === i) &&
                                                  sites.some(n => Math.abs(n - i) === 1));
        if (!left.length) break;
        const p = (i: number) => minGauge(stage2, i);
        placed.push({ node: left.reduce((a, b) => (p(b) < p(a) ? b : a)), k: 0, nonSlam: false });
        stage2 = fit();
    }
    const half = stage1.nodes.length > 1 ? (stage1.nodes[1].x - stage1.nodes[0].x) / 2 : 0;
    for (const v of placed) {
        const D = diameterAt(inputs.pipes, xOf(v.node), half);
        v.nonSlam = stage2.nodes[v.node].maxVaporVolume > Math.PI * D * D;
    }
    return { stage1, stage2, valves: toValves(placed), unresolved: lowNodes(stage2).map(i => stage2.nodes[i].x) };
}
