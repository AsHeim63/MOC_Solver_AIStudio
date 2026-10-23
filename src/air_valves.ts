// ── air_valves.ts — Q14: air valve study (solver stage 2) ───────────────────────────────────────
//
// Stage 1 = today's transient run, unprotected. Then valves at the sites of the Q16 placement ruling
// (ANSWERS 2026-10-21: (a) after the pump check valve, (b) slope-break peaks, (c) before the line-end
// valve) where stage 1 is below −1 m (gauge). Each inlet is the smallest orifice from the set that
// keeps ITS OWN node at or above −1 m (Q16 final ruling 2026-10-22 (2)). Line pressures below −2 m
// are ignored unless a node reaches −8 m or lower; then a valve is added at the lowest such point at
// least 150 m from every valve, all are sized again, and this repeats (ruling (4)). Every valve is computed
// with a 12 mm outlet; it is shown as Non-Slam only when its air pocket grows beyond π·D², else as
// a regular air valve (ruling 2). The final protected run is stage 2. Both runs are kept.
// The air-valve boundary itself is the solver's CALC_AIR_VALVE_N (solver.ts SECTION 7g).

import { SimulationResults, PipeSection, AirValveBC } from './solver';
import { dispatchSimulation, DispatchInputs, Scenario } from './scenario_dispatch';

export const AIR_VALVE_SIZES_MM: readonly number[] = [25, 50, 75, 100, 150, 200, 250, 300, 350, 400, 500];
export const NON_SLAM_OUTLET_MM = 12;
export const MIN_GAUGE_HEAD_M   = -1;   // lowest allowed pressure with an air valve [m, gauge]

/** A sized air valve: the solver's AirValveBC (x, inlet_mm, outlet_mm = the COMPUTED outlet, 12 mm,
 *  ruling 2) plus its shown type. A BOM reads outlet_mm for the computed size, shownOutletMm for the
 *  screen. */
export interface AirValve extends AirValveBC {
    nonSlam:   boolean;   // shown type: true ⟺ stage-2 air pocket > π·D² (ruling 2)
}

/** Outlet shown on the screen: a regular valve is shown as inlet / inlet, though computed with the
 *  12 mm outlet (Assaf ruling 2026-10-16 (2)); a Non-Slam valve shows its computed outlet. */
export const shownOutletMm = (v: AirValve): number => (v.nonSlam ? v.outlet_mm : v.inlet_mm);

export interface AirValveStudy {
    stage1:     SimulationResults;   // unprotected run
    stage2:     SimulationResults;   // final protected run
    valves:     AirValve[];
    unresolved: number[];            // x [m] of points still missing the Q16 target in stage 2
}

interface Placed { x: number; node: number; k: number; nonSlam: boolean }

export const ADD_VALVE_HEAD_M = -8;    // Q16 ruling (4): a line node at or below this gets a valve [m, gauge]
export const VALVE_SPACING_M  = 150;   // Q16 placement: least distance between valves [m]

/** Positions are given to one decimal (Q16 placement). */
const round1 = (x: number): number => Math.round(x * 10) / 10;

/** Minimum gauge pressure at node i [m]. */
const minGauge = (r: SimulationResults, i: number): number => r.nodes[i].minHead - r.nodes[i].elevation;

/** A valve node misses −1 m. */
const valveLow = (r: SimulationResults, i: number): boolean => minGauge(r, i) < MIN_GAUGE_HEAD_M;

/** Valves whose own node is below −1 m. */
const valveMisses = (r: SimulationResults, vs: Placed[]): Placed[] => vs.filter(v => valveLow(r, v.node));

/** Nodes missing the Q16 target: a valve node below −1 m, any other node at −8 m or lower. */
const misses = (r: SimulationResults, valveNodes: ReadonlySet<number>): number[] =>
    r.nodes.map((_, i) => i).filter(i => (valveNodes.has(i) ? valveLow(r, i) : minGauge(r, i) <= ADD_VALVE_HEAD_M));

/** Largest whole air pocket of the valve at node n [m³], as the solver holds it (one gas body at
 *  the valve node, ruling 2026-10-18): only this valve's air, never a neighbouring valve's spill. */
