// ── gate_view.ts — the gate screen's display projection (Row 3.11 Unit C, D-1) ──────────────────
//
// WHAT THIS IS. The gate screen renders two things: Unit B's `GateReport` (verdicts, which it takes
// verbatim) and the steady state itself (the profile chart, the tooltip, the summary panel). This
// file is the second half — it turns a `SteadyStateResult` into per-node and per-reach display rows.
//
// IT COMPUTES NO PHYSICS. Every value below is either read verbatim off the solver's own steady
// state or is a DEFINITION applied to it (pressure is head minus elevation; velocity is flow over
// area; margin is head minus the vapour floor). There is no threshold here, no correlation, no
// friction term, and no vapour constant of its own — `VAPOR_HEAD_AT` is imported, exactly as
// `gate_checks.ts` imports it, so the program has one vapour floor and not two. That single import
// is what closed the hand-copied -9.8 at S67 and it must not be re-opened here.
//
// WHERE THE VALUES ACTUALLY LIVE. `SteadyStateResult`'s own doc block (solver.ts SECTION 10a'')
// enumerates this and it is followed literally:
//
//     distance   walked from layout.pipeParams[].dx and .N
//     elevation  layout.Z
//     head       init.prevState.H
//     pressure   H - Z
//     flow       reassembleQout(init.prevFlow, totalNodes)   <- NOT a node field
//     velocity   Q / pipeParams[i].A
//     margin     H - VAPOR_HEAD_AT(Z)
//
// `SystemState` carries H, V_g, C_gas and Z and NO Q — flow moved off the node into per-pipe-end
// `FlowState` at Phase 2.5.2. A parallel per-node flow array is exactly the second representation
// that doc block forbids, so none is built: `reassembleQout` is the solver's own output adapter and
// is used unmodified.
//
// FLOW AND VELOCITY ARE PER REACH, NOT PER NODE. At a junction between two diameters there is no
// single velocity — Q/A differs on the two sides, which is why `gate_checks.ts` evaluates A1/A2 per
// pipe segment and why SPEC_S63.md §4.3 says the widest reach binds. Returning a per-node velocity
// would invent a value at exactly the case the spec calls load-bearing. So the view returns nodes
// and reaches as two aligned lists and lets the caller say which it is showing.
//
// `layout.miab` IS NEVER READ. RESULTS_S67.md §8a: with a collector supplied, `meshNetwork`
// continues past a reported Reynolds finding, so the MIAB coefficients can be frozen at an
// out-of-contract Re — evidence of a fault, not a usable mesh. Nothing here touches them, and
// `gate_view_S68.ts` proves it at runtime rather than by inspection.
//
// Run nothing here directly — this is a library. Its harness is `gate_view_S68.ts`.

import {
    SteadyStateResult, VAPOR_HEAD_AT, reassembleQout,
} from './solver';

// ════════════════════════════════════════════════════════════════════════════════════════════════
// The row shapes
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** One meshed node. Everything here is a node quantity; nothing here is per-reach. */
export interface NodeRow {
    /** Global node index, as the solver indexes it. */
    node:      number;
    /** Distance along the route from node 0 [m]. */
    distance:  number;
    /** Pipe elevation [m]. */
    elevation: number;
    /** Total head, datum-referenced — the value the solver works in [m]. */
    head:      number;
    /** Gauge pressure at the node [m of water] = head - elevation. */
    pressure:  number;
    /** Head above the vapour floor for this elevation [m]. Negative below it. */
    margin:    number;
}

/** One meshed pipe. Flow and velocity are reach quantities and appear only here. */
export interface ReachRow {
    /** Index into `layout.pipeParams`, and into `net.pipes`. */
    index:      number;
    /** The pipe's own id, as the user named it. */
    pipeId:     string;
    firstNode:  number;
    lastNode:   number;
    /** Distance at `firstNode` / `lastNode` [m]. */
    startDistance: number;
    endDistance:   number;
    diameter:   number;
    /** Steady flow through this reach [m3/s]. */
    flow:       number;
    /** flow / area [m/s]. */
    velocity:   number;
}