const pocketMax = (r: SimulationResults, n: number): number => r.airPocketMax?.[n] ?? 0;

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
    const last = AIR_VALVE_SIZES_MM.length - 1;
    const xOf = (i: number) => stage1.nodes[i].x;
    const nodeAt = (x: number) => stage1.nodes.reduce((b, n, i) => (Math.abs(n.x - x) < Math.abs(xOf(b) - x) ? i : b), 0);
    const toValves = (vs: Placed[]): AirValve[] => vs.map(v => ({
        x: v.x, inlet_mm: AIR_VALVE_SIZES_MM[v.k], outlet_mm: NON_SLAM_OUTLET_MM, nonSlam: v.nonSlam }));
    const run = (vs: Placed[]) => dispatchSimulation(scenario, { ...base, airValves: toValves(vs) });
    const placed: Placed[] = [];
    const place = (x: number) => {                       // one valve per mesh node; x to one decimal
        const node = nodeAt(x);
        if (!placed.some(v => v.node === node)) placed.push({ x: round1(x), node, k: 0, nonSlam: false });
    };

    // Sites in the ruled order (ANSWERS 2026-10-21 "Q16 placement"): (a) right after the pump check
    // valve (node 0); (b) slope-break peaks of the pipe table (slope before > slope after), highest
    // first, each more than VALVE_SPACING_M from the sites before it — the sites, not only the valves
    // placed: "if two candidates are closer than 150 m, always the higher one"; (c) right before the
    // line-end valve, unless a site is closer than VALVE_SPACING_M (the app has no mid-line valve, so
    // (c)'s "both sides of a mid-line valve" has no case). A site gets a valve only where stage 1 is
    // below −1 m there (Q14 Do (3)).
    const pts = [{ x: 0, z: stage1.nodes[0].elevation }];
    for (const p of inputs.pipes) pts.push({ x: pts[pts.length - 1].x + p.length, z: p.endElevation });
    const L = pts[pts.length - 1].x;
    const slope = (a: { x: number; z: number }, b: { x: number; z: number }) => (b.z - a.z) / (b.x - a.x);
    const peaks = pts.filter((p, j) => j > 0 && j < pts.length - 1 && slope(pts[j - 1], p) > slope(p, pts[j + 1]));
    const sites: number[] = [];
    if (scenario !== 'gravity-valve') sites.push(0);
    for (const p of peaks.sort((a, b) => b.z - a.z)) {
        if (sites.every(s => Math.abs(s - p.x) > VALVE_SPACING_M)) sites.push(p.x);
    }
    if (scenario !== 'pump-trip' && sites.every(s => Math.abs(s - L) >= VALVE_SPACING_M)) sites.push(L);
    for (const x of sites) if (minGauge(stage1, nodeAt(x)) < MIN_GAUGE_HEAD_M) place(x);

    // Size (ruling (2)): grow every valve whose own node is below −1 m one step, all together, until
    // none is (or those are at the largest size). Then each valve that meets −1 m takes the smallest
    // size, tried from 25 mm up, at which no valve node that met −1 m drops below it (the others held);
    // repeated until no valve changes. Smallest per valve; the joint set is not searched (11^n runs).
    const fit = (): SimulationResults => {
        let r = run(placed);
        for (;;) {
            const grow = valveMisses(r, placed).filter(v => v.k < last);
            if (!grow.length) break;
            for (const v of grow) v.k++;
            r = run(placed);
        }
        for (let changed = true; changed;) {
            changed = false;
            for (const v of placed) {
                const was = valveMisses(r, placed);
                if (v.k === 0 || was.includes(v)) continue;
                const k0 = v.k;
                for (v.k = 0; v.k < k0; v.k++) {
                    const r2 = run(placed);
                    if (valveMisses(r2, placed).every(w => was.includes(w))) { r = r2; changed = true; break; }
                }
            }
        }
        return r;
    };

    // Ruling (4): while a node at least VALVE_SPACING_M from every valve is at −8 m or lower, add a
    // valve at the lowest such node and size all again. Points with no free place are reported.
    let stage2 = fit();
    for (;;) {
        const free = stage2.nodes.map((_, i) => i).filter(i => placed.every(v => Math.abs(xOf(i) - v.x) >= VALVE_SPACING_M));
        const deep = free.filter(i => minGauge(stage2, i) <= ADD_VALVE_HEAD_M);
        if (!deep.length) break;
        place(xOf(deep.reduce((a, b) => (minGauge(stage2, b) < minGauge(stage2, a) ? b : a))));
        stage2 = fit();
    }
    const half = stage1.nodes.length > 1 ? (stage1.nodes[1].x - stage1.nodes[0].x) / 2 : 0;
    for (const v of placed) {
        const D = diameterAt(inputs.pipes, v.x, half);
        v.nonSlam = pocketMax(stage2, v.node) > Math.PI * D * D;
    }
    return { stage1, stage2, valves: toValves(placed), unresolved: misses(stage2, new Set(placed.map(v => v.node))).map(xOf) };
}