export interface ProfileView {
    nodes:   NodeRow[];
    reaches: ReachRow[];
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// buildProfileView
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Project a steady state into display rows. Pure: reads its argument, allocates fresh output,
 * writes nothing and calls nothing that does.
 */
export function buildProfileView(steady: SteadyStateResult): ProfileView {
    const { layout, net, init } = steady;
    const H = init.prevState.H;
    const Z = layout.Z;
    const Qout = reassembleQout(init.prevFlow, layout.totalNodes);

    // ── Distance ────────────────────────────────────────────────────────────────────────────────
    // Walked off the MESHED element length `dx`, which is where the solver's nodes actually are.
    //
    // CORRECTED after the S68 action audit — the first draft justified this by claiming dx*N is the
    // meshed route and the input length is not. That is FALSE for the total: `meshNetwork` sets
    // `dx = sec.length / N` (solver.ts:1577), so dx*N IS the input length, exactly. Nothing is
    // rounded away from the route's total.
    //
    // What rounding DOES move is the spacing, and therefore every INTERIOR node's position. `N` is
    // `round(length / (waveSpeed * baseDt))`, so `dx` and `waveSpeed * baseDt` diverge whenever that
    // rounds — which is also why DC-2 forces `a_adj = dx / baseDt` rather than keeping the entered
    // celerity. Placing node o at `o * waveSpeed * baseDt` would therefore put the chart's x-axis
    // and the solver's own nodes on two different rulers everywhere except the endpoints. That is
    // the real hazard here, and `gate_view_S68.ts` C4 tests it against exactly that wrong walk.
    const distance = new Float64Array(layout.totalNodes);
    for (let p = 0; p < layout.pipeParams.length; p++) {
        const pp  = layout.pipeParams[p];
        const ids = layout.nodeIds[p];
        const base = distance[ids[0]];
        for (let o = 1; o <= pp.N; o++) distance[ids[o]] = base + o * pp.dx;
    }

    const nodes: NodeRow[] = [];
    for (let i = 0; i < layout.totalNodes; i++) {
        nodes.push({
            node:      i,
            distance:  distance[i],
            elevation: Z[i],
            head:      H[i],
            pressure:  H[i] - Z[i],
            margin:    H[i] - VAPOR_HEAD_AT(Z[i]),
        });
    }

    // ── Reaches ─────────────────────────────────────────────────────────────────────────────────
    // Flow is taken at the reach's OWN first node. `qoutSlot` maps a node to its LEFT/segment-start
    // end, so at a junction shared by reach p-1's to-end and reach p's from-end, `nodeQout` of that
    // node is reach p's own start flow — which is the one this row is about. The terminal node has
    // no outgoing segment and is never used as a `firstNode`.
    const pipeIds = net.pipes.map(p => p.id);
    const reaches: ReachRow[] = layout.pipeParams.map((pp, p) => {
        const ids   = layout.nodeIds[p];
        const first = ids[0];
        const last  = ids[pp.N];
        const flow  = Qout[first];
        return {
            index:         p,
            pipeId:        pipeIds[p] ?? String(p),
            firstNode:     first,
            lastNode:      last,
            startDistance: distance[first],
            endDistance:   distance[last],
            diameter:      pp.D,
            flow,
            velocity:      flow / pp.A,
        };
    });

    return { nodes, reaches };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// The summary panel's numbers — SPEC_S63.md §3.3
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// §3.3 asks for: steady flow rate; velocity; head and pressure at the inlet, at the outlet, and at
// the worst point; which point is the worst; total friction loss; and the scenario being prepared.
// The scenario is the caller's — it is a selection, not a computed quantity — so it is not here.

export interface ProfileSummary {
    inlet:  NodeRow;
    outlet: NodeRow;
    /** The node with the SMALLEST margin above vapour — the point closest to (or furthest below) it. */
    worst:  NodeRow;
    /** Flow at the inlet reach [m3/s]. On a series main this is the flow everywhere. */
    flow:   number;
    /** Fastest and slowest reach. They differ whenever the main steps diameter. */
    velocityMax: { value: number; reach: ReachRow };
    velocityMin: { value: number; reach: ReachRow };
    /**
     * Head lost along the pipeline [m] = head at the inlet minus head at the outlet.
     *
     * On every scenario this program runs, the terminal node is the downstream boundary itself — a
     * reservoir on a pump trip, the valve's own upstream face on both valve scenarios — so this
     * figure is the PIPELINE's loss and does not include a valve's own loss. Named "along the
     * pipeline" rather than "friction" for that reason.
     */
    headLossAlongPipeline: number;
}

/**
 * PRECONDITION: `view` came from `buildProfileView` on a real steady state, so it has at least one
 * node and one reach. No guard is written for the empty case because none is reachable — B8 refuses
 * an empty pipe list in the input phase and the state phase never runs, so no `SteadyStateResult`
 * with zero reaches exists to project. Stated rather than coded: a runtime check for a state the
 * gate makes impossible would be speculative, and this is the contract a future caller must meet.
 */
export function summariseProfile(view: ProfileView): ProfileSummary {
    const inlet  = view.nodes[0];
    const outlet = view.nodes[view.nodes.length - 1];

    // `<` not `<=`, so the FIRST node at the minimum wins and the answer is stable under a tie —
    // a flat sub-vapour reach must not report a different "worst point" between two runs.
    let worst = view.nodes[0];
    for (const n of view.nodes) if (n.margin < worst.margin) worst = n;

    let fastest = view.reaches[0];
    let slowest = view.reaches[0];
    for (const r of view.reaches) {
        if (r.velocity > fastest.velocity) fastest = r;
        if (r.velocity < slowest.velocity) slowest = r;
    }

    return {
        inlet, outlet, worst,
        flow: view.reaches[0].flow,
        velocityMax: { value: fastest.velocity, reach: fastest },
        velocityMin: { value: slowest.velocity, reach: slowest },
        headLossAlongPipeline: inlet.head - outlet.head,
    };
}
