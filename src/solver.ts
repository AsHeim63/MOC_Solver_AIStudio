// solver.ts — Water Hammer MOC-DGCM with Vardy-Brown MIAB Unsteady Friction
// Version 15.5 (clean modular rewrite)
//
// MODULE LAYOUT
// ─────────────
//   Section 1  Physical constants
//   Section 2  MIAB configuration
//   Section 3  Type & class definitions
//   Section 4  COMPUTE_MIAB_PIPE_PARAMS   — Vardy-Brown k_u and decay rates
//   Section 5  DGCM gas helpers           — quadratic solver | gas clamp | vapor floor
//   Section 6  COMPUTE_CHARACTERISTICS   — MOC C+/C- coefs with MIAB friction
//   Section 7  Node calculators          — pump BC | interior | junction | reservoir BC
//   Section 8  UPDATE_MIAB_STATE         — advance MIAB filter state one timestep
//   Section 9  INIT_STEADY_STATE         — hydraulic initial conditions
//   Section 10 runWaterHammerSimulation  — main timestep loop
//
// INTER-BOX DATA FLOW (per timestep)
// ───────────────────────────────────
//   prevState (H, Q, V_g) ──┬──► COMPUTE_CHARACTERISTICS ──► CharCoefs
//   miabState (z, Q_prev)  ─┘                                      │
//                                                                   ▼
//                                        CALC_BC_PUMP / CALC_INTERIOR /
//                                        CALC_JUNCTION / CALC_BC_RESERVOIR
//                                                                   │
//                                                             newState
//                                                                   │
//   prevState.Q_out ───────────────────► UPDATE_MIAB_STATE ◄────────┘
//                                              │
//                                    miabState updated
//                                    prevState ← newState

// Q10: user pump curve helpers (pure, SI). DOMAIN §15.
import { pumpRunOutFlow, pumpFlowAtHeadRise } from './pump_curve';

// ── Inlined from types.ts ────────────────────────────────────────────────────
export interface PipeSection {
    id:            string;
    length:        number;   // m
    diameter:      number;   // m
    waveSpeed:     number;   // m/s
    frictionFactor: number;  // Darcy-Weisbach f
    endElevation:  number;   // m
}

export interface PumpParams {
    initialHead: number;   // m  (total head at design point)
    initialFlow: number;   // m3/s
    tripTime:    number;   // s  (start of deceleration)
    haltTime:    number;   // s  (fully stopped)
    elevation:   number;   // m  (pump discharge elevation)
    /** Q10: user pump curve (SI: a m/(m³/s)², b m/(m³/s), c m, H_suct m). Pump-fed valve path only
     *  (PREPARE_valve with tripTime = haltTime = Infinity); absent = today's 1.33 curve. DOMAIN §15. */
    curve?:      PumpCurve;
}

/** Q10: H_rise = a·Q² + α·b·Q + α²·c; discharge head = H_suct + H_rise. DOMAIN §15 (i). */
export interface PumpCurve { a: number; b: number; c: number; H_suct: number; }

export interface ReservoirParams {
    head: number;   // m  (water surface elevation)
}

export interface SimulationResults {
    timeSteps:   number[];
    nodes: {
        x:              number;
        elevation:      number;
        maxHead:        number;
        minHead:        number;
        steadyHead:     number;
        maxVaporVolume: number;
    }[];
    timeHistory: {
        time:        number;
        head:        number;
        flow:        number;
        flowNext?:   number;
        vaporVolume: number;
    }[];
    fullHistory: {
        time:    number;
        heads:   number[];
        flows?:  number[];
        vapors?: number[];
        q_in?:   number[];
        // E7′ (S37 — spec §3b.7): per-pipe-end discharge, indexed by pipe. UNHASHED telemetry — never
        // enters capture.ts's physicsHash stream (heads/flows/vapors/q_in). Recovers the individual
        // incident-end flows that the node-indexed flows/q_in collapse at a shared junction (needed for
        // branched continuity T3: qTo[trunk], qFrom[b1], qFrom[b2]). qFrom[p]=qL[p][0], qTo[p]=qR[p][N−1].
        endFlows?: { qFrom: number[]; qTo: number[] };
    }[];
    paths?: { id: string; nodeIndices: number[] }[];
    // Q14: per node, the largest whole air pocket of the air valve at that node [m³] (0 elsewhere);
    // only with air valves. The pocket is one gas body held at the valve node (spill ruling).
    airPocketMax?: number[];
    // Q21: only with a QPRV (SECTION 7h). H_open = reference + 7 m [m]; opening = its opening s ∈ [0,1]
    // per fullHistory entry. Unhashed telemetry, read by the sizing stage (surge_valves.ts).
    qprv?: { H_open: number; opening: number[] };
}
// ─────────────────────────────────────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — PHYSICAL CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

export const G = 9.81;   // gravitational acceleration        [m/s²]
const H_BARO      = 10.33;  // barometric pressure head          [m]
const ALPHA_G0    = 1e-7;   // initial gas void fraction         [-]
const VAPOR_H_REL = -9.8;   // vapor pressure, gauge above node  [m]
const NU_WATER    = 1e-6;   // kinematic viscosity at ~20 °C     [m²/s]


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — MIAB CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════
//
// M-exponential recursive approximation of the Vardy-Brown turbulent weighting
// function W*(τ) = C*/(2√πτ) · exp(−B*·τ).
//
// Two components capture separate frequency bands:
//   [0] fast  — primary Vardy-Brown decay:  α₀ = B* · ν/R²
//   [1] slow  — low-frequency supplement:  α₁ = α₀ · SLOW_RATIO
//
// MIAB_WEIGHTS[k] partitions the total unsteady friction between components.
// Constraint: Σ MIAB_WEIGHTS[k] = 1.0
//
// References:
//   Vardy & Brown (1995) J. Sound & Vibration 184(1):1–18
//   Vítkovský et al. (2004) J. Hydraulic Engineering 130(12):1217–1227

const MIAB_M          = 2;
const MIAB_WEIGHTS    = [0.7, 0.3] as const;   // partition weights, must sum to 1.0
const MIAB_SLOW_RATIO = 0.1;                    // slow-component decay relative to fast


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — TYPE & CLASS DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Internal pipe descriptor (derived from PipeSection after meshing).
 * All fields are fixed after initialisation — treated as read-only.
 *
 * startNode: index of the upstream-end (left) node of this pipe.
 * dx:        length of each MOC element within the pipe [m].
 * N:         number of elements; pipe occupies nodes [startNode .. startNode+N].
 */
export interface PipeParams {
    readonly a:         number;  // wave celerity                     [m/s]
    readonly A:         number;  // cross-sectional area              [m²]
    readonly D:         number;  // internal diameter                 [m]
    readonly f:         number;  // Darcy-Weisbach friction factor    [-]
    readonly dx:        number;  // MOC element length                [m]
    readonly N:         number;  // number of MOC elements            [-]
    readonly startNode: number;  // index of left-end node            [-]
}

/**
 * Per-pipe Vardy-Brown MIAB parameters.
 * Computed once at initialisation from steady-state Re.
 *
 * k_u:   Brunone-Vardy coefficient (= C_star/2) — dimensionless.
 * alpha: decay rate for each MIAB component [1/s], length MIAB_M.
 *        alpha[k] = lambda_k * nu / R^2
 */
interface MIABPipeParams {
    readonly k_u:   number;
    readonly alpha: Float64Array;   // length MIAB_M
}

/**
 * Bundled pipe descriptor — hydraulic params + MIAB params for the same pipe.
 * Passed together so functions never receive mismatched pairs.
 */
interface Pipe {
    readonly p:    PipeParams;
    readonly miab: MIABPipeParams;
}

/**
 * MOC compatibility-equation coefficients for one node.
 *
 * Sign convention (flow positive rightward):
 *   C+:  H + B·Q = Cp   (carries information from upstream)
 *   C−:  H − B·Q = Cm   (carries information from downstream)
 *
 * B1 / B2: hydraulic impedance of upstream / downstream pipe [m·s/m³]
 * Null-pipe side has B = 0 and the corresponding constant unused.
 */
export interface CharCoefs {
    Cp: number;   // [m]
    Cm: number;   // [m]
    B1: number;   // [m·s/m³]
    B2: number;   // [m·s/m³]
}

/** Timestep size. */
export interface GridParams {
    readonly dt: number;  // [s]
}

/**
 * Primary hydraulic state — per-node arrays indexed by node [0 .. totalNodes−1].
 *
 * H     : piezometric head (HGL elevation)               [m]
 * V_g   : discrete gas-cavity volume                     [m³]
 * C_gas : isothermal gas-law constant = H_abs·V_g        [m⁴]  — fixed after init
 * Z     : node elevation                                 [m]   — fixed after init
 *
 * Flow (Q_in/Q_out) has moved OFF the node into per-pipe-end storage (FlowState, below —
 * Phase 2.5.2 Option B per-pipe-end flow-storage refactor; spec §3b.1, design §2). Only flow moves;
 * H/V_g/C_gas/Z stay node-indexed. copyFrom() transfers the time-varying per-node fields (H, V_g).
 */
export class SystemState {
    H:     Float64Array;
    V_g:   Float64Array;
    C_gas: Float64Array;
    Z:     Float64Array;

    constructor(n: number) {
        this.H     = new Float64Array(n);
        this.V_g   = new Float64Array(n);
        this.C_gas = new Float64Array(n);
        this.Z     = new Float64Array(n);
    }

    copyFrom(src: SystemState): void {
        this.H.set(src.H);
        this.V_g.set(src.V_g);
        this.C_gas.set(src.C_gas);   // C_gas updated during active cavitation — must propagate
        // Z is the only true constant — never overwritten
    }
}

/**
 * Per-pipe-end flow storage (Phase 2.5.2 Option B — spec §3b.1; design §2/§3). Replaces the
 * node-indexed SystemState.Q_in/Q_out, lifting the "one outflow slot per node" junction limit by
 * storing flow on pipe SEGMENT ENDS rather than on nodes.
 *
 *   qL[p][s]  : LEFT-end  discharge of segment s in pipe p  (= old Q_out at the segment's left  node)
 *   qR[p][s]  : RIGHT-end discharge of segment s in pipe p  (= old Q_in  at the segment's right node)
 *   qPumpFace : pump-intake / check-valve face discharge     (= old Q_in[0]; not a segment end)
 *
 * Pipe p (sp = startNode[p], N_p segments) owns nodes sp .. sp+N_p; segment s joins node sp+s to
 * node sp+s+1. The node ⇄ (pipe,end) bijection (design §3) is reproduced by the PURE accessors below —
 * they remap an index only; no arithmetic, so −0.0 / +0.0 are preserved (design §5.2 hazard 2/3):
 *
 *   nodeQin(n)  = old Q_in[n]  : n==0 → qPumpFace; else segmentEndingAt(n)   → qR[p][n−sp−1]  (sp < n ≤ sp+N_p)
 *   nodeQout(n) = old Q_out[n] : n==lastNode → nodeQin(n) (reservoir convention alias, W9);
 *                                else segmentStartingAt(n) → qL[p][n−sp]      (sp ≤ n < sp+N_p)
 *
 * The owning pipe is found by a highest-pipe-first startNode scan, which selects exactly the pipe
 * picked by segmentEndingAt (sp < n) / segmentStartingAt (sp ≤ n) — the two §3 bijection helpers are
 * INLINED into the accessors below rather than standalone functions (design §7-O2 explicitly permits
 * inline-vs-helper; kept inline + cited here to avoid a hot-path {p,s} allocation per accessor call).
 * Double-buffered like SystemState via copyFrom (memcpy — no reordering hazard, design §4.9).
 */
export class FlowState {
    qL: Float64Array[];
    qR: Float64Array[];
    qPumpFace: number;

    // E3′ (S37 — DESIGN §2.1): the node⇄(pipe,end) bijection is resolved by two precomputed inverse
    // maps (built in meshNetwork) instead of the legacy highest-pipe-first startNode scan. Packed
    // value = p*stride + o. For a contiguous pipe the decoded (p,o) equals the scan's pick at every
    // node ⇒ BIT-IDENTICAL on the linear chain (T1a/T4 gate); for a non-contiguous branch it addresses
    // the correct slot instead of aliasing a sibling block (resolves L064). qR uses offset o∈1..N → index
    // o−1; qL uses offset o∈0..N−1 → index o.
    private readonly qoutSlot: Int32Array;   // node → packed LEFT/segment-start end; −1 = reservoir terminal
    private readonly qinSlot:  Int32Array;   // node → packed RIGHT/segment-end end;  −1 = pure source (pump)
    private readonly stride:   number;

    constructor(pipes: PipeParams[], totalNodes: number, qoutSlot: Int32Array, qinSlot: Int32Array, stride: number) {
        this.qL = pipes.map(p => new Float64Array(p.N));
        this.qR = pipes.map(p => new Float64Array(p.N));
        this.qPumpFace = 0.0;
        this.qoutSlot  = qoutSlot;
        this.qinSlot   = qinSlot;
        this.stride    = stride;
    }

    /** old Q_in[n]. RIGHT/segment-end slot: offset o∈1..N → qR[p][o−1]. Pump node (0) → qPumpFace. */
    nodeQin(n: number): number {
        if (n === 0) return this.qPumpFace;
        const x = this.qinSlot[n];
        if (x < 0) return this.qPumpFace;        // pure source — unreachable for n>0
        const p = (x / this.stride) | 0;
        return this.qR[p][(x - p * this.stride) - 1];
    }

    /** old Q_out[n]. Reservoir terminal (qoutSlot<0) → W9 alias = nodeQin. Else LEFT/segment-start: offset o∈0..N−1 → qL[p][o]. */
    nodeQout(n: number): number {
        const x = this.qoutSlot[n];
        if (x < 0) return this.nodeQin(n);        // reservoir terminal: Q_out aliases Q_in (W9)
        const p = (x / this.stride) | 0;
        return this.qL[p][x - p * this.stride];
    }

    /** Inverse of nodeQin — store old Q_in[n] into its slot. */
    setQin(n: number, v: number): void {
        if (n === 0) { this.qPumpFace = v; return; }
        const x = this.qinSlot[n];
        if (x < 0) { this.qPumpFace = v; return; }
        const p = (x / this.stride) | 0;
        this.qR[p][(x - p * this.stride) - 1] = v;
    }

    /** Inverse of nodeQout — store old Q_out[n]. Reservoir terminal is a read-time alias (W9) → no store. */
    setQout(n: number, v: number): void {
        const x = this.qoutSlot[n];
        if (x < 0) return;
        const p = (x / this.stride) | 0;
        this.qL[p][x - p * this.stride] = v;
    }

    copyFrom(src: FlowState): void {
        for (let p = 0; p < this.qL.length; p++) {
            this.qL[p].set(src.qL[p]);
            this.qR[p].set(src.qR[p]);
        }
        this.qPumpFace = src.qPumpFace;
    }
}

/**
 * Reassemble the per-node Q_out / Q_in arrays from FlowState (Section 3 — Option B output adapter,
 * design §4.8). PURE element copies (out[i] = accessor(i)); no arithmetic — preserves the exact bytes
 * and sign-of-zero v15.5 emitted. Used for fullHistory (R9) + the q_in telemetry, and the MIAB seed (R6/R7).
 */
export function reassembleQout(flow: FlowState, totalNodes: number): number[] {
    const out = new Array<number>(totalNodes);
    for (let i = 0; i < totalNodes; i++) out[i] = flow.nodeQout(i);
    return out;
}
export function reassembleQin(flow: FlowState, totalNodes: number): number[] {
    const out = new Array<number>(totalNodes);
    for (let i = 0; i < totalNodes; i++) out[i] = flow.nodeQin(i);
    return out;
}

/**
 * Pipe p's OWN discharge at local offset o (R10, S37 — DESIGN §4.4/§4.5): segment-start qL[p][o] for
 * o < N, own to-end qR[p][N−1] for o == N. Unlike nodeQout(nodeIds[p][o]) it does NOT collapse to a
 * sibling pipe at a shared junction — each conduit-end's MIAB uses that conduit's own flow history.
 * On a contiguous pipe whose to-end is a reservoir terminal it equals the old nodeQout (W9 alias);
 * it differs only at an interior junction offset (o==0 from-end / o==N to-end), where the old scan
 * aliased the sibling. (Completes the §4.3 b+ fix that S36 applied only to the MIAB params, not the flow.)
 */
function pipeOwnQout(flow: FlowState, p: number, N: number, o: number): number {
    return o < N ? flow.qL[p][o] : flow.qR[p][N - 1];
}

/**
 * Pipe p's OWN Q_in at local offset o (Bug #9b, S44 — DECISIONS 2026-06-28): segment-end qR[p][o−1].
 * C− mirror of pipeOwnQout for the MIAB spatial-gradient right-read. Precondition o ∈ 1..N (offset-0
 * from-end has no own segment-end inflow — it arrives from upstream / qPumpFace, so o==0 is never
 * passed here). Unlike nodeQin(nodeIds[p][o]) it does NOT collapse to a sibling at a shared to-end
 * junction. `N` retained only for signature symmetry with pipeOwnQout (unused in body).
 */
function pipeOwnQin(flow: FlowState, p: number, N: number, o: number): number {
    return flow.qR[p][o - 1];
}

/** E7′ per-pipe-end discharge snapshot (UNHASHED telemetry, spec §3b.7). qFrom[p]=qL[p][0] (from-end),
 *  qTo[p]=qR[p][N−1] (to-end). Recovers the incident-end flows the node-indexed output collapses at a
 *  shared junction (T3 branched continuity). Pure element reads — adds no hashed bytes. */
function captureEndFlows(flow: FlowState, pipes: Pipe[]): { qFrom: number[]; qTo: number[] } {
    return {
        qFrom: pipes.map((_pe, p) => flow.qL[p][0]),
        qTo:   pipes.map((pe,  p) => flow.qR[p][pe.p.N - 1])
    };
}

/**
 * MIAB unsteady-friction state — all arrays indexed by node [0 .. totalNodes−1].
 *
 * z[k][i] : k-th MIAB state variable at node i            [m/s²]
 * Q_prev  : Q_out recorded at the PREVIOUS timestep       [m³/s]
 *           used to compute flow acceleration dQ/dt
 */
class MIABState {
    z:      Float64Array[];   // outer index: MIAB component k; inner: node
    Q_prev: Float64Array;

    constructor(n: number) {
        this.z      = Array.from({ length: MIAB_M }, () => new Float64Array(n));
        this.Q_prev = new Float64Array(n);
    }
}

/**
 * Per-pipe mutable MIAB state (b+ storage — D3, DESIGN §4.1).
 * Length N_p+1 aligned with nodeIds[p].
 * z[k][o]: k-th component at local offset o within pipe p.
 * Qprev[o]: previous-step Q_out at offset o (for acceleration).
 */
interface PipeMIABState {
    z:      Float64Array[];   // [k][o]: MIAB component k at offset o
    Qprev:  Float64Array;     // previous Q_out at offset o
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — COMPUTE_MIAB_PIPE_PARAMS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * BOX: Vardy-Brown Turbulent Unsteady Friction Parameters
 *
 * INPUT
 *   Re [−]    Reynolds number at steady-state flow (must be > 4 000)
 *   nu [m²/s] kinematic viscosity
 *   D  [m]    pipe internal diameter
 *
 * OUTPUT  MIABPipeParams
 *   k_u   [-]    Brunone coefficient = C_star/2
 *                C_star = 7.41 / Re^kappa,  kappa = log10(14.3 / Re^0.05)
 *   alpha [1/s]  per-component decay rates, length MIAB_M
 *                alpha[0] = B_star * nu/R^2   (fast — Vardy-Brown primary)
 *                alpha[1] = alpha[0]*0.1       (slow — low-frequency supplement)
 *                B_star = 12.86 / Re^0.0567
 *
 * ASSUMPTIONS
 *   Smooth turbulent pipe throughout the transient.
 *   Parameters fixed at steady-state Re (frozen-coefficient approximation).
 */
function COMPUTE_MIAB_PIPE_PARAMS(Re: number, nu: number, D: number): MIABPipeParams {
    // Vardy shear-decay coefficient (Vardy & Brown 1995, Eq. 12)
    const kappa  = Math.log10(14.3 / Math.pow(Re, 0.05));
    const C_star = 7.41 / Math.pow(Re, kappa);
    const k_u    = C_star / 2.0;

    // Vardy-Brown exponential-decay parameter
    const R      = D / 2.0;
    const B_star = 12.86 / Math.pow(Re, 0.0567);

    const alpha = new Float64Array(MIAB_M);
    alpha[0] = B_star * nu / (R * R);           // fast component  [1/s]
    alpha[1] = alpha[0] * MIAB_SLOW_RATIO;       // slow component  [1/s]

    return { k_u, alpha };
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — DGCM GAS HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * BOX: DGCM Quadratic Solver
 *
 * Solves simultaneously:
 *   (1) V_g = a_coef · H + b_coef           [mass balance, linearised]
 *   (2) (H − Z + H_BARO) · V_g = C_gas      [isothermal gas law]
 *
 * Substituting (1) into (2) yields:
 *   a_coef·H² + (b_coef + a_coef·S)·H + (b_coef·S − C_gas) = 0
 *   where S = H_BARO − Z
 *
 * INPUT
 *   a_coef   [m³/m]  slope of V_g(H); positive (V_g grows with H under net outflow)
 *   b_coef   [m³]    intercept of V_g(H)
 *   C_gas    [m⁴]    isothermal gas constant, > 0
 *   Z        [m]     node elevation
 *   H_fallback [m]   liquid-only (Joukowsky) head; returned when no physical root
 *
 * OUTPUT
 *   H [m] — root satisfying V_g > 0 and H > Z − H_BARO (positive absolute pressure)
 *   Returns H_fallback when cavity is fully collapsed (V_g would go negative).
 */
function SOLVE_DGCM_QUADRATIC(
    a_coef:     number,
    b_coef:     number,
    C_gas:      number,
    Z:          number,
    H_fallback: number
): number {
    const S  = H_BARO - Z;
    const Aq = a_coef;
    const Bq = b_coef + a_coef * S;
    const Cq = b_coef * S - C_gas;

    if (Math.abs(Aq) < 1e-30) {
        return Math.abs(Bq) < 1e-30 ? H_fallback : -Cq / Bq;
    }

    const disc = Bq * Bq - 4.0 * Aq * Cq;
    if (disc < 0.0) return H_fallback;

    const sq   = Math.sqrt(disc);
    const H1   = (-Bq + sq) / (2.0 * Aq);
    const H2   = (-Bq - sq) / (2.0 * Aq);
    const Hmin = Z - H_BARO;   // absolute vacuum limit

    // Physical root: V_g > 0  AND  H > Hmin
    const V1 = a_coef * H1 + b_coef;
    const V2 = a_coef * H2 + b_coef;

    if (V1 > 0.0 && H1 > Hmin) return H1;
    if (V2 > 0.0 && H2 > Hmin) return H2;
    return H_fallback;   // cavity collapsed — use Joukowsky liquid solution
}

/**
 * BOX: Gas Volume Bounds Enforcement
 *
 * INPUT
 *   V_g    [m³]  raw gas volume from DGCM step
 *   C_gas  [m⁴]  gas constant
 *   Z      [m]   node elevation
 *   V_max  [m³]  maximum physical volume = dx · A
 *   H_calc [m]   head from DGCM quadratic (returned unchanged when V_g < V_MIN)
 *
 * OUTPUT  { V_g [m³], H [m] }
 *
 * RULES
 *   V_g < V_MIN : cavity fully collapsed; retain H_calc (= Joukowsky head).
 *   V_g > V_max : cap volume and recompute H from gas law.
 */
function CLAMP_GAS_VOLUME(
    V_g:    number,
    C_gas:  number,
    Z:      number,
    V_max:  number,
    H_calc: number
): { V_g: number; H: number } {
    const V_MIN = 1e-12;
    if (V_g < V_MIN)  return { V_g: V_MIN, H: H_calc };
    if (V_g > V_max)  return { V_g: V_max, H: C_gas / V_max - H_BARO + Z };
    return { V_g, H: H_calc };
}

/**
 * BOX: Vapor Pressure Floor
 *
 * INPUT
 *   H, V_g  current head [m] and gas volume [m³]
 *   C_gas   [m⁴]
 *   Z       [m]
 *
 * OUTPUT  { H [m], V_g [m³] }
 *
 * When H < H_vap, clamp H at vapor pressure and recompute V_g from gas law:
 *   H_vap_abs = H_BARO + VAPOR_H_REL = 10.33 − 9.8 = 0.53 m (absolute)
 *   V_g = C_gas / H_vap_abs
 */
function APPLY_VAPOR_FLOOR(
    H:     number,
    V_g:   number,
    C_gas: number,
    Z:     number
): { H: number; V_g: number } {
    const H_vap     = Z + VAPOR_H_REL;
    if (H >= H_vap) return { H, V_g };

    const H_abs_vap = H_BARO + VAPOR_H_REL;   // = 0.53 m absolute
    return {
        H:   H_vap,
        V_g: H_abs_vap > 1e-12 ? C_gas / H_abs_vap : C_gas / 1e-12
    };
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 6 — COMPUTE_CHARACTERISTICS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * BOX: MOC Compatibility Coefficients with MIAB Unsteady Friction
 *
 * INPUT
 *   idx        target node index
 *   state      hydraulic state at timestep n (prevState) — H only (flow moved to FlowState)
 *   flow       per-pipe-end flow at timestep n (prevFlow); reads via nodeQin/nodeQout (design §3/§4.1)
 *   pipeUp     upstream  Pipe bundle (null at left boundary)
 *   pipeDown   downstream Pipe bundle (null at right boundary)
 *   miabState  current MIAB filter state
 *   totalNodes total node count (for right-side boundary guard)
 *
 * OUTPUT  CharCoefs  { Cp, Cm, B1, B2 }
 *   Values already include steady Darcy-Weisbach friction AND MIAB correction.
 *
 * ── C+ characteristic (upstream base point A = idx−1) ───────────────────────
 *   B1  = a / (g·A)
 *   R1  = f·dx / (2·g·D·A²)
 *   Cp  = H[A] + B1·Q_out[A] − R1·Q_out[A]·|Q_out[A]| − h_uf_C+
 *
 * ── C− characteristic (downstream base point B = idx+1) ────────────────────
 *   B2  = a / (g·A)
 *   R2  = f·dx / (2·g·D·A²)
 *   Cm  = H[B] − B2·Q_in[B]  + R2·Q_in[B]·|Q_in[B]|  + h_uf_C−
 *
 * ── MIAB unsteady friction head over one reach (Brunone-Vitkovsky) ──────────
 *   dV_dt_eff = Σ_k z[k][base]                  [m/s²]  MIAB time-weighted accel
 *   h_uf_C+  = k_u·(dx/g)·(dV_dt_eff − a·sgn(Q)·dV_dx_backward)  [m]
 *   h_uf_C−  = k_u·(dx/g)·(dV_dt_eff + a·sgn(Q)·dV_dx_forward)   [m]
 *   (sign of spatial term flips with characteristic direction)
 *
 * ── Spatial gradient conventions ────────────────────────────────────────────
 *   C+ base A: backward difference  dV_dx = (Q[A] − Q[A−1]) / (A_pipe · dx)
 *   C− base B: forward  difference  dV_dx = (Q[B+1] − Q[B]) / (A_pipe · dx)
 *   At domain edges (no neighbor): zero-gradient assumption applied.
 */
function COMPUTE_CHARACTERISTICS(
    idx:        number,
    state:      SystemState,
    flow:       FlowState,
    pipeUp:     Pipe | null,
    pipeDown:   Pipe | null,
    miabState:  MIABState,
    totalNodes: number,
    // Extended b+ per-pipe MIAB params (optional — null on legacy path falls back to miabState)
    pipeMIABArr?:   PipeMIABState[],
    pipeUpIdx?:     number,
    pipeDownIdx?:   number,
    offsetUp?:      number,
    offsetDown?:    number,
    nodeIdsArr?:    number[][]
): CharCoefs {
    let Cp = 0.0, Cm = 0.0, B1 = 0.0, B2 = 0.0;

    // ── C+ (from upstream) ──────────────────────────────────────────────────
    if (pipeUp) {
        const { p, miab } = pipeUp;
        // R9 (S37 — DESIGN §2.1): C+ base point resolved through nodeIds (= idx−1 on a contiguous pipe ⇒
        // bit-identical; the correct topological neighbour across a non-contiguous junction otherwise).
        const idxA = (nodeIdsArr !== undefined && pipeUpIdx !== undefined && offsetUp !== undefined)
            ? nodeIdsArr[pipeUpIdx][offsetUp - 1]
            : idx - 1;
        B1          = p.a / (G * p.A);
        const R1    = (p.f * p.dx) / (2.0 * G * p.D * p.A * p.A);
        const HA    = state.H[idxA];
        // Bug #9 (S40, L090): own-pipe C+ base-flow read. nodeQout(idxA) collapses to the LAST-writer
        // sibling at a shared junction (diag5 S39: nodeQout(J)=Q_b2≠Q_b1 ⇒ +79.64 m step-1 excursion at
        // node 21). pipeOwnQout keeps each conduit's C+ base on its OWN flow history — the §4.3 own-vs-
        // sibling fix R10 applied to the MIAB state (l.1315/1329/1758) but never extended to the interior
        // flow read. Linear/contiguous bit-identical: offsetUp∈[1..N] ⇒ offsetUp−1∈[0..N−1] ⇒ qL[p][o],
        // == nodeQout(idxA) wherever idxA is not a shared junction (the only divergence locus = the bug).
        const QA    = (nodeIdsArr !== undefined && pipeUpIdx !== undefined && offsetUp !== undefined)
            ? pipeOwnQout(flow, pipeUpIdx, p.N, offsetUp - 1)
            : flow.nodeQout(idxA);

        Cp = HA + B1 * QA - R1 * QA * Math.abs(QA);

        // MIAB: sum weighted acceleration state at base node A
        let dVdt = 0.0;
        if (pipeMIABArr !== undefined) {
            const oA = offsetUp! - 1;
            for (let k = 0; k < MIAB_M; k++) dVdt += pipeMIABArr[pipeUpIdx!].z[k][oA];
            // Spatial gradient: backward difference at oA
            // Bug #9b (S44, DECISIONS 2026-06-28): the in-bounds (oA>0) interior read uses the OWN-pipe
            // accessor pipeOwnQout — nodeQout(nodeIds[pipeUpIdx][oA−1]) collapses to the last-writer
            // sibling at the offset-0 from-end junction (oA==1), the same #9-class hazard as the C+ base
            // read (l.614). The else (oA==0) boundary read keeps the global idxA−1 cross-pipe spatial
            // gradient (DESIGN §8.3, intentional). Contiguous/linear: pipeOwnQout==nodeQout ⇒ DEFAULT inert.
            let QA_left: number;
            if (oA > 0) {
                QA_left = nodeIdsArr ? pipeOwnQout(flow, pipeUpIdx!, p.N, oA - 1) : flow.nodeQout(idxA - 1);
            } else {
                // At left boundary of this pipe — use global index to allow cross-pipe reading
                QA_left = idxA > 0 ? flow.nodeQout(idxA - 1) : QA;
            }
            const dVdx  = (QA - QA_left) / (p.A * p.dx);
            const sgnQA = QA >= 0.0 ? 1.0 : -1.0;
            Cp -= miab.k_u * (p.dx / G) * (dVdt - p.a * sgnQA * dVdx);
        } else {
            for (let k = 0; k < MIAB_M; k++) dVdt += miabState.z[k][idxA];
            const QA_left = idxA > 0 ? flow.nodeQout(idxA - 1) : QA;   // R2 (may cross to previous pipe)
            const dVdx    = (QA - QA_left) / (p.A * p.dx);   // [1/s]
            const sgnQA   = QA >= 0.0 ? 1.0 : -1.0;
            Cp -= miab.k_u * (p.dx / G) * (dVdt - p.a * sgnQA * dVdx);
        }
    }

    // ── C− (from downstream) ────────────────────────────────────────────────
    if (pipeDown) {
        const { p, miab } = pipeDown;
        // R9 (S37 — DESIGN §2.1): C− base point resolved through nodeIds (= idx+1 on a contiguous pipe ⇒
        // bit-identical; the correct topological neighbour across a non-contiguous junction otherwise).
        const idxB = (nodeIdsArr !== undefined && pipeDownIdx !== undefined && offsetDown !== undefined)
            ? nodeIdsArr[pipeDownIdx][offsetDown + 1]
            : idx + 1;
        B2          = p.a / (G * p.A);
        const R2    = (p.f * p.dx) / (2.0 * G * p.D * p.A * p.A);
        const HB    = state.H[idxB];
        // Bug #9 audit (S40, A4): C− base read is NOT a junction-collapse hazard. idxB =
        // nodeIdsArr[pipeDownIdx][offsetDown+1] with offsetDown∈[0..N−1] ⇒ offset∈[1..N] ⇒ idxB is never
        // this pipe's offset-0 (from-end) junction node; and even at a to-end junction nodeQin reads
        // qR[pipeDownIdx][N−1] = this pipe's OWN to-end flow. Collapse-safe by construction (no #9-class fix).
        const QB    = flow.nodeQin(idxB);   // R3: = old Q_in[idxB] (design §4.1)

        Cm = HB - B2 * QB + R2 * QB * Math.abs(QB);

        // MIAB: sum weighted acceleration state at base node B
        let dVdt = 0.0;
        if (pipeMIABArr !== undefined) {
            const oB = offsetDown! + 1;
            for (let k = 0; k < MIAB_M; k++) dVdt += pipeMIABArr[pipeDownIdx!].z[k][oB];
            // Spatial gradient: forward difference at oB
            // Bug #9b (S44, DECISIONS 2026-06-28): the in-bounds (oB<N) interior read uses the OWN-pipe
            // accessor pipeOwnQin — nodeQin(nodeIds[pipeDownIdx][oB+1]) collapses to the last-writer
            // sibling at the offset-N to-end junction (oB==N−1), the same #9-class hazard. The else (oB==N)
            // boundary read keeps the global idxB+1 cross-pipe spatial gradient (DESIGN §8.3, intentional).
            // Contiguous/linear: pipeOwnQin==nodeQin ⇒ DEFAULT inert.
            let QB_right: number;
            if (oB < pipeDown.p.N) {
                QB_right = nodeIdsArr ? pipeOwnQin(flow, pipeDownIdx!, pipeDown.p.N, oB + 1) : flow.nodeQin(idxB + 1);
            } else {
                // At right boundary of this pipe — use global index to allow cross-pipe reading
                QB_right = idxB + 1 < totalNodes ? flow.nodeQin(idxB + 1) : QB;
            }
            const dVdx  = (QB_right - QB) / (p.A * p.dx);
            const sgnQB = QB >= 0.0 ? 1.0 : -1.0;
            Cm += miab.k_u * (p.dx / G) * (dVdt + p.a * sgnQB * dVdx);
        } else {
            for (let k = 0; k < MIAB_M; k++) dVdt += miabState.z[k][idxB];
            // Spatial gradient: forward difference at B (zero-gradient at right wall)
            const QB_right = idxB + 1 < totalNodes ? flow.nodeQin(idxB + 1) : QB;   // R4 (may cross to next pipe)
            const dVdx     = (QB_right - QB) / (p.A * p.dx);   // [1/s]
            const sgnQB    = QB >= 0.0 ? 1.0 : -1.0;
            Cm += miab.k_u * (p.dx / G) * (dVdt + p.a * sgnQB * dVdx);
        }
    }

    return { Cp, Cm, B1, B2 };
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 7 — NODE CALCULATORS
// ═══════════════════════════════════════════════════════════════════════════════
//
// All calculators share the same pattern:
//   INPUT  : CharCoefs + prevState + pipe geometry + (pump/reservoir params)
//   OUTPUT : writes H, Q_in, Q_out, V_g into newState at the target node
//   DGCM mass balance (net outflow convention):
//     Net outflow = Q_out − Q_in = (H−Cm)/B2 − (Cp−H)/B1 = (2H−Cp−Cm)/B  [interior]
//     dV_g = dt · net_outflow
//     ⟹  V_g = a_coef · H + b_coef   where a_coef > 0
//         a_coef = +dt·(1/B1 + 1/B2)
//         b_coef = V_g_old − dt·(Cp/B1 + Cm/B2)

// ── 7a: Interior node ────────────────────────────────────────────────────────
/**
 * BOX: CALC_INTERIOR_DGCM
 *
 * INPUT
 *   idx       node index (1 ≤ idx ≤ N−1 within a pipe)
 *   coefs     CharCoefs at idx (from COMPUTE_CHARACTERISTICS)
 *   prevState hydraulic state at t_n
 *   newState  output — writes H, Q_in, Q_out, V_g at idx
 *   grid      { dt }
 *   pipe      PipeParams for this segment
 *
 * DGCM EQUATIONS (single-pipe interior, B1 = B2 = B)
 *   a_coef = +2·dt/B
 *   b_coef = V_g_old − dt·(Cp + Cm)/B
 *   H solved from gas law + mass balance via SOLVE_DGCM_QUADRATIC
 *   V_g = a_coef·H + b_coef   (then clamped + vapor floor applied)
 *   Q_in  = (Cp − H) / B
 *   Q_out = (H  − Cm) / B
 */
function CALC_INTERIOR_DGCM(
    idx:       number,
    coefs:     CharCoefs,
    prevState: SystemState,
    newState:  SystemState,
    newFlow:   FlowState,
    grid:      GridParams,
    pipe:      PipeParams
): void {
    const { Cp, Cm, B1 } = coefs;
    const B        = B1;
    const dt       = grid.dt;
    const C_gas    = prevState.C_gas[idx];
    const Z        = prevState.Z[idx];
    const V_g_old  = prevState.V_g[idx];

    // Liquid-only (Joukowsky) fallback
    const H_liquid = (Cp + Cm) / 2.0;

    // DGCM mass balance: dV_g = dt·(Q_out − Q_in) = dt·(2H−Cp−Cm)/B
    // → V_g = a_coef·H + b_coef,  a_coef > 0
    const a_coef = +2.0 * dt / B;
    const b_coef = V_g_old - dt * (Cp + Cm) / B;

    const V_max     = pipe.dx * pipe.A;
    const H_vap     = Z + VAPOR_H_REL;
    const H_abs_vap = H_BARO + VAPOR_H_REL;   // 0.53 m absolute

    let H        = SOLVE_DGCM_QUADRATIC(a_coef, b_coef, C_gas, Z, H_liquid);
    let V_g      = a_coef * H + b_coef;
    let C_gas_new = C_gas;

    if (V_g <= 0.0) {
        // Cavity collapsed → liquid Joukowsky state
        // Keep C_gas at last vapour-floor value (prevents phantom cavities under high pressure)
        H   = H_liquid;
        V_g = 1e-12;
        if (H < H_vap) H = H_vap;   // vapour floor: liquid head can never be sub-vapour
    } else if (H < H_vap) {
        // Active cavitation: pin H, recompute V_g from mass balance, update C_gas
        H   = H_vap;
        V_g = a_coef * H_vap + b_coef;
        if (V_g <= 0.0) {
            // Net inflow negative even at vapour pressure: tiny seed, C_gas unchanged
            V_g = 1e-12;
        } else {
            if (V_g > V_max) V_g = V_max;
            C_gas_new = H_abs_vap * V_g;
        }
    } else {
        // Cavity collapsing (H >= H_vap, V_g > 0): C_gas frozen at last vapour-floor value
        if (V_g > V_max) V_g = V_max;
    }

    newState.H[idx]     = H;
    newFlow.setQin(idx, (Cp - H) / B);    // W3: old Q_in[idx]  → qR[p][s−1]
    newFlow.setQout(idx, (H  - Cm) / B);  // W3: old Q_out[idx] → qL[p][s]
    newState.V_g[idx]   = V_g;
    newState.C_gas[idx] = C_gas_new;
}

// ── 7b: Pipe-to-pipe junction ─────────────────────────────────────────────────
/**
 * BOX: CALC_JUNCTION_DGCM
 *
 * INPUT
 *   idx       junction node index
 *   coefs     CharCoefs at idx (B1 from upstream pipe, B2 from downstream pipe)
 *   prevState, newState, grid  — same role as CALC_INTERIOR_DGCM
 *   pUp       upstream  PipeParams
 *   pDown     downstream PipeParams
 *
 * DGCM EQUATIONS (junction, B1 ≠ B2 in general)
 *   a_coef = +dt·(1/B1 + 1/B2)
 *   b_coef = V_g_old − dt·(Cp/B1 + Cm/B2)
 *   H_liquid = (Cp/B1 + Cm/B2) / (1/B1 + 1/B2)
 *   Q_in  = (Cp − H) / B1
 *   Q_out = (H  − Cm) / B2
 */
export function CALC_JUNCTION_DGCM(
    idx:       number,
    coefs:     CharCoefs,
    prevState: SystemState,
    newState:  SystemState,
    newFlow:   FlowState,
    grid:      GridParams,
    pUp:       PipeParams,
    pDown:     PipeParams
): void {
    const { Cp, Cm, B1, B2 } = coefs;
    const dt      = grid.dt;
    const C_gas   = prevState.C_gas[idx];
    const Z       = prevState.Z[idx];
    const V_g_old = prevState.V_g[idx];

    const sum_inv_B = 1.0 / B1 + 1.0 / B2;
    const H_liquid  = (Cp / B1 + Cm / B2) / sum_inv_B;

    const a_coef = +dt * sum_inv_B;
    const b_coef = V_g_old - dt * (Cp / B1 + Cm / B2);

    const V_max     = Math.min(pUp.dx * pUp.A, pDown.dx * pDown.A);
    const H_vap     = Z + VAPOR_H_REL;
    const H_abs_vap = H_BARO + VAPOR_H_REL;

    let H        = SOLVE_DGCM_QUADRATIC(a_coef, b_coef, C_gas, Z, H_liquid);
    let V_g      = a_coef * H + b_coef;
    let C_gas_new = C_gas;

    if (V_g <= 0.0) {
        H   = H_liquid;
        V_g = 1e-12;
        if (H < H_vap) H = H_vap;
    } else if (H < H_vap) {
        H   = H_vap;
        V_g = a_coef * H_vap + b_coef;
        if (V_g <= 0.0) {
            V_g = 1e-12;
        } else {
            if (V_g > V_max) V_g = V_max;
            C_gas_new = H_abs_vap * V_g;
        }
    } else {
        if (V_g > V_max) V_g = V_max;
    }

    newState.H[idx]     = H;
    newFlow.setQin(idx, (Cp - H) / B1);    // W4: junction inflow  (B1=upstream)   → qR[upstreamPipe][N−1]
    newFlow.setQout(idx, (H  - Cm) / B2);  // W4: junction outflow (B2=downstream) → qL[downstreamPipe][0]
    newState.V_g[idx]   = V_g;
    newState.C_gas[idx] = C_gas_new;
}

// ── 7b.1: N-face junction (Phase 2.5.4 / I4 — spec §3b.3–§3b.6) ───────────────
/**
 * BOX: CALC_JUNCTION_DGCM_N — N-face junction DGCM calculator (Section 7b.1)
 *
 * Generalises CALC_JUNCTION_DGCM (Section 7b) from 2 faces to n (spec §3b.3–§3b.6). PURE function:
 * solves the junction head / cavity from the per-face characteristics and RETURNS per-face flows;
 * it writes no node/flow state — the graph-traversal main loop (I6) writes Q[k] to each face's
 * branched FlowState slot via the §3a.6 ownerPipe map. No MIAB term here: each face's C_k already
 * carries its pipe's MIAB, folded by COMPUTE_CHARACTERISTICS at the neighbour node (DECISIONS
 * 2026-06-09 I4). Reduces BIT-IDENTICALLY to CALC_JUNCTION_DGCM when n = 2 with faces ordered
 * [incoming(Cp,B1), outgoing(Cm,B2)] (degeneracy gate, task I4 DoD).
 *
 * INPUT
 *   faces    incident pipe-ends. Face k carries MOC constant C_k (Cp_k incoming / Cm_k outgoing),
 *            impedance B_k, segment volume dx_k·A_k, and direction (incoming = flow toward J).
 *   V_g_old  prior cavity volume at the junction node                                  [m³]
 *   C_gas    isothermal gas constant at the junction node                              [m⁴]
 *   Z        junction node elevation                                                   [m]
 *   dt       timestep                                                                  [s]
 *
 * GOVERNING EQUATIONS (spec §3b.3; DOMAIN §3/§4) — sums over ALL n faces, direction-agnostic:
 *   H_liquid = Σ_k(C_k/B_k) / Σ_k(1/B_k)
 *   a_coef   = +dt · Σ_k(1/B_k)      POSITIVE — net-outflow convention (DOMAIN §4 / Bug #4)
 *   b_coef   = V_g_old − dt · Σ_k(C_k/B_k)
 *   V_max    = min_k(dx_k·A_k)       per-segment volumetric ceiling (spec §3b.4)
 * Vapor floor / C_gas discipline (spec §3b.5; DOMAIN §7 — Bug #1/#3): identical state machine to
 * CALC_JUNCTION_DGCM (C_gas updated ONLY at the vapor floor; never reset to zero).
 * Per-face flow (spec §3b.6/§3b.7), signed in each face's natural direction:
 *   incoming Q_k = (C_k − H)/B_k ;  outgoing Q_k = (H − C_k)/B_k
 */
export interface JunctionFaceN {
    readonly C:        number;   // MOC constant Cp_k (incoming) | Cm_k (outgoing)    [m]
    readonly B:        number;   // wave impedance of this incident pipe end           [m·s/m³]
    readonly dxA:      number;   // dx_k·A_k of this incident segment (for V_max = min) [m³]
    readonly incoming: boolean;  // pipe's `to == J` (toward J) ⇒ true; `from == J` ⇒ false
}
export interface JunctionResultN {
    readonly H:     number;      // junction head                                      [m]
    readonly V_g:   number;      // cavity volume                                      [m³]
    readonly C_gas: number;      // updated gas constant                               [m⁴]
    readonly Q:     number[];    // per-face flow, indexed as faces[]; signed in each face's direction
}
export function CALC_JUNCTION_DGCM_N(
    faces:   readonly JunctionFaceN[],
    V_g_old: number,
    C_gas:   number,
    Z:       number,
    dt:      number
): JunctionResultN {
    // Σ over all incident faces; face order preserved for FP-operand parity with the 2-face form.
    let sum_inv_B    = 0.0;          // Σ 1/B_k
    let sum_C_over_B = 0.0;          // Σ C_k/B_k
    let V_max        = Infinity;     // min_k(dx_k·A_k)
    for (const f of faces) {
        sum_inv_B    += 1.0 / f.B;
        sum_C_over_B += f.C / f.B;
        if (f.dxA < V_max) V_max = f.dxA;
    }

    const H_liquid = sum_C_over_B / sum_inv_B;
    const a_coef   = +dt * sum_inv_B;              // POSITIVE — net-outflow (DOMAIN §4 / Bug #4)
    const b_coef   = V_g_old - dt * sum_C_over_B;

    const H_vap     = Z + VAPOR_H_REL;
    const H_abs_vap = H_BARO + VAPOR_H_REL;

    // Vapor floor / C_gas state machine — identical to CALC_JUNCTION_DGCM (DOMAIN §7 — Bug #1/#3).
    let H        = SOLVE_DGCM_QUADRATIC(a_coef, b_coef, C_gas, Z, H_liquid);
    let V_g      = a_coef * H + b_coef;
    let C_gas_new = C_gas;

    if (V_g <= 0.0) {
        H   = H_liquid;
        V_g = 1e-12;
        if (H < H_vap) H = H_vap;
    } else if (H < H_vap) {
        H   = H_vap;
        V_g = a_coef * H_vap + b_coef;
        if (V_g <= 0.0) {
            V_g = 1e-12;
        } else {
            if (V_g > V_max) V_g = V_max;
            C_gas_new = H_abs_vap * V_g;
        }
    } else {
        if (V_g > V_max) V_g = V_max;
    }

    // Per-face flow at the final (possibly pinned) H — signed in each face's natural direction.
    const Q = faces.map(f => (f.incoming ? (f.C - H) / f.B : (H - f.C) / f.B));

    return { H, V_g, C_gas: C_gas_new, Q };
}

// ── 7g: Air valve node (Q14) ──────────────────────────────────────────────────
/**
 * BOX: CALC_AIR_VALVE_N — air valve (air inlet/outlet) at an interior or junction node (Q14).
 * Also at a line end while that end is a dead end (pump stopped / valve shut, ruling 3): one face,
 * the DC-5 stopped-branch geometry. At the line start while the built-in-curve pump runs (Q16), the
 * pump inflow is a known Q_feed — the curve evaluated once at the previous-step head (single pass;
 * DC-5 forbids a joint gas-law + pump-curve + C− solve). While a user-curve pump runs or the end
 * valve passes flow, the end BC runs unchanged and the air valve stays closed.
 *
 * Wylie & Streeter, Fluid Transients in Systems (1993) §3.6: air enters through the inlet orifice
 * while the line is below atmospheric, is trapped as a pocket that follows the isothermal gas law,
 * and leaves through the outlet orifice while above atmospheric. No air and liquid at or above
 * atmospheric = the valve is closed and the node is plain liquid. Cd = 0.6 both orifices.
 *
 * Air content is carried in head·volume units, C_air = H_abs·V = m·R·T/(ρ_w·g) [m⁴] — the same
 * units as the DGCM C_gas, stored in the node's C_gas slot; the pocket volume is the node's V_g.
 * Coexistence with the vapour-cavity model: the pressure never goes below vapour (H_vap); when the
 * air alone cannot fill the pocket at H_vap, H is pinned there and vapour fills the rest (it
 * condenses as the pressure rises, as in the DGCM). Implicit step, solved by bisection on H:
 *   V(H)  = V_old + dt·Σ_k(H − C_k)/B_k            (same net-outflow balance as CALC_JUNCTION_DGCM_N)
 *   C(H)  = max(0, C_air + dt·KC·ṁ(H))             (ṁ: air mass flow, + = in)
 *   (H − Z + H_BARO)·V(H) = C(H)                   (isothermal gas law; LHS rises, RHS falls with H)
 * Pocket vented to zero volume = closed; H is then the liquid (Joukowsky) head, the DGCM collapse
 * convention (CALC_INTERIOR_DGCM) — H from V = 0 instead puts a one-step false suction pulse
 * of V_old/(dt·Σ1/B) metres on the line at every closure.
 */
export interface AirValveBC {
    x:         number;   // chainage of the valve node from node 0 [m]
    inlet_mm:  number;   // inlet orifice diameter  [mm]
    outlet_mm: number;   // outlet orifice diameter [mm]
}
const AIR_CD    = 0.6;      // orifice discharge coefficient, inlet and outlet (Q14 spec)
const AIR_R     = 287.1;    // gas constant of dry air [J/(kg·K)] (W&S §3.6)
const AIR_T     = 293.15;   // air temperature, 20 °C [K] — builder choice (LOOK-AT Q14); ṁ ∝ 1/√T,
                            // 0–40 °C moves ṁ by < 4 %, the pocket gas law is isothermal in any case
const AIR_RT    = AIR_R * AIR_T;   // [J/kg]
const AIR_K     = 1.4;      // ratio of specific heats of air (W&S §3.6)
const RHO_W     = 1000;     // water density [kg/m³]
// Isentropic orifice-flow factors of W&S eqs 3.45–3.48, all from k (k = 1.4 gives the book's
// 7, 1.4286, 1.714, 0.528 and 0.686 — the last one 0.685 here, continuous at the critical ratio):
const AIR_SUB_F = 2 * AIR_K / (AIR_K - 1);                                  // 7
const AIR_EXP_1 = 2 / AIR_K;                                                 // 1.4286
const AIR_EXP_2 = (AIR_K + 1) / AIR_K;                                       // 1.714
const AIR_CRIT  = Math.pow(2 / (AIR_K + 1), AIR_K / (AIR_K - 1));            // 0.528 critical ratio
const AIR_CHOKE = Math.sqrt(AIR_K * Math.pow(2 / (AIR_K + 1), (AIR_K + 1) / (AIR_K - 1)));   // 0.685
// Bisection controls of CALC_AIR_VALVE_N (numerics, not physics): first bracket step above
// max(lo, Z) [m], bracket growth factor, and iterations (80 halvings: far below 1e-9 m).
const AIR_BRACKET_M  = 1.0;
const AIR_BRACKET_GROW = 2.0;
const AIR_BISECT_ITERS = 80;

/** Air mass flow through the valve [kg/s], + = into the pocket (W&S eqs 3.45–3.48): subsonic
 *  ṁ = Cd·A·√(F·p_hi·ρ_hi·(r^E1 − r^E2)), r = p_lo/p_hi, ρ_hi = p_hi/(R·T); choked (r < r_crit)
 *  ṁ = Cd·A·C·p_hi/√(R·T). In through the inlet below atmospheric, out through the outlet above. */
function AIR_MASS_FLOW(H_abs: number, A_in: number, A_out: number): number {
    const pa = RHO_W * G * H_BARO;
    const p  = RHO_W * G * Math.max(H_abs, 0);
    const flux = (hi: number, r: number) => r < AIR_CRIT
        ? AIR_CHOKE * hi / Math.sqrt(AIR_RT)
        : Math.sqrt(AIR_SUB_F * hi * (hi / AIR_RT) * (Math.pow(r, AIR_EXP_1) - Math.pow(r, AIR_EXP_2)));
    return p < pa ? AIR_CD * A_in * flux(pa, p / pa) : -AIR_CD * A_out * flux(p, pa / p);
}

export function CALC_AIR_VALVE_N(
    faces:  readonly JunctionFaceN[],
    V_old:  number,
    C_air:  number,
    Z:      number,
    dt:     number,
    A_in:   number,
    A_out:  number,
    Q_feed = 0.0   // Q16: known liquid inflow into the node [m³/s] (running pump at the line start)
): JunctionResultN {
    let sum_inv_B = 0.0, sum_C_over_B = 0.0;
    for (const f of faces) { sum_inv_B += 1.0 / f.B; sum_C_over_B += f.C / f.B; }
    const a_coef   = dt * sum_inv_B;
    const b_coef   = V_old - dt * (sum_C_over_B + Q_feed);
    const vol = (H: number) => a_coef * H + b_coef;   // pocket volume at H
    const H_liquid = (sum_C_over_B + Q_feed) / sum_inv_B;
    const KC       = AIR_RT / (RHO_W * G);
    const air = (H: number) => Math.max(0, C_air + dt * KC * AIR_MASS_FLOW(H - Z + H_BARO, A_in, A_out));
    const gap = (H: number) => (H - Z + H_BARO) * vol(H) - air(H);

    let H: number, V_g: number, C: number;
    if (V_old <= 0 && C_air <= 0 && H_liquid >= Z) {
        H = H_liquid; V_g = 0; C = 0;                          // closed, full of liquid
    } else {
        const H_zero = -b_coef / a_coef;                       // head at which the pocket volume is 0
        const H_vap  = Z + VAPOR_H_REL;
        let lo = Math.max(H_zero, H_vap);
        if (gap(lo) >= 0) {
            if (H_zero >= H_vap) { H = H_liquid; V_g = 0; C = 0; }    // air vented, valve closes
                                                                       // (liquid state, as DGCM collapse)
            else { H = H_vap; V_g = vol(H_vap); C = air(H_vap); }    // vapour fills the rest
        } else {
            let hi = Math.max(lo, Z) + AIR_BRACKET_M;
            while (gap(hi) < 0) hi = lo + AIR_BRACKET_GROW * (hi - lo);
            for (let k = 0; k < AIR_BISECT_ITERS; k++) {
                const mid = 0.5 * (lo + hi);
                if (gap(mid) < 0) lo = mid; else hi = mid;
            }
            H = 0.5 * (lo + hi); V_g = vol(H); C = air(H);
        }
    }
    const Q = faces.map(f => (f.incoming ? (f.C - H) / f.B : (H - f.C) / f.B));
    return { H, V_g, C_gas: C, Q };
}

/** Q14: map each air valve to its nearest mesh node (x as in the result nodes). An end node is
 *  accepted (ruling 3): runCore lets it act while that end is a dead end (pump stopped / valve
 *  shut) and (Q16) at the line start while the built-in-curve pump runs; at a constant-head
 *  reservoir the head is fixed, so the valve has no effect there. */
function AIR_VALVE_NODES(
    layout: MeshLayout, airValves: AirValveBC[]
): Map<number, { A_in: number; A_out: number }> {
    const xs: number[] = [0];
    for (const p of layout.pipeParams) for (let i = 0; i < p.N; i++) xs.push(xs[xs.length - 1] + p.dx);
    const out = new Map<number, { A_in: number; A_out: number }>();
    const area = (mm: number) => Math.PI * (mm / 1000) ** 2 / 4;
    for (const v of airValves) {
        if (![v.x, v.inlet_mm, v.outlet_mm].every(Number.isFinite) || !(v.inlet_mm > 0) || !(v.outlet_mm > 0)) {
            throw new Error(`Air valve at x=${v.x}: position and orifice sizes must be finite, sizes > 0.`);
        }
        let idx = 0;
        for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i] - v.x) < Math.abs(xs[idx] - v.x)) idx = i;
        if (out.has(idx)) throw new Error(`Air valve at x=${v.x}: a second air valve on the same mesh node.`);
        out.set(idx, { A_in: area(v.inlet_mm), A_out: area(v.outlet_mm) });
    }
    return out;
}

/** Q14: segment volume dx·A of each mesh node (a junction: the smaller of its pipes, as V_max). */
function NODE_SEGMENT_VOLUMES(layout: MeshLayout): Float64Array {
    const cap = new Float64Array(layout.totalNodes).fill(Infinity);
    layout.pipeParams.forEach((p, pi) => {
        for (const idx of layout.nodeIds[pi]) cap[idx] = Math.min(cap[idx], p.dx * p.A);
    });
    return cap;
}

const PUMP_STOP_ALPHA = 0.001;   // α below which the pump is stopped, check valve shut (DOMAIN §5)

/** Pump deceleration factor α(t): 1 → 0 over [tripTime, haltTime] (DOMAIN §5). */
function PUMP_ALPHA(pump: PumpParams, t: number): number {
    return t > pump.tripTime
        ? Math.max(0.0, 1.0 - (t - pump.tripTime) / (pump.haltTime - pump.tripTime)) : 1.0;
}

// ── 7c: Pump boundary (left end, node 0) ─────────────────────────────────────
/** SECTION 7c: the built-in pump curve α²·Hs − k·Q² = H (DOMAIN §5), Hs = HS_FACTOR·steadyHead,
 *  k = Hs/Qmax², Qmax = QMAX_FACTOR·Q0 — the one place it is defined (CALC_BC_PUMP_DGCM, PUMP_TRIP_Q_AT). */
function PUMP_TRIP_CURVE(pump: PumpParams, steadyHead: number): { Hs: number; k: number } {
    const Hs = HS_FACTOR * steadyHead, Qmax = QMAX_FACTOR * pump.initialFlow;
    return { Hs, k: Hs / (Qmax * Qmax) };
}

/** SECTION 7c (Q16): built-in curve flow at a known discharge head H [m³/s], check valve: Q ≥ 0.
 *  Feeds the line-start air valve while the built-in-curve pump runs (runCore, SECTION 7g). */
function PUMP_TRIP_Q_AT(pump: PumpParams, steadyHead: number, alpha: number, H: number): number {
    const { Hs, k } = PUMP_TRIP_CURVE(pump, steadyHead);
    const hd = alpha * alpha * Hs - H;
    return hd > 0.0 ? Math.sqrt(hd / k) : 0.0;
}

/**
 * BOX: CALC_BC_PUMP_DGCM
 *
 * INPUT
 *   idx         must be 0
 *   coefs       CharCoefs at 0 — only Cm and B2 are used (no upstream pipe)
 *   prevState, newState, grid
 *   pump        PumpParams
 *   steadyHead  steady-state pump head [m]
 *   t           current simulation time [s]
 *   pipe        first pipe PipeParams (for V_max and B)
 *
 * TWO MODES based on deceleration factor α = f(t):
 *
 * ── RUNNING (α ≥ 0.001) ────────────────────────────────────────────────────
 *   Pump curve (parabolic): H_pump = α²·Hs − k_pump·Q_in²
 *   v7 single-pass decision (DOMAIN §5, NO Newton): solve the liquid quadratic,
 *   then branch on H_liq ≥ H_vap (liquid) vs H_liq < H_vap (cavitation at H_vap).
 *   Net cavity inflow = Q_out_pipe − Q_in_pump  (net-outflow, DC-4).
 *
 * ── STOPPED (α < 0.001): check valve closed, Q_in = 0 ─────────────────────
 *   Single C− characteristic: a_coef = +dt/B,  b_coef = V_g_old − dt·Cm/B
 *   H_fallback = Cm  (from C− with Q = 0)
 */
function CALC_BC_PUMP_DGCM(
    idx:        number,
    coefs:      CharCoefs,
    prevState:  SystemState,
    newState:   SystemState,
    newFlow:    FlowState,
    grid:       GridParams,
    pump:       PumpParams,
    steadyHead: number,
    t:          number,
    pipe:       PipeParams
): void {
    const { Cm, B2 } = coefs;
    const B       = B2;
    const dt      = grid.dt;
    const C_gas   = prevState.C_gas[idx];
    const Z       = prevState.Z[idx];
    const V_g_old = prevState.V_g[idx];
    const V_max   = pipe.dx * pipe.A;

    // Deceleration factor α: 1 → 0 over [tripTime, haltTime]
    const alpha = PUMP_ALPHA(pump, t);

    if (alpha < PUMP_STOP_ALPHA) {
        // ── STOPPED: pump off, check valve closed upstream of node 0 ──────────
        //
        // PHYSICAL MODEL: dead-end node with a possible gas cavity (DGCM).
        //
        //   Geometry:    [dead pump] ==X check valve==> [ node 0 cavity | pipe ... ]
        //                                               ^^^^^^^^^^^^^^^
        //                                              closed wall on the left,
        //                                              gas cavity inside,
        //                                              pipe water column on the right
        //
        //   Boundary enforcement at node 0:
        //     • Q_in  ≡ 0          — check valve blocks flow on the pump-side face.
        //     • Q_out = (H − Cm)/B — SIGNED flow at the cavity ↔ pipe face. The
        //                            check valve does NOT gate this face. Negative
        //                            Q_out means the water column is pushing back
        //                            into the cavity (compression wave arriving).
        //     • dV_g  = dt·(Q_out − Q_in) = dt·Q_out
        //              Q_out > 0  ⇒  cavity grows   (liquid leaves, gas expands)
        //              Q_out < 0  ⇒  cavity shrinks (liquid enters, gas compresses)
        //
        //   Bounds handled by the quadratic + vapor floor + V_max clip:
        //     • V_g → 0      : collapsed → solid column against closed valve.
        //                      Closed-end reflection: Q_out = 0 ⇒ H = Cm.
        //     • V_g → V_max  : full column separation → V_g clipped to dx·A.
        //     • H < H_vap    : active cavitation → pin H = H_vap, reconcile V_g.
        //
        //   This is mathematically the interior DGCM node with 1/B1 = 0 (no
        //   upstream pipe) and Q_in forced to 0. Same quadratic, same vapor
        //   floor, same V_max clip — nothing is permanently sealed, and the
        //   node reacts correctly to every incoming C− characteristic,
        //   including compression waves that must collapse the cavity.

        const H_vap     = Z + VAPOR_H_REL;
        const H_abs_vap = H_BARO + VAPOR_H_REL;

        // DGCM with Q_in = 0 and single C−:
        //   V_g = V_g_old + dt·Q_out = V_g_old + dt·(H − Cm)/B = a·H + b
        const a_coef    = +dt / B;
        const b_coef    = V_g_old - dt * Cm / B;
        const H_liquid  = Cm;   // closed-end liquid fallback (Q_out = 0 ⇒ H = Cm)

        let H        = SOLVE_DGCM_QUADRATIC(a_coef, b_coef, C_gas, Z, H_liquid);
        let V_g      = a_coef * H + b_coef;
        let C_gas_new = C_gas;

        if (V_g <= 0.0) {
            // Collapsed → solid column against closed valve → closed-end BC.
            // Keep C_gas at its last vapor-floor value (suppresses phantom
            // cavitation under subsequent high pressure).
            H   = H_liquid;
            V_g = 1e-12;
            if (H < H_vap) H = H_vap;   // vapor floor safety
        } else if (H < H_vap) {
            // Active cavitation: pin H at H_vap, reconcile V_g via mass balance.
            H   = H_vap;
            V_g = a_coef * H_vap + b_coef;
            if (V_g <= 0.0) {
                V_g = 1e-12;
            } else {
                if (V_g > V_max) V_g = V_max;
                C_gas_new = H_abs_vap * V_g;   // update gas constant at vapor floor
            }
        } else {
            // Cavity present, above vapor (partial collapse): clip to geometry.
            if (V_g > V_max) V_g = V_max;
        }

        // Q_out from C−: SIGNED, unclamped. The check valve role is already
        // enforced by Q_in = 0; Q_out is the cavity-face flow and MUST be
        // free to go negative so returning compression waves can collapse
        // the cavity (otherwise node 0 freezes at H_vap forever — v4 bug).
        newState.H[idx]     = H;
        newFlow.setQin(idx, 0.0);             // W5: check valve closed → pump face = 0 (qPumpFace)
        newFlow.setQout(idx, (H - Cm) / B);   // W5: cavity↔pipe face — SIGNED, unclamped (DOMAIN §6) → qL[0][0]
        newState.V_g[idx]   = V_g;
        newState.C_gas[idx] = C_gas_new;

    } else {
        // ── RUNNING (variant B: v7 single-pass, DC-5 compliant) ────────────────
        // L087 SHADOW PORT: this block is the EXACT root solver.ts v7 single-pass
        // algorithm (root MOC Solver/solver.ts lines 788-878), re-keyed ONLY from
        // node-indexed writes (newState.Q_in/Q_out[idx]) to the I6 FlowState API
        // (newFlow.setQin/setQout). No Newton, no pumpGasCavityActive flag.
        // Single deterministic H_liq >= H_vap regime decision (DOMAIN §5 / Bug #8).
        //
        // Q10: a user curve takes its own branch (SECTION 7c.1); without one, everything below is
        // unchanged byte for byte (pump trip, no-curve pump-fed valve, Q6-f).
        if (pump.curve !== undefined) {
            CALC_BC_PUMP_CURVE(idx, coefs, prevState, newState, newFlow, grid, pump.curve, alpha, pipe);
            return;
        }
        //
        //   Step 1 — Liquid solution: k_pump·Q² + B·Q + (Cm − α²·Hs) = 0, take Q >= 0.
        //   Step 2 — Regime: H_liq >= H_vap → LIQUID (H = H_liq, V_g reset to 1e-12);
        //            else → CAVITATION (H pinned at H_vap; DGCM mass balance on V_g).
        const { Hs, k: k_pump } = PUMP_TRIP_CURVE(pump, steadyHead);

        const H_vap     = Z + VAPOR_H_REL;
        const H_abs_vap = H_BARO + VAPOR_H_REL;

        // ── Step 1: liquid solution (pump curve + C−) ──────────────────────
        // k·Q² + B·Q + (Cm − α²·Hs) = 0.  Q_in >= 0 (check valve).
        const disc_liq = B * B - 4.0 * k_pump * (Cm - alpha * alpha * Hs);
        let H_liq = Cm, Q_in_liq = 0.0;
        if (disc_liq >= 0.0) {
            Q_in_liq = Math.max(0.0, (-B + Math.sqrt(disc_liq)) / (2.0 * k_pump));
            H_liq    = Cm + B * Q_in_liq;
        }

        if (H_liq >= H_vap) {
            // ── LIQUID state: pump sustains head above vapor ──────────────
            // No cavity. Reset V_g to seed. C_gas preserved for later cavitation.
            newState.H[idx]     = H_liq;
            newFlow.setQin(idx, Q_in_liq);                          // pump face (qPumpFace)
            newFlow.setQout(idx, Math.max(0.0, (H_liq - Cm) / B));  // cavity↔pipe face → qL[0][0]
            //   ^ max(0,·) is a NO-OP here (auditor minor-2): (H_liq−Cm)/B == Q_in_liq ≥ 0 by the Step-1
            //     check-valve clamp (H_liq = Cm + B·Q_in_liq, Q_in_liq ≥ 0). Retained for symmetry with
            //     the cavitation face; never clamps the liquid-state cavity face (DOMAIN §6 unaffected).
            newState.V_g[idx]   = 1e-12;
            newState.C_gas[idx] = C_gas;
            return;
        }

        // ── CAVITATION state: H_liq < H_vap → pin H at vapor pressure ─────
        // Pump still runs (α > 0.001); Q_in from pump curve at H = H_vap.
        // Q_out is the cavity↔pipe face — SIGNED, unclamped. Mass balance at H_vap.
        const hd_vap    = alpha * alpha * Hs - H_vap;
        const Q_in_vap  = hd_vap > 0.0 ? Math.sqrt(hd_vap / k_pump) : 0.0;
        const Q_out_vap = (H_vap - Cm) / B;
        let V_g = V_g_old + dt * (Q_out_vap - Q_in_vap);
        let C_gas_new = C_gas;

        if (V_g <= 1e-12) {
            // Cavity collapsed during running branch. Reset seed; keep H at H_vap
            // for this step — next step's H_liq decides regime.
            V_g = 1e-12;
        } else {
            if (V_g > V_max) V_g = V_max;
            C_gas_new = H_abs_vap * V_g;   // gas constant locked to vapor-floor state
        }

        newState.H[idx]     = H_vap;
        newFlow.setQin(idx, Q_in_vap);     // pump face (qPumpFace)
        newFlow.setQout(idx, Q_out_vap);   // cavity face — SIGNED (DOMAIN §6) → qL[0][0]
        newState.V_g[idx]   = V_g;
        newState.C_gas[idx] = C_gas_new;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 7c.1 — CALC_BC_PUMP_CURVE  (user pump curve, running branch — Q10, DOMAIN §15)
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Running branch of CALC_BC_PUMP_DGCM when `pump.curve` is set. Same v7 single-pass shape (no
 * Newton, DOMAIN §5/§8, L098), with the Q6-h three-way pump flow rule (DOMAIN §15 (ix)):
 *   Cm + B·Q_r ≤ H_suct      → Q = Q_r (run-out, head rise ≤ 0), H = Cm + B·Q_r
 *   Cm ≥ H_suct + α²·c       → Q = 0 (check valve shut, §15 (xi)), H = Cm
 *   otherwise                → (−a)·Q² + P·Q − R = 0, Q = 2R/(P + sqrt(P² + 4(−a)R)), H = Cm + B·Q
 * Q is continuous across both switches. Then H ≥ H_vap → liquid; else cavitation at H_vap with
 * Q_in = Q_pump(H_vap − H_suct) and the DGCM mass balance exactly as SECTION 7c's running branch.
 * Never stops the run (§15 (x)).
 */
function CALC_BC_PUMP_CURVE(
    idx:       number,
    coefs:     CharCoefs,
    prevState: SystemState,
    newState:  SystemState,
    newFlow:   FlowState,
    grid:      GridParams,
    curve:     PumpCurve,
    alpha:     number,
    pipe:      PipeParams
): void {
    const B         = coefs.B2;
    const Cm        = coefs.Cm;
    const dt        = grid.dt;
    const C_gas     = prevState.C_gas[idx];
    const V_g_old   = prevState.V_g[idx];
    const V_max     = pipe.dx * pipe.A;
    const H_vap     = prevState.Z[idx] + VAPOR_H_REL;
    const H_abs_vap = H_BARO + VAPOR_H_REL;
    const H_suct    = curve.H_suct;
    const shutOff   = alpha * alpha * curve.c;
    const Q_r       = pumpRunOutFlow(curve, alpha);

    // ── Step 1: liquid solution (user curve + C−), three-way rule ──────────────
    let Q_liq: number;
    if (Cm + B * Q_r <= H_suct) {
        Q_liq = Q_r;                                  // run-out (Δ ≤ 0)
    } else if (Cm >= H_suct + shutOff) {
        Q_liq = 0.0;                                  // check valve shut (Δ ≥ α²·c)
    } else {
        const P = B - alpha * curve.b;                // > 0 (b ≤ 0)
        const R = H_suct + shutOff - Cm;              // > 0 in this case
        Q_liq = 2.0 * R / (P + Math.sqrt(P * P + 4.0 * (-curve.a) * R));
    }
    const H_liq = Cm + B * Q_liq;

    if (H_liq >= H_vap) {
        // ── LIQUID: as SECTION 7c running branch ───────────────────────────────
        newState.H[idx]     = H_liq;
        newFlow.setQin(idx, Q_liq);                   // pump face (qPumpFace)
        newFlow.setQout(idx, (H_liq - Cm) / B);       // cavity↔pipe face = Q_liq ≥ 0
        newState.V_g[idx]   = 1e-12;
        newState.C_gas[idx] = C_gas;
        return;
    }

    // ── CAVITATION: H pinned at H_vap; pump flow by the Q6-h rule ─────────────
    const Q_in_vap  = pumpFlowAtHeadRise(curve, alpha, H_vap - H_suct);
    const Q_out_vap = (H_vap - Cm) / B;               // SIGNED (DOMAIN §6)
    let V_g = V_g_old + dt * (Q_out_vap - Q_in_vap);  // DC-4 net-outflow
    let C_gas_new = C_gas;
    if (V_g <= 1e-12) {
        V_g = 1e-12;
    } else {
        if (V_g > V_max) V_g = V_max;
        C_gas_new = H_abs_vap * V_g;                  // gas constant locked to vapor-floor state
    }
    newState.H[idx]     = H_vap;
    newFlow.setQin(idx, Q_in_vap);
    newFlow.setQout(idx, Q_out_vap);
    newState.V_g[idx]   = V_g;
    newState.C_gas[idx] = C_gas_new;
}

// ── 7d: Reservoir boundary (right end, last node) ────────────────────────────
/**
 * BOX: CALC_BC_RESERVOIR
 *
 * INPUT
 *   idx    last node index (totalNodes − 1)
 *   coefs  CharCoefs — only Cp and B1 used (no downstream pipe)
 *   prevState, newState
 *   H_res  fixed reservoir head [m]
 *
 * OUTPUT
 *   H[idx]    = H_res  (constant-head enforcement)
 *   Q_in[idx] = (Cp − H_res) / B1   (flow arriving from pipe)
 *   Q_out[idx] = Q_in[idx]           (no downstream pipe — convention)
 *   V_g[idx]  = unchanged            (reservoir has no gas cavity)
 */
function CALC_BC_RESERVOIR(
    idx:       number,
    coefs:     CharCoefs,
    prevState: SystemState,
    newState:  SystemState,
    newFlow:   FlowState,
    H_res:     number
): void {
    const { Cp, B1 } = coefs;
    newState.H[idx]     = H_res;
    newFlow.setQin(idx, (Cp - H_res) / B1);   // W9: flow arriving from pipe → qR[lastPipe][N−1]
    // Q_out[last] is a convention alias (= Q_in[last], W9); reconstructed on read by
    // FlowState.nodeQout's lastNode branch (design §3.1/§4.5). No independent slot stored.
    newState.V_g[idx]   = prevState.V_g[idx];
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 8 — UPDATE_MIAB_STATE  (DEAD — node-indexed legacy; superseded by UPDATE_MIAB_STATE_PIPE)
// ═══════════════════════════════════════════════════════════════════════════════
//
// ⚠ DEAD CODE (S37): the production loop calls UPDATE_MIAB_STATE_PIPE (b+ per-pipe, R10), NOT this
// function. Retained as the node-indexed reference only. Its startNode≤n scan re-collapses a junction
// node onto the downstream sibling's flow — the exact §4.3 "legacy mixing" R10 fixed. DO NOT re-wire.
//
/**
 * BOX: UPDATE_MIAB_STATE — advance all MIAB filter states one timestep  [DEAD — see banner above]
 *
 * INPUT
 *   pipes      array of Pipe bundles (one per input pipe section)
 *   prevState  hydraulic state at t_n  (Q_out values used as "current Q")
 *   miabState  MIAB state at t_{n−1}   (mutated in-place to t_n values)
 *   grid       { dt }
 *   totalNodes total node count
 *
 * OUTPUT  miabState mutated:
 *   z[k][i] updated for all k, i
 *   Q_prev  ← prevState.Q_out  (becomes "previous Q" for next step)
 *
 * PER-NODE EQUATIONS (explicit backward-Euler on acceleration)
 *   accel = (Q_out[i] − Q_prev[i]) / (A · dt)             [m/s²]
 *   decay_k = exp(−alpha[k] · dt)
 *   z[k][i] = decay_k · z[k][i]  +  weight[k]·(1−decay_k)·accel
 *
 * MIAB is keyed to the pipe that contains node i.
 * Boundary nodes 0 and totalNodes−1 use the first and last pipe respectively.
 */
function UPDATE_MIAB_STATE(
    pipes:      Pipe[],
    prevState:  SystemState,
    prevFlow:   FlowState,
    miabState:  MIABState,
    grid:       GridParams,
    totalNodes: number
): void {
    const dt = grid.dt;

    for (let i = 0; i < totalNodes; i++) {
        // Identify which pipe owns this node (for area and MIAB params)
        let pipe = pipes[0];
        for (let pi = pipes.length - 1; pi >= 0; pi--) {
            if (i >= pipes[pi].p.startNode) { pipe = pipes[pi]; break; }
        }

        const A     = pipe.p.A;
        const miab  = pipe.miab;
        const Q_cur = prevFlow.nodeQout(i);   // R5: = old prevState.Q_out[i]
        const Q_prv = miabState.Q_prev[i];
        const accel = (Q_cur - Q_prv) / (A * dt);   // [m/s²]

        for (let k = 0; k < MIAB_M; k++) {
            const decay        = Math.exp(-miab.alpha[k] * dt);
            miabState.z[k][i]  = decay * miabState.z[k][i]
                                + MIAB_WEIGHTS[k] * (1.0 - decay) * accel;
        }
    }

    // Shift Q_prev for next timestep (R6: reassemble the exact per-node Q_out array v15.5 copied)
    miabState.Q_prev.set(reassembleQout(prevFlow, totalNodes));
}

/**
 * BOX: UPDATE_MIAB_STATE_PIPE — per-pipe b+ MIAB update (D3, DESIGN §4.1).
 * Replaces the node-indexed startNode scan with pipe-local offset addressing.
 * Each pipe p is walked offset 0..N_p; MIAB uses pipeMIAB[p]'s own history.
 */
function UPDATE_MIAB_STATE_PIPE(
    pipes:     Pipe[],
    prevFlow:  FlowState,
    pipeMIAB:  PipeMIABState[],
    grid:      GridParams
): void {
    const dt = grid.dt;
    for (let p = 0; p < pipes.length; p++) {
        const pipe = pipes[p];
        const pm   = pipeMIAB[p];
        const A    = pipe.p.A;
        const miab = pipe.miab;
        for (let o = 0; o <= pipe.p.N; o++) {
            const Q_cur = pipeOwnQout(prevFlow, p, pipe.p.N, o);   // R10: this pipe's own flow (no junction collapse)
            const Q_prv = pm.Qprev[o];
            const accel = (Q_cur - Q_prv) / (A * dt);
            for (let k = 0; k < MIAB_M; k++) {
                const decay  = Math.exp(-miab.alpha[k] * dt);
                pm.z[k][o]   = decay * pm.z[k][o] + MIAB_WEIGHTS[k] * (1.0 - decay) * accel;
            }
        }
    }
    // Shift Qprev (R10: this pipe's own flow at each offset, no junction collapse)
    for (let p = 0; p < pipes.length; p++) {
        const pm = pipeMIAB[p];
        const N  = pipes[p].p.N;
        for (let o = 0; o <= N; o++) {
            pm.Qprev[o] = pipeOwnQout(prevFlow, p, N, o);
        }
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 9 — INIT_STEADY_STATE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * BOX: INIT_STEADY_STATE
 *
 * INPUT
 *   state  SystemState to initialise (H, Q_in, Q_out, V_g, C_gas assumed zeroed)
 *   pipes  meshed PipeParams
 *   pump   PumpParams
 *   res    ReservoirParams
 *
 * OUTPUT
 *   state mutated to steady-state hydraulics
 *   returns steadyPumpHead [m]
 *
 * HEAD PROFILE
 *   H decreases from pump to reservoir, losing f·dx·V²/(2·g·D) per element.
 *   Pump head = reservoir.head + total friction loss (energy balance).
 *
 * GAS INITIALISATION
 *   V_g[i]   = ALPHA_G0 · dx · A   (uniform tiny void fraction)
 *   C_gas[i] = (H[i] − Z[i] + H_BARO) · V_g[i]   (isothermal gas constant)
 */
function INIT_STEADY_STATE(
    state: SystemState,
    flow:  FlowState,
    pipes: PipeParams[],
    pump:  PumpParams,
    res:   ReservoirParams
): number {
    const Q0 = pump.initialFlow;

    // W1/W2 (Option B): steady flow = Q0 at every pipe-end face + the pump face.
    // A single constant → bit-identical regardless of fill order (no arithmetic; design §4.7).
    flow.qPumpFace = Q0;
    for (let p = 0; p < flow.qL.length; p++) { flow.qL[p].fill(Q0); flow.qR[p].fill(Q0); }

    // Total friction loss (all pipes combined)
    const totalLoss = pipes.reduce((acc, p) => {
        const v = Q0 / p.A;
        return acc + (p.f * p.dx * p.N * v * v) / (2.0 * G * p.D);
    }, 0.0);
    const pumpHead = res.head + totalLoss;

    // Node 0 — pump discharge
    state.H[0]     = pumpHead;
    const V_g0     = ALPHA_G0 * pipes[0].dx * pipes[0].A;
    state.V_g[0]   = V_g0;
    state.C_gas[0] = (pumpHead - state.Z[0] + H_BARO) * V_g0;

    let node = 1;
    let H    = pumpHead;

    for (const p of pipes) {
        const v         = Q0 / p.A;
        const dH_per_dx = (p.f * p.dx * v * v) / (2.0 * G * p.D);
        const V_g_dx    = ALPHA_G0 * p.dx * p.A;

        for (let i = 0; i < p.N; i++) {
            H -= dH_per_dx;
            state.H[node]     = H;
            state.V_g[node]   = V_g_dx;
            state.C_gas[node] = (H - state.Z[node] + H_BARO) * V_g_dx;
            node++;
        }
    }

    return pumpHead;
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 9.5 — NETWORK SCHEMA + LEGACY ADAPTER + GRAPH MESHING  (Phase 2.5.3 / I3)
// ═══════════════════════════════════════════════════════════════════════════════
//
// EPANET-style connectivity schema (spec §3a.1), the fork-and-regress legacy adapter
// (§3a.2; DECISIONS 2026-06-09 — F1 closure), and a graph-meshing layer (§3a.3–§3a.6)
// that produces the node layout the main solver consumes. For the linear PipeSection[]
// path (routed via legacyToNetwork) the meshing REDUCES BIT-IDENTICALLY to the former
// inline meshing (old 10a/10b) — every arithmetic expression below is copied
// token-for-token from that code; node indices are integers (exact equality, no FP
// tolerance). Verified by the zero-tolerance regression gate (DOMAIN §11). The
// 1-trunk-2-branch instance (spec §5) meshes to the §5 node counts but is NOT simulated
// here (the N-face junction is I4); a branch's node block is non-contiguous when its
// junction node is shared (spec §3a.4) — layout-only, inert in I3.

/** EPANET node (spec §3a.1). `head` is the HGL water-surface elevation — required for reservoir nodes. */
export interface NetworkNode {
    id:        string;
    type:      'pump' | 'junction' | 'reservoir';
    elevation: number;            // m (node elevation Z)
    head?:     number;            // m (HGL) — required for reservoir nodes
}

/** EPANET pipe (spec §3a.1). `from`/`to` reference NetworkNode.id. */
export interface NetworkPipe {
    id:             string;
    from:           string;
    to:             string;
    length:         number;       // m
    diameter:       number;       // m
    waveSpeed:      number;       // m/s
    frictionFactor: number;       // Darcy-Weisbach f
}

/** EPANET network input (spec §3a.1). Pump references a node by id (top-level field, §7).
 *  pump.initialHead is a UI-only no-op (DECISIONS 2026-05-06) and is intentionally absent. */
export interface NetworkInput {
    nodes: NetworkNode[];
    pipes: NetworkPipe[];
    pump:  { node: string; initialFlow: number; tripTime: number; haltTime: number };
}

/**
 * Meshing product (Section 9.5 — spec §3a.3–§3a.6): the node layout the main solver consumes.
 *
 *   pipeParams[p] / miab[p] : per-pipe hydraulic + Vardy-Brown params (pipe order = graph-walk order)
 *   totalNodes              : node count, graph-derived (NOT hardcoded; §3a.4)
 *   Z                       : per-node elevation, interpolated along each pipe (§3a.5)
 *   baseDt                  : grid timestep from the pump-attached pipe (Courant=1, DOMAIN §2)
 *   startNode[p]            : index of pipe p's `from` node (== pipeParams[p].startNode)
 *   numSegments[p]          : MOC element count of pipe p (== pipeParams[p].N)
 *   pumpNode                : index of the pump node (= startNode of the trunk = 0)
 *   reservoirNodes[]        : node index of each reservoir node
 *   ownerPipe[n]            : MIAB owning pipe of node n (§3a.6) — PHYSICAL ownership: the pipe
 *                             that allocated node n (interior/`to` nodes → that pipe; a junction
 *                             node → its incoming pipe; pump node → trunk). Descriptive only — the
 *                             linear sim uses UPDATE_MIAB_STATE's own startNode scan (Section 8),
 *                             which differs from this map ONLY at junction nodes (scan→downstream,
 *                             this→incoming per the §3a.6 recommendation; for I4's N-face calc).
 */
export interface MeshLayout {
    pipeParams:     PipeParams[];
    miab:           MIABPipeParams[];
    totalNodes:     number;
    Z:              Float64Array;
    baseDt:         number;
    startNode:      number[];
    numSegments:    number[];
    pumpNode:       number;
    reservoirNodes: number[];
    ownerPipe:      Int32Array;
    nodeIds:        number[][];       // [p][o]: global node index at local offset o of pipe p (o=0..N_p)
    // Dual node→(pipe,offset) inverse maps (E3′, S37 — DESIGN §2.1; resolves L064 + the Qin/Qout
    // convention split at shared junctions). Packed value = p*ntoStride + o; decode p=floor(x/stride),
    // o=x%stride. Sentinel −1.
    qoutSlot:       Int32Array;       // node → LEFT/segment-start end (offsets 0..N−1). −1 = reservoir
                                      //        terminal (no outgoing segment) ⇒ nodeQout aliases nodeQin (W9)
    qinSlot:        Int32Array;       // node → RIGHT/segment-end end (offsets 1..N). −1 = pure source
                                      //        (pump node 0) ⇒ nodeQin returns qPumpFace
    ntoStride:      number;           // stride for qoutSlot/qinSlot encoding (= max N_p + 1)
    // Graph-traversal structures (E5′, S37 — DESIGN §3.2/§6). Built from adjacency in meshNetwork.
    junctions:      { node: number; incoming: number[]; outgoing: number[] }[]; // degree≥2 interior nodes;
                                      // incoming/outgoing hold PIPE INDICES (to==node / from==node)
    reservoirIncidentPipe: number[];  // aligned with reservoirNodes[]: pipe index whose `to` maps to that node
}

/**
 * BOX: legacyToNetwork — the fork-and-regress seam (spec §3a.2; DECISIONS 2026-06-09 F1 closure).
 *
 * Maps the ordered PipeSection[] to a linear-chain EPANET graph: pump node `n0` → one junction
 * node `j{k}` per inter-pipe boundary → terminal reservoir node `res`. PURE restructuring — every
 * geometry number is copied verbatim (no arithmetic), so the mesher sees identical operands and the
 * regression gate stays bit-identical (design §5.2). pump.elevation → pump-node elevation (§3a.5);
 * reservoir.head → reservoir-node head.
 */
export function legacyToNetwork(
    pipes:     PipeSection[],
    pump:      PumpParams,
    reservoir: ReservoirParams
): NetworkInput {
    const nodes:    NetworkNode[] = [{ id: 'n0', type: 'pump', elevation: pump.elevation }];
    const netPipes: NetworkPipe[] = [];

    for (let k = 0; k < pipes.length; k++) {
        const sec    = pipes[k];
        const fromId = nodes[k].id;                       // nodes[k] is pipe k's `from` (prev pipe's `to`)
        const isLast = k === pipes.length - 1;
        const toId   = isLast ? 'res' : `j${k + 1}`;
        nodes.push(
            isLast
                ? { id: toId, type: 'reservoir', elevation: sec.endElevation, head: reservoir.head }
                : { id: toId, type: 'junction',  elevation: sec.endElevation }
        );
        netPipes.push({
            id: sec.id, from: fromId, to: toId,
            length: sec.length, diameter: sec.diameter,
            waveSpeed: sec.waveSpeed, frictionFactor: sec.frictionFactor
        });
    }

    return {
        nodes,
        pipes: netPipes,
        pump:  { node: 'n0', initialFlow: pump.initialFlow, tripTime: pump.tripTime, haltTime: pump.haltTime }
    };
}

/**
 * BOX: meshNetwork — graph meshing / node-range allocation / elevation / MIAB ownership
 * (spec §3a.3–§3a.6).
 *
 * Walks the graph from the pump node along from→to edges; for a linear chain the walk is input
 * order and the meshing reduces BIT-IDENTICALLY to the former inline 10a/10b (arithmetic copied
 * token-for-token). Node-range allocation shares junction nodes (§3a.4): a pipe's `from` reuses an
 * already-meshed index, and N new interior/`to` indices are allocated — so a branch whose `from` is
 * a shared junction has a non-contiguous node set (e.g. {J} ∪ {block}). Interior-node elevation is
 * interpolated between the pipe's endpoint node elevations (§3a.5).
 *
 * `collect` (Row 3.11 Unit B, S67 — `SESSION-PLAN` D2). SECTION 9.9's contract check is the ONE
 * guard on the gate's path that cannot be evaluated from raw inputs: it needs the meshed per-segment
 * `Re`. Supply `collect` and it REPORTS instead of throwing; OMIT it — which is every existing
 * caller — and it throws exactly as before, same message, same place. One optional parameter, not a
 * mode system. The rejected alternative was for the gate to try/catch and parse the check code back
 * out of the thrown prose: that yields only the first failure and breaks silently the next time
 * wording changes, which is the defect this whole split exists to avoid.
 *
 * NOTE what a supplied `collect` means for the RETURN value: meshing continues past a reported
 * finding, so the layout is built on MIAB coefficients frozen at an out-of-contract `Re`. That is
 * intended — the caller is a gate that blocks on the finding and never runs the transient — but the
 * layout is evidence of the fault, not a usable mesh. Do not add a non-gate caller that passes
 * `collect` and then uses the result.
 */
export function meshNetwork(net: NetworkInput, collect?: (f: GateFinding) => void): MeshLayout {

    const byId = new Map<string, NetworkNode>();
    for (const n of net.nodes) byId.set(n.id, n);

    // ── Pipe ordering: BFS from the pump node along from→to edges (§3a.3 / §4.1) ──────────
    const adjacency = new Map<string, NetworkPipe[]>();
    for (const pipe of net.pipes) {
        if (!adjacency.has(pipe.from)) adjacency.set(pipe.from, []);
        adjacency.get(pipe.from)!.push(pipe);
    }
    const ordered:  NetworkPipe[] = [];
    const seenPipe  = new Set<string>();
    const seenNode  = new Set<string>([net.pump.node]);
    const queue:    string[]      = [net.pump.node];
    while (queue.length > 0) {
        const nodeId = queue.shift()!;
        for (const pipe of adjacency.get(nodeId) ?? []) {
            if (seenPipe.has(pipe.id)) continue;
            seenPipe.add(pipe.id);
            ordered.push(pipe);
            if (!seenNode.has(pipe.to)) { seenNode.add(pipe.to); queue.push(pipe.to); }
        }
    }

    // baseDt from the pump-attached pipe (§3a.3; old solver.ts:1194 used inputPipes[0]).
    const pumpPipe = ordered[0];
    const baseDt   = pumpPipe.length / 20 / pumpPipe.waveSpeed;

    // ── Per-pipe mesh + node-range allocation (§3a.3 / §3a.4) ─────────────────────────────
    const nodeIndex = new Map<string, number>();
    nodeIndex.set(net.pump.node, 0);     // pump node pre-allocated as index 0
    let totalNodes = 1;                  // mirrors old solver.ts:1197 (let totalNodes = 1)

    const pipeParams:    PipeParams[]     = [];
    const miab:          MIABPipeParams[] = [];
    const startNode:     number[]         = [];
    const numSegments:   number[]         = [];
    const firstInterior: number[]         = [];   // first NEW node index of each pipe's interior/`to` block
    // Step 3.13 / S64: per-segment Re, collected for SECTION 9.9's contract check after the loop.
    // Collection only — no arithmetic here, nothing read back by the meshing itself (ADD-ONLY L068).
    const reBySegment: { id: string; D: number; Re: number }[] = [];

    for (const sec of ordered) {

        // Arithmetic copied token-for-token from old 10a (solver.ts:1201–1205):
        const N     = Math.max(1, Math.round(sec.length / (sec.waveSpeed * baseDt)));
        const dx    = sec.length / N;
        const a_adj = dx / baseDt;                                  // exact Courant = 1
        const A     = Math.PI * (sec.diameter / 2.0) ** 2;
        const Re    = (net.pump.initialFlow / A) * sec.diameter / NU_WATER;

        const sp = nodeIndex.get(sec.from)!;                        // startNode = index of the `from` node
        const pParams: PipeParams = {
            a: a_adj, A, D: sec.diameter,
            f: sec.frictionFactor, dx, N,
            startNode: sp
        };
        pipeParams.push(pParams);
        miab.push(COMPUTE_MIAB_PIPE_PARAMS(Re, NU_WATER, sec.diameter));
        reBySegment.push({ id: sec.id, D: sec.diameter, Re });      // Step 3.13 / S64 — see SECTION 9.9
        startNode.push(sp);
        numSegments.push(N);

        // Allocate N new node indices; the `to` node gets the last new index (shared on reuse).
        firstInterior.push(totalNodes);
        nodeIndex.set(sec.to, totalNodes + N - 1);
        totalNodes += N;
    }

    // Step 3.13 / S64: the unsteady-friction coefficients above were frozen at these Re values.
    // Refuse here, before any of them is consumed, if Re is outside the routine's own contract.
    // S67 (D2): with a collector supplied the same verdict is REPORTED rather than thrown.
    if (collect) { for (const f of FIND_MIAB_RE_CONTRACT(reBySegment, net.pump.initialFlow)) collect(f); }
    else ASSERT_MIAB_RE_CONTRACT(reBySegment, net.pump.initialFlow, 'meshNetwork');

    // ── Elevation (§3a.5) — interpolation copied token-for-token from old 10b ─────────────
    const Z = new Float64Array(totalNodes);
    Z[0] = byId.get(net.pump.node)!.elevation;                     // old solver.ts:1222 (OUTSIDE the loop)
    for (let p = 0; p < ordered.length; p++) {
        const sec    = ordered[p];
        const Np     = numSegments[p];
        const zStart = byId.get(sec.from)!.elevation;
        const zEnd   = byId.get(sec.to)!.elevation;
        for (let i = 1; i <= Np; i++) {
            // node = the i-th NEW index of this pipe's block (= startNode+i for a contiguous chain).
            Z[firstInterior[p] + i - 1] = zStart + (zEnd - zStart) * (i / Np);   // old solver.ts:1229
        }
    }

    // ── MIAB ownership (§3a.6) — PHYSICAL ownership: each node owned by its allocating pipe ──
    // Interior + `to` nodes of pipe p are owned by p; a junction node is the `to` of its incoming
    // pipe, so it is owned by that incoming pipe (the §3a.6 recommendation). The pump node (0,
    // pre-allocated, in no pipe block) is owned by the trunk. Descriptive only (the I3 linear sim
    // keeps using UPDATE_MIAB_STATE's own startNode scan, Section 8 — gate-locked, unchanged). NOTE:
    // for the linear junction the scan picks the DOWNSTREAM pipe, whereas this physical map picks the
    // INCOMING pipe; they differ only at junction nodes (§3a.6 recommendation, for I4's N-face calc).
    const ownerPipe = new Int32Array(totalNodes);   // pump node (0) defaults to trunk index 0
    for (let p = 0; p < ordered.length; p++) {
        for (let j = 0; j < numSegments[p]; j++) ownerPipe[firstInterior[p] + j] = p;
    }

    const reservoirNodes = net.nodes
        .filter(n => n.type === 'reservoir')
        .map(n => nodeIndex.get(n.id)!);

    // ── nodeIds (b+ MIAB, E1) ───────────────────────────────────────────────────────────────
    const nodeIds: number[][] = [];
    for (let p = 0; p < ordered.length; p++) {
        const ids: number[] = [startNode[p]];
        for (let o = 1; o <= numSegments[p]; o++) ids.push(firstInterior[p] + o - 1);
        nodeIds.push(ids);
    }

    // ── Dual inverse maps qoutSlot / qinSlot (E3′, S37 — DESIGN §2.1) ─────────────────────────
    // stride = max N_p + 1 ⇒ every offset 0..N_p encodes uniquely as p*stride+o.
    const ntoStride = Math.max(...numSegments) + 1;
    const qoutSlot = new Int32Array(totalNodes).fill(-1);   // −1 ⇒ reservoir terminal (W9 alias)
    const qinSlot  = new Int32Array(totalNodes).fill(-1);   // −1 ⇒ pure source (pump node)
    // Write pipe by pipe ASCENDING; last-write-wins at shared junction nodes reproduces the legacy
    // highest-pipe-first scan (DESIGN §2.1): Qout→outgoing pipe (offset 0), Qin→incoming pipe (offset N).
    for (let p = 0; p < ordered.length; p++) {
        for (let o = 0; o < numSegments[p]; o++) qoutSlot[nodeIds[p][o]] = p * ntoStride + o;   // segment-START ends
        for (let o = 1; o <= numSegments[p]; o++) qinSlot[nodeIds[p][o]]  = p * ntoStride + o;   // segment-END   ends
    }

    // ── Graph-traversal structures: junctions + reservoir-incident pipes (E5′, S37 — DESIGN §3.2/§6) ──
    const incomingPipes: number[][] = Array.from({ length: totalNodes }, () => []);
    const outgoingPipes: number[][] = Array.from({ length: totalNodes }, () => []);
    for (let p = 0; p < ordered.length; p++) {
        outgoingPipes[nodeIds[p][0]].push(p);                 // from-end ⇒ p flows OUT of this node
        incomingPipes[nodeIds[p][numSegments[p]]].push(p);    // to-end   ⇒ p flows INTO this node
    }
    // Interior junction = a node with ≥1 incoming AND ≥1 outgoing pipe-end (degree≥2; not pump root,
    // not reservoir leaf). Node-index order (intra-step order is numerically inert, DESIGN §3.1; for a
    // linear chain this equals pipe order ⇒ bit-identical FP-operand sequence vs the old loop).
    const junctions: { node: number; incoming: number[]; outgoing: number[] }[] = [];
    for (let n = 0; n < totalNodes; n++) {
        if (incomingPipes[n].length >= 1 && outgoingPipes[n].length >= 1) {
            junctions.push({ node: n, incoming: incomingPipes[n], outgoing: outgoingPipes[n] });
        }
    }
    const reservoirIncidentPipe = reservoirNodes.map(r => incomingPipes[r][0]);

    return {
        pipeParams, miab, totalNodes, Z, baseDt,
        startNode, numSegments,
        pumpNode: nodeIndex.get(net.pump.node)!,
        reservoirNodes, ownerPipe,
        nodeIds, qoutSlot, qinSlot, ntoStride,
        junctions, reservoirIncidentPipe
    };
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 10 — MAIN SOLVER
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 10a″ — SteadyStateResult  (the gate's interface boundary — Row 3.11 Unit A, S65)
// ═══════════════════════════════════════════════════════════════════════════════
//
// What `PREPARE_pump` / `PREPARE_valve` / `PREPARE_gravityValve` hand back: everything `runCore`
// would have been given, plus the steady state itself. `SPEC_S63.md` §2.2 item 1.
//
// Per-node Q is deliberately NOT a field. It is read from `init.prevFlow` through the existing
// `reassembleQout` / `reassembleQin` (both exported at S65 for exactly this). A parallel per-node
// flow array would be a second representation of a quantity the solver already has — the §2
// two-sources-of-truth failure mode in miniature.
//
// Everything a gate needs is reachable from here: distance from `layout.pipeParams` dx/N, elevation
// from `layout.Z`, pressure as H − Z, total head from `init.prevState.H`, flow from the reassembly,
// velocity as Q/A, vapour margin as H − (Z + VAPOR_H_REL).
export interface SteadyStateResult {
    net:       NetworkInput;
    layout:    MeshLayout;
    pump:      PumpParams;          // derived carrier on the gravity path, passed through otherwise
    reservoir: ReservoirParams;     // derived H_valve_steady on both valve paths
    valve?:    ValveParams;
    upstreamReservoir?: { head: number };
    init:      RunInitState;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 10a′ — INIT_RUN_STATE  (steady state made callable — Row 3.11 Unit A, S65)
// ═══════════════════════════════════════════════════════════════════════════════
//
// `SPEC_S63.md` §2.2: the steady-state routine must be callable WITHOUT running the transient, so
// the gate displays the state the solver will actually use rather than a re-implementation of it.
//
// This is a PURE MOVE of runCore's former blocks 10b + 10c (pre-S65 lines :1691-1723), verbatim and
// in order. No arithmetic is altered. `ASSERT_INIT_ADMISSIBLE` deliberately stays in `runCore`
// immediately after this call — DC-12 names that call site as the enforcement point and moving it
// is a violation (§2.2 item 4).
//
// Both `steadyInit` branches move together so `runWaterHammerSimulationNetwork` (GGA) is unaffected,
// even though the gate itself is scoped to the legacy path (§2.1).
//
// Called twice per run after the split — once by `PREPARE_x`, once by `runCore`. Deterministic over
// its arguments, allocates fresh state on every call, writes nothing shared, no RNG or clock.
// Execution happens twice; the code exists once, which is what §2 requires.
//
// THROW BEHAVIOUR — corrected S65 after physics audit. The 'legacy' branch cannot throw
// (`INIT_STEADY_STATE` only writes the state/flow objects handed to it). The 'gga' branch CAN:
// `INIT_NETWORK_STEADY_STATE_GGA` throws on non-convergence, non-positive steady head, and spurious
// steady cavitation, and `buildGGAGraph` throws on malformed topology. That is inert today because
// only `runWaterHammerSimulationNetwork` reaches 'gga', and it calls `runCore` once, directly.
// **A future `PREPARE_network` would change guard ordering**: those throws would fire inside
// PREPARE, before `runCore`, and the LDLᵀ solve would run twice per call. Decide that deliberately
// rather than inheriting it.
//
// `baseDt` and `totalNodes` are returned rather than left behind: both are declared in the moved
// range and read 15+ times later in `runCore`, which destructures them so every downstream
// reference stays literally unchanged.
export interface RunInitState {
    baseDt:        number;
    totalNodes:    number;
    pipes:         Pipe[];
    rawPipeParams: PipeParams[];
    prevState:     SystemState;
    newState:      SystemState;
    prevFlow:      FlowState;
    newFlow:       FlowState;
    pumpHead:      number;
}

// NOT exported: nothing outside this file calls it, and exporting it would put the `source!`
// non-null assertion below on a public surface — INIT_RUN_STATE(net, layout, pump, res, 'gga') with
// `source` omitted is legal under the declared type and would crash at runtime (physics audit S65).
function INIT_RUN_STATE(
    net:        NetworkInput,
    layout:     MeshLayout,
    pump:       PumpParams,
    reservoir:  ReservoirParams,
    steadyInit: 'legacy' | 'gga',
    source?:    GGASource
): RunInitState {

    const baseDt        = layout.baseDt;
    const totalNodes    = layout.totalNodes;
    const pipes: Pipe[] = layout.pipeParams.map((pp, p) => ({ p: pp, miab: layout.miab[p] }));

    // ── 10b: State + elevation profile ─────────────────────────────────────────
    const prevState = new SystemState(totalNodes);
    const newState  = new SystemState(totalNodes);
    prevState.Z.set(layout.Z);

    // ── 10c: Steady-state initialisation ──────────────────────────────────────
    const rawPipeParams = pipes.map(pp => pp.p);
    const prevFlow = new FlowState(rawPipeParams, totalNodes, layout.qoutSlot, layout.qinSlot, layout.ntoStride);
    const newFlow  = new FlowState(rawPipeParams, totalNodes, layout.qoutSlot, layout.qinSlot, layout.ntoStride);

    let pumpHead: number;
    if (steadyInit === 'gga') {
        const ss = INIT_NETWORK_STEADY_STATE_GGA(net, layout, source!);
        for (let n = 0; n < totalNodes; n++) {
            prevState.H[n] = ss.nodeHead[n];
            const op = layout.ownerPipe[n];
            const V_g_n = ALPHA_G0 * layout.pipeParams[op].dx * layout.pipeParams[op].A;
            prevState.V_g[n] = V_g_n;
            prevState.C_gas[n] = (prevState.H[n] - prevState.Z[n] + H_BARO) * V_g_n;
        }
        for (let p = 0; p < layout.pipeParams.length; p++) {
            prevFlow.qL[p].fill(ss.linkFlow[p]);
            prevFlow.qR[p].fill(ss.linkFlow[p]);
        }
        prevFlow.qPumpFace = ss.pumpFlow;
        pumpHead = ss.steadyHead;
    } else {
        pumpHead = INIT_STEADY_STATE(prevState, prevFlow, rawPipeParams, pump, reservoir);
    }

    return { baseDt, totalNodes, pipes, rawPipeParams, prevState, newState, prevFlow, newFlow, pumpHead };
}

/**
 * One wave travel time along the route [s] — the sum of L/a over the reaches.
 *
 * PURE MOVE out of `runCore` (Row 3.11 Unit B, S67 — `SESSION-PLAN` D6), expression and branch
 * unchanged, including the `inputPipes ? … : …` split: the legacy path sums the RAW `length/waveSpeed`
 * while the network path sums the MESHED `dx*N/a`, and those are not identical — meshing rounds N,
 * so `dx*N` is the meshed route length, not the input length. Preserving the branch preserves both.
 *
 * WHY IT MOVED. `runCore` computes this AFTER `INIT_RUN_STATE` returns, so it is not in
 * `SteadyStateResult` and the gate cannot read it — but advisory check A5 (closure time vs one wave
 * round-trip) needs exactly this number. Re-deriving it in the checks engine would put two
 * definitions of one quantity in two files, which is the failure D1 exists to prevent, one layer
 * down. `runCore` now calls this and nothing else changed: 40*travelTime, maxSteps and the trip
 * window all read the same value they did before.
 */
export function COMPUTE_TRAVEL_TIME(layout: MeshLayout, inputPipes?: PipeSection[]): number {
    return inputPipes
        ? inputPipes.reduce((s, p) => s + p.length / p.waveSpeed, 0.0)
        : layout.pipeParams.reduce((s, p) => s + p.dx * p.N / p.a, 0.0);
}

/**
 * Shared simulation core (I6 — spec §6). Both entry points route through here.
 * steadyInit='legacy' uses INIT_STEADY_STATE (single reservoir, original path).
 * steadyInit='gga'    uses INIT_NETWORK_STEADY_STATE_GGA (multi-reservoir, I5).
 * inputPipes is needed only for travelTime/maxTime/output in the legacy path.
 */
function runCore(
    net:        NetworkInput,
    layout:     MeshLayout,
    pump:       PumpParams,
    reservoir:  ReservoirParams,
    steadyInit: 'legacy' | 'gga',
    source?:    GGASource,
    inputPipes?: PipeSection[],
    valve?: ValveParams,
    upstreamReservoir?: { head: number },  // S57 node-0 gravity dispatch (SECTION 7f; spec §1.4)
    airValves?: AirValveBC[],              // Q14: air valve nodes (SECTION 7g); absent/[] = none
    qprv?: QprvBC                          // Q19: QPRV at the end valve (SECTION 7h); absent = none
): SimulationResults {

    // `rawPipeParams` is returned by INIT_RUN_STATE (the gate reads it) but is not destructured here:
    // `runCore` never referenced it after this block, and an unused binding would fail --noUnusedLocals.
    const { baseDt, totalNodes, pipes, prevState, newState, prevFlow, newFlow, pumpHead } =
        INIT_RUN_STATE(net, layout, pump, reservoir, steadyInit, source);

    // Step 3.9 / S62 (Fixes 2+3): both init paths converge here with prevState.H/.Z/.C_gas fully
    // populated for every node. One call covers both. SECTION 9.7.
    ASSERT_INIT_ADMISSIBLE(prevState, totalNodes, `runCore(steadyInit=${steadyInit})`);

    newState.Z.set(prevState.Z);
    newState.C_gas.set(prevState.C_gas);
    newState.copyFrom(prevState);
    newFlow.copyFrom(prevFlow);

    // ── 10d: Per-pipe MIAB state initialisation (b+ — E5) ────────────────────
    const miabState_dummy = new MIABState(0);  // never accessed when pipeMIABArr is provided
    const pipeMIAB: PipeMIABState[] = pipes.map((pipe) => ({
        z:     Array.from({ length: MIAB_M }, () => new Float64Array(pipe.p.N + 1)),
        Qprev: new Float64Array(pipe.p.N + 1)
    }));
    // Seed Qprev from steady state (R10: each offset from this pipe's own flow, no junction collapse)
    for (let p = 0; p < pipes.length; p++) {
        const N = pipes[p].p.N;
        for (let o = 0; o <= N; o++) {
            pipeMIAB[p].Qprev[o] = pipeOwnQout(prevFlow, p, N, o);
        }
    }

    // ── 10e: Envelope arrays & history ────────────────────────────────────────
    const maxH = new Float64Array(prevState.H);
    const minH = new Float64Array(prevState.H);
    const maxV = new Float64Array(prevState.V_g);

    const grid: GridParams   = { dt: baseDt };
    const avAt = airValves?.length ? AIR_VALVE_NODES(layout, airValves) : undefined;   // Q14
    // Q14 ruling 3: a line-end air valve acts while its end is a dead end (pump stopped / valve shut
    // — SECTION 7g, DC-5), and (Q16, ANSWERS 2026-10-22 "opens instantly") at the line start while a
    // built-in-curve pump (no user curve: pump trip, or the no-curve pump-fed valve) still runs, once
    // the pump BC puts the node below atmospheric or air is still in the pocket. There the pump
    // inflow is the pump curve evaluated ONCE at the node's previous-step head (single pass, as the
    // cavitation branch evaluates it at H_vap — no joint gas-law + pump-curve solve, DC-5), then fed to the air node as a known inflow. Air carries over only while a pocket is
    // held (avAir); otherwise the end BC's C_gas is DGCM memory (DOMAIN §4/§7, kept after collapse),
    // not air that entered.
    const avAir = new Set<number>();
    const AIR_VALVE_STEP = (n: number, av: { A_in: number; A_out: number }, C_air: number,
                            faces: JunctionFaceN[], Q_feed = 0.0) => {
        const r = CALC_AIR_VALVE_N(faces, prevState.V_g[n], C_air, prevState.Z[n], grid.dt,
                                   av.A_in, av.A_out, Q_feed);
        newState.H[n] = r.H; newState.V_g[n] = r.V_g; newState.C_gas[n] = r.C_gas;
        return r.Q;
    };
    const AIR_VALVE_END = (n: number, av: { A_in: number; A_out: number }, face: JunctionFaceN, Q_feed = 0.0) => {
        const Q = AIR_VALVE_STEP(n, av, avAir.has(n) ? prevState.C_gas[n] : 0.0, [face], Q_feed)[0];
        if (newState.V_g[n] > 0) avAir.add(n); else avAir.delete(n);
        return Q;
    };
    const avCap = avAt && NODE_SEGMENT_VOLUMES(layout);
    // Q14 spill + refill rulings (ANSWERS 2026-10-18): the pocket is one gas body, its whole volume
    // kept at the valve node in the state (gas law, CALC_AIR_VALVE_N); the results hold it as the
    // valve node full (its dx·A) and the excess in the next nodes in the flow direction, each node
    // up to its own dx·A. The direction is the sign of the flow at the valve node when the pocket
    // first outgrows that node (+x at zero flow; −x from the line end), kept while it spills; at a
    // line end or at another valve's node / spill the rest goes the other way. A spill never enters
    // another valve's node or spill. Air left over then (no room up to the neighbouring valves or
    // ends) is not shown at any node; the whole pocket per valve is in avPocket (airPocketMax). As
    // the pocket shrinks, the farthest node refills first and the valve node last; the air leaves
    // through the valve.
    const avPocket = avAt && new Array<number>(totalNodes).fill(0);   // whole pocket, max over t [m³]
    const avDir = new Map<number, number>();                           // spill direction per valve node
    const reportVapors = (V: Float64Array, flow: FlowState): number[] => {
        const out = Array.from(V);
        if (avAt === undefined || avCap === undefined || avPocket === undefined) return out;
        const taken = new Set<number>(avAt.keys());
        for (const n of avAt.keys()) {
            if (V[n] > avPocket[n]) avPocket[n] = V[n];
            let rest = out[n] - avCap[n];
            if (!(rest > 0)) { avDir.delete(n); continue; }
            out[n] = avCap[n];
            let fwd = avDir.get(n);
            if (fwd === undefined) {
                fwd = n === totalNodes - 1 || flow.nodeQout(n) < 0 ? -1 : 1;
                avDir.set(n, fwd);
            }
            for (const dir of [fwd, -fwd]) {
                for (let j = n + dir; rest > 0 && j >= 0 && j < totalNodes && !taken.has(j); j += dir) {
                    const put = Math.min(rest, Math.max(0, avCap[j] - out[j]));
                    out[j] += put; rest -= put; taken.add(j);
                }
            }
        }
        return out;
    };

    // Reservoir BC dispatch (E5′/R2/R3 — DESIGN §6): one entry per reservoir node with its incident
    // (to-end) pipe and head. Legacy path has exactly one reservoir node (the terminal, incident = last
    // pipe, head = reservoir.head) ⇒ degenerates to the former single CALC_BC_RESERVOIR(terminal,…) call
    // BIT-IDENTICALLY. Network path: heads from net.nodes reservoir-order, index-aligned with
    // layout.reservoirNodes (DESIGN §6).
    const resNetNodes = net.nodes.filter(n => n.type === 'reservoir');
    const reservoirBCs = layout.reservoirNodes.map((node, ri) => ({
        node,
        pipeIdx: layout.reservoirIncidentPipe[ri],
        head:    steadyInit === 'legacy' ? reservoir.head : resNetNodes[ri].head!
    }));

    // Q19 QPRV (SECTION 7h), valve scenarios only, at the valve node. Reference head = head upstream
    // of the closed valve with no surge (ruling 2026-10-28): the supply reservoir level, or the pump
    // head at Q = 0 — H_suct + c on a user curve (SECTION 7c.1, α = 1), else the built-in Hs. Its
    // opening `qpOpen` is set each step by CALC_BC_QPRV. Shut = SECTION 7e unchanged.
    if (qprv !== undefined && !(Number.isFinite(qprv.Cq) && qprv.Cq > 0 &&
                                Number.isFinite(qprv.closingTime) && qprv.closingTime > 0)) {
        throw new Error(`QPRV: Cq (${qprv.Cq}) and closing time (${qprv.closingTime} s) must be finite and > 0.`);
    }
    if (qprv?.runTime !== undefined && !(Number.isFinite(qprv.runTime) && qprv.runTime > 0)) {
        throw new Error(`QPRV: run time (${qprv.runTime} s) must be finite and > 0.`);
    }
    const qp = qprv !== undefined && valve !== undefined ? {
        H_open:QPRV_THRESHOLD_M + (upstreamReservoir !== undefined ? upstreamReservoir.head
                : pump.curve !== undefined ? pump.curve.H_suct + pump.curve.c
                : PUMP_TRIP_CURVE(pump, pumpHead).Hs),
        ...qprv
    } : undefined;
    let qpOpen = 0.0;
    const qpOpening = qp !== undefined ? [qpOpen] : undefined;   // Q21 telemetry, one per fullHistory entry

    // travelTime: use inputPipes when available (legacy path), else derive from layout
    const travelTime        = COMPUTE_TRAVEL_TIME(layout, inputPipes);
    // Q21: the QPRV sizing study runs longer (only the loop bound changes, so the first 40·L/a are
    // the default run bit-for-bit); absent = 40·L/a.
    const maxTime           = qp?.runTime ?? 40.0 * travelTime;
    const maxSteps          = Math.ceil(maxTime / baseDt);
    const steadyPressureHead = pumpHead - pump.elevation;
    const exitThreshold     = 0.1 * steadyPressureHead;

    const timeSteps:   number[]                        = [0];
    const timeHistory: SimulationResults['timeHistory'] = [{
        time: 0, head: prevState.H[0],
        flow: prevFlow.nodeQout(0),
        flowNext: totalNodes > 1 ? prevFlow.nodeQout(1) : undefined,
        vaporVolume: prevState.V_g[0]
    }];
    const fullHistory: SimulationResults['fullHistory'] = [{
        time: 0,
        heads:  Array.from(prevState.H),
        flows:  reassembleQout(prevFlow, totalNodes),
        vapors: Array.from(prevState.V_g),
        q_in:   reassembleQin(prevFlow, totalNodes),
        endFlows: captureEndFlows(prevFlow, pipes)
    }];

    // ── 10f: Timestep loop ─────────────────────────────────────────────────────
    for (let step = 1; step <= maxSteps; step++) {
        const t = step * baseDt;

        // 1. Node-0 boundary — C− only, no upstream pipe, offset 0 of pipe 0.
        //    S57 seam (gravity_fed_valve_spec.md §1.4): upstream constant-head reservoir dispatch
        //    (SECTION 7f) when provided; else pump — else-arm call byte-identical to the pre-S57
        //    line (ADD-ONLY L068; same reference-equality pattern as the S50 valve seam, step 3).
        const coefsPump = COMPUTE_CHARACTERISTICS(
            0, prevState, prevFlow, null, pipes[0], miabState_dummy, totalNodes,
            pipeMIAB, -1, 0, -1, 0, layout.nodeIds
        );
        if (upstreamReservoir !== undefined) {
            CALC_BC_RESERVOIR_UP(0, coefsPump, prevState, newState, newFlow, upstreamReservoir.head);
        } else {
            const av0 = avAt?.get(0);
            if (av0 !== undefined && PUMP_ALPHA(pump, t) < PUMP_STOP_ALPHA) {   // Q14: pump stopped
                newFlow.setQin(0, 0.0);                    // check valve shut (DOMAIN §5 stopped branch)
                newFlow.setQout(0, AIR_VALVE_END(0, av0,
                    { C: coefsPump.Cm, B: coefsPump.B2, dxA: pipes[0].p.dx * pipes[0].p.A, incoming: false }));
            } else {
                CALC_BC_PUMP_DGCM(0, coefsPump, prevState, newState, newFlow, grid, pump, pumpHead, t, pipes[0].p);
                if (av0 !== undefined && pump.curve === undefined &&
                    (newState.H[0] < prevState.Z[0] || avAir.has(0))) {   // Q16: built-in-curve pump running, air valve
                    const Q_feed = PUMP_TRIP_Q_AT(pump, pumpHead, PUMP_ALPHA(pump, t), prevState.H[0]);
                    newFlow.setQin(0, Q_feed);
                    newFlow.setQout(0, AIR_VALVE_END(0, av0,
                        { C: coefsPump.Cm, B: coefsPump.B2, dxA: pipes[0].p.dx * pipes[0].p.A, incoming: false },
                        Q_feed));
                }
            }
        }

        // 2. Interior nodes (per pipe, local offsets 1..N_p−1). Junctions handled in 2b.
        for (let pi = 0; pi < pipes.length; pi++) {
            const pipe = pipes[pi];
            for (let o = 1; o < pipe.p.N; o++) {
                const idx = layout.nodeIds[pi][o];
                const coefs = COMPUTE_CHARACTERISTICS(
                    idx, prevState, prevFlow, pipe, pipe, miabState_dummy, totalNodes,
                    pipeMIAB, pi, pi, o, o, layout.nodeIds
                );
                const av = avAt?.get(idx);
                if (av === undefined) {
                    CALC_INTERIOR_DGCM(idx, coefs, prevState, newState, newFlow, grid, pipe.p);
                } else {                                           // Q14 air valve (SECTION 7g)
                    const dxA = pipe.p.dx * pipe.p.A;
                    const Q = AIR_VALVE_STEP(idx, av, prevState.C_gas[idx],
                        [{ C: coefs.Cp, B: coefs.B1, dxA, incoming: true },
                         { C: coefs.Cm, B: coefs.B2, dxA, incoming: false }]);
                    newFlow.setQin(idx, Q[0]);
                    newFlow.setQout(idx, Q[1]);
                }
            }
        }

        // 2b. Junctions (E5′ — DESIGN §3.2/§3b.2): degree≥2 interior nodes. One one-sided
        //     COMPUTE_CHARACTERISTICS per incident pipe-end (incoming → C+ at offset N; outgoing → C− at
        //     offset 0), N-face DGCM, then scatter each face flow DIRECTLY to its (pipe,end) slot (R5 —
        //     no setQin/setQout node-collapse at a multi-outgoing junction). All reads are prev*/writes
        //     new* ⇒ visiting order vs interiors is numerically inert (§3.1). For a degree-2 series
        //     junction (faces ordered [incoming, outgoing]) this reduces to the former 2-face call
        //     BIT-IDENTICALLY (I4 degeneracy + identical FP-operand order).
        for (const J of layout.junctions) {
            const faces:   JunctionFaceN[]                         = [];
            const scatter: { pipeIdx: number; incoming: boolean }[] = [];
            for (const pi of J.incoming) {                 // pipe.to == J ⇒ incoming C+, offsetUp = N
                const pe = pipes[pi];
                const c  = COMPUTE_CHARACTERISTICS(
                    J.node, prevState, prevFlow, pe, null, miabState_dummy, totalNodes,
                    pipeMIAB, pi, -1, pe.p.N, -1, layout.nodeIds
                );
                faces.push({ C: c.Cp, B: c.B1, dxA: pe.p.dx * pe.p.A, incoming: true });
                scatter.push({ pipeIdx: pi, incoming: true });
            }
            for (const pi of J.outgoing) {                 // pipe.from == J ⇒ outgoing C−, offsetDown = 0
                const pe = pipes[pi];
                const c  = COMPUTE_CHARACTERISTICS(
                    J.node, prevState, prevFlow, null, pe, miabState_dummy, totalNodes,
                    pipeMIAB, -1, pi, -1, 0, layout.nodeIds
                );
                faces.push({ C: c.Cm, B: c.B2, dxA: pe.p.dx * pe.p.A, incoming: false });
                scatter.push({ pipeIdx: pi, incoming: false });
            }
            const avJ = avAt?.get(J.node);
            const res = avJ === undefined
                ? CALC_JUNCTION_DGCM_N(
                    faces, prevState.V_g[J.node], prevState.C_gas[J.node], prevState.Z[J.node], grid.dt)
                : CALC_AIR_VALVE_N(faces, prevState.V_g[J.node], prevState.C_gas[J.node], prevState.Z[J.node],
                    grid.dt, avJ.A_in, avJ.A_out);   // Q14 air valve (SECTION 7g)
            newState.H[J.node]     = res.H;
            newState.V_g[J.node]   = res.V_g;
            newState.C_gas[J.node] = res.C_gas;
            for (let k = 0; k < scatter.length; k++) {
                const s = scatter[k];
                if (s.incoming) newFlow.qR[s.pipeIdx][pipes[s.pipeIdx].p.N - 1] = res.Q[k];  // → incoming to-end
                else            newFlow.qL[s.pipeIdx][0]                        = res.Q[k];  // → outgoing from-end
            }
        }

        // 3. Reservoir boundaries (E5′ — DESIGN §6): one C+ BC per reservoir node, its incident pipe as
        //    pipeUp at offset N. Legacy single-reservoir chain degenerates to the former one call.
        for (const bc of reservoirBCs) {
            const pe = pipes[bc.pipeIdx];
            const coefsRes = COMPUTE_CHARACTERISTICS(
                bc.node, prevState, prevFlow, pe, null, miabState_dummy, totalNodes,
                pipeMIAB, bc.pipeIdx, -1, pe.p.N, -1, layout.nodeIds
            );
            const avE = valve !== undefined ? avAt?.get(bc.node) : undefined;
            const valveShut = valve !== undefined && valve.Cv0 * evalTau(valve.law, t) <= 0.0;
            let qpDone = false;   // Q19: the QPRV discharged and wrote the node (SECTION 7h)
            if (valve !== undefined && qp !== undefined) {
                // Air pocket (below atmospheric), or a vapour cavity at the shut valve: the QPRV closes
                // at its closing rate and SECTION 7e (air valve / closed dead-end DGCM) keeps the node,
                // so the cavity collapses through DC-4 mass balance before the QPRV may act.
                const cavity = valveShut && prevState.V_g[bc.node] > 1e-12;
                if (avAir.has(bc.node) || cavity) qpOpen = Math.max(0.0, qpOpen - grid.dt / qp.closingTime);
                else ({ s: qpOpen, done: qpDone } =
                          CALC_BC_QPRV(bc.node, coefsRes, prevState, newState, newFlow, grid, valve, t, qp, qpOpen));
            }
            if (qpDone) {
                // Q19: SECTION 7h wrote H, Q_in, V_g, C_gas of the valve node
            } else if (avE !== undefined && valveShut) {
                // Q14: valve shut (CALC_BC_VALVE's Cv ≤ 0 dead end); throat Q_out = 0, step-local as there
                newFlow.setQin(bc.node, AIR_VALVE_END(bc.node, avE,
                    { C: coefsRes.Cp, B: coefsRes.B1, dxA: pe.p.dx * pe.p.A, incoming: true }));
            } else if (valve !== undefined) {
                CALC_BC_VALVE(bc.node, coefsRes, prevState, newState, newFlow, grid, valve, t, pe.p);
            } else {
                CALC_BC_RESERVOIR(bc.node, coefsRes, prevState, newState, newFlow, bc.head);
            }
        }

        // 4. Update per-pipe MIAB state (b+ — E4)
        UPDATE_MIAB_STATE_PIPE(pipes, prevFlow, pipeMIAB, grid);

        // 5. Advance state + update envelopes
        prevState.copyFrom(newState);
        prevFlow.copyFrom(newFlow);
        const vapors = reportVapors(prevState.V_g, prevFlow);   // = V_g exactly without air valves
        for (let i = 0; i < totalNodes; i++) {
            if (newState.H[i]   > maxH[i]) maxH[i] = newState.H[i];
            if (newState.H[i]   < minH[i]) minH[i] = newState.H[i];
            if (vapors[i]       > maxV[i]) maxV[i] = vapors[i];
        }

        // 6. Record history
        timeSteps.push(t);
        timeHistory.push({
            time: t, head: prevState.H[0],
            flow: prevFlow.nodeQout(0),
            flowNext: totalNodes > 1 ? prevFlow.nodeQout(1) : undefined,
            vaporVolume: vapors[0]
        });
        fullHistory.push({
            time:   t,
            heads:  Array.from(prevState.H),
            flows:  reassembleQout(prevFlow, totalNodes),
            vapors,
            q_in:   reassembleQin(prevFlow, totalNodes),
            endFlows: captureEndFlows(prevFlow, pipes)
        });
        qpOpening?.push(qpOpen);

        // 7. Early-exit: check if transient has settled
        if (t > pump.haltTime + 4.0 * travelTime) {
            const windowTime = 3.0 * 4.0 * travelTime;
            const startIdx   = timeHistory.findIndex(th => th.time > t - windowTime);
            if (startIdx !== -1 && timeHistory.length - startIdx > 10) {
                let settled = true;
                for (let i = startIdx; i < timeHistory.length; i++) {
                    const pH = timeHistory[i].head - prevState.Z[1];
                    if (Math.abs(pH - steadyPressureHead) > exitThreshold) {
                        settled = false;
                        break;
                    }
                }
                if (settled) break;
            }
        }
    }

    // ── 10g: Build steady-state head profile for output (display only — NOT hashed) ───
    // March each pipe along its OWN nodeIds from its from-node (S37 fix): a branch bases off the
    // junction head, not the previous pipe's terminal. For a contiguous linear chain nodeIds[p] are
    // sequential and consecutive pipes share the junction node ⇒ identical to the former sequential
    // march. (Display field; not in capture.ts's hashed stream.)
    const steadyH = new Float64Array(totalNodes);
    steadyH[0] = pumpHead;
    for (let p = 0; p < pipes.length; p++) {
        const pipe = pipes[p];
        const v    = pump.initialFlow / pipe.p.A;
        const dH   = (pipe.p.f * pipe.p.dx * v * v) / (2.0 * G * pipe.p.D);
        const ids  = layout.nodeIds[p];
        for (let o = 1; o <= pipe.p.N; o++) {
            steadyH[ids[o]] = steadyH[ids[o - 1]] - dH;
        }
    }

    // ── 10h: Assemble result nodes ────────────────────────────────────────────
    const nodes: SimulationResults['nodes'] = [];
    let x = 0.0;
    nodes.push({
        x: 0.0,
        elevation:      prevState.Z[0],
        maxHead:        maxH[0],
        minHead:        minH[0],
        steadyHead:     steadyH[0],
        maxVaporVolume: maxV[0]
    });

    let nIdx = 1;
    for (const pipe of pipes) {
        for (let i = 0; i < pipe.p.N; i++) {
            x += pipe.p.dx;
            nodes.push({
                x,
                elevation:      prevState.Z[nIdx],
                maxHead:        maxH[nIdx],
                minHead:        minH[nIdx],
                steadyHead:     steadyH[nIdx],
                maxVaporVolume: maxV[nIdx]
            });
            nIdx++;
        }
    }

    // paths: single-pipe case exposes node indices for the legacy path
    const paths: SimulationResults['paths'] = pipes.length === 1
        ? [{ id: layout.pipeParams[0].startNode.toString(), nodeIndices: Array.from({ length: totalNodes }, (_, i) => i) }]
        : undefined;

    return { timeSteps, nodes, timeHistory, fullHistory, paths,
             ...(avPocket !== undefined && { airPocketMax: avPocket }),
             ...(qp !== undefined && qpOpening !== undefined && { qprv: { H_open: qp.H_open, opening: qpOpening } }) };
}

// ── PREPARE_pump — moved from runWaterHammerSimulation (Row 3.11 Unit A, S65) ──
// PURE MOVE of the entry point's former body, verbatim and in its existing statement order.
// No scenario-specific derivation exists on this path — `SPEC_S63.md` §2.2's table records it as
// "none (pump params passed through)". The meshing moves anyway, so all three scenarios reach the
// steady state through one shape.
// The gate calls this and nothing else (`SPEC_S63.md` §2.2 item 3). The entry point calls it and
// then `runCore`, whose behaviour — including which guard throws first — is unchanged.
export function PREPARE_pump(
    inputPipes: PipeSection[],
    pump:       PumpParams,
    reservoir:  ReservoirParams,
    trace?:     (fn: string) => void,
    collect?:   (f: GateFinding) => void   // S67 D2 — see meshNetwork; omitted ⟹ guards throw
): SteadyStateResult {
    trace?.(PREPARE_pump.name);   // §8.3(a) seam: proves the gate and the run enter the SAME function
    // Q10 (plan §5 P2, Q6-f): a user curve is REFUSED on pump trip, never ignored — ignored, the
    // 1.33 curve would run silently in its place.
    if (pump.curve !== undefined) {
        throw new Error('runWaterHammerSimulation: a user pump curve applies to the pump-fed valve ' +
                        'closure only; pump trip keeps the built-in curve.');
    }
    // ── 10a: Network meshing (Phase 2.5.3 / I3 — spec §3a.1–§3a.6) ─────────────
    // The ordered PipeSection[] routes through the legacy adapter (legacyToNetwork) and the
    // graph mesher (meshNetwork, Section 9.5). For the linear chain the mesh reduces
    // BIT-IDENTICALLY to the former inline meshing (regression gate, DOMAIN §11). inputPipes
    // stays in scope below (travelTime/maxTime read it directly — unchanged).
    const net    = legacyToNetwork(inputPipes, pump, reservoir);
    const layout = meshNetwork(net, collect);
    return { net, layout, pump, reservoir,
             init: INIT_RUN_STATE(net, layout, pump, reservoir, 'legacy', undefined) };
}

export function runWaterHammerSimulation(
    inputPipes: PipeSection[],
    pump:       PumpParams,
    reservoir:  ReservoirParams,
    trace?:     (fn: string) => void,
    airValves?: AirValveBC[]               // Q14
): SimulationResults {
    const prep = PREPARE_pump(inputPipes, pump, reservoir, trace);
    return runCore(prep.net, prep.layout, prep.pump, prep.reservoir, 'legacy', undefined, inputPipes,
                   undefined, undefined, airValves);
}

/**
 * Entry point for network simulations (I6 — spec §6). Routes through the shared
 * runCore with GGA steady-state initialisation and the full network graph-walk.
 */
export function runWaterHammerSimulationNetwork(
    net:    NetworkInput,
    source?: GGASource
): SimulationResults {
    const src = source ?? { kind: 'pumpCurve', Q0: net.pump.initialFlow };
    const layout   = meshNetwork(net);
    const pumpNode = net.nodes.find(n => n.type === 'pump')!;
    const resNode  = net.nodes.find(n => n.type === 'reservoir')!;
    const pumpParams: PumpParams = {
        initialHead: 0,
        initialFlow: net.pump.initialFlow,
        tripTime:    net.pump.tripTime,
        haltTime:    net.pump.haltTime,
        elevation:   pumpNode.elevation
    };
    const reservoirParams: ReservoirParams = { head: resNode.head! };
    return runCore(net, layout, pumpParams, reservoirParams, 'gga', src);
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 9.6 — INIT_NETWORK_STEADY_STATE_GGA  (Phase 2.5.5 / I5 — spec §3c.1–§3c.5)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Network steady-state initialiser via the Global Gradient Algorithm (GGA; Todini &
// Pilati 1988; Rossman 2000, EPANET 2 manual) + multi-reservoir BCs.
//
// PURE ADDITIVE MODULE (DECISIONS 2026-06-10 D-I5-A): exported but NOT wired into
// runWaterHammerSimulation. Every production line above is byte-for-byte unchanged, so
// the bit-identity regression gate (DOMAIN §11, L056) passes BY CONSTRUCTION. Wiring
// GGA into the transient loop is I6 (spec §6). All math is plain MOC-side network
// hydraulics (Darcy–Weisbach n=2, HGL piezometric energy balance): NO WCM imports,
// conventions, or heuristics (DOMAIN §10). Full derivation + section refs:
// findings/phase_2.5.5_gga_steadystate/DESIGN.md.

// ── Named constants (DESIGN §12; DOMAIN §11) ─────────────────────────────────────
const GGA_TOL_CONT   = 1e-13;   // continuity stop  [m³/s] (a decade under DoD 1e-12)
const GGA_TOL_ENERGY = 1e-10;   // energy stop      [m]    (a decade under DoD 1e-9)
const GGA_MAX_ITER   = 100;     // iteration cap → throw (no silent fallback)
const Q_LAM          = 1e-6;    // laminar Jacobian-diagonal floor [m³/s] (DESIGN §4)
const GGA_PIVOT_MIN  = 1e-14;   // LDLᵀ pivot guard → throw
const HS_FACTOR      = 1.33;    // pump curve Hs = 1.33·steadyHead (DOMAIN §5); used by
                                // 9.6 and SECTION 7c PUMP_TRIP_CURVE (Q16: the former
                                // CALC_BC_PUMP_DGCM literal, same value, hashes unchanged).
const QMAX_FACTOR    = 2.0;     // pump curve run-out flow Qmax = 2·Q0 (DOMAIN §5)

/**
 * Pump source mode (DESIGN §5.4):
 *   'pumpCurve' — production: injection q* = 2·Q0·√(1−1/HS_FACTOR), the analytic
 *                 collapse of the self-consistent steadyHead coupling (D-I5-B). No
 *                 outer fixed-point loop exists to run.
 *   'fixedFlow' — validation: injection exactly Q. Isolates GGA-engine correctness
 *                 from the pump-model difference (the §9 cross-check, test T7).
 */
export type GGASource =
    | { kind: 'pumpCurve'; Q0: number }
    | { kind: 'fixedFlow'; Q: number };

/** GGA steady-state result, handed to the I6 transient loop (DESIGN §8). */
export interface NetworkSteadyState {
    linkFlow:   Float64Array;   // converged Q_k per pipe (ordered/pipeParams index space), signed from→to
    nodeHead:   Float64Array;   // per MESH-node head over totalNodes (network node = GGA head; interior = marched)
    steadyHead: number;         // S = H[pumpNode] (the transient pump BC's Hs = HS_FACTOR·S uses this)
    pumpFlow:   number;         // q* (pumpCurve) or the fixed Q (fixedFlow)
    auditLog:   string;         // D2 audit-log (L078: a STRING — never enters a Float64 output array)
}

/** Internal GGA graph (mesh-node space). Built from NetworkInput + MeshLayout (DESIGN §2.2). */
interface GGAGraph {
    nL:        number;                  // links = pipes
    from:      Int32Array;              // mesh-node index of link k's `from`
    to:        Int32Array;              // mesh-node index of link k's `to`
    R:         Float64Array;            // lumped pipe resistance R_k = f·L/(2g·D·A²)
    nU:        number;                  // unknown-head node count
    uOfNode:   Map<number, number>;     // mesh-node → unknown-head index (unknown nodes only)
    fixedHead: Map<number, number>;     // mesh-node → fixed HGL head (reservoir nodes)
    pumpU:     number;                  // unknown index of the pump node
}

/**
 * Build the GGA graph from the EPANET input + mesh layout (DESIGN §2.2).
 *
 * Link endpoints in MESH-node space: meshNetwork allocates node blocks sequentially in
 * BFS/ordered pipe order (Section 9.5), so for pipe k `from = startNode[k]` and the `to`
 * node is the last new index of k's block = Σ_{q≤k} numSegments[q]. Valid for TREES
 * (I5 scope); converging DAGs (a shared `to`) are deferred (spec §7 / DESIGN §11.3).
 * Degenerate/invalid inputs are rejected with explicit errors — no silent fallback.
 */
function buildGGAGraph(net: NetworkInput, layout: MeshLayout): GGAGraph {
    const nL = layout.pipeParams.length;
    if (nL === 0) throw new Error('GGA: network has no links');

    const from = new Int32Array(nL);
    const to   = new Int32Array(nL);
    const R    = new Float64Array(nL);
    let cum = 0;
    for (let k = 0; k < nL; k++) {
        const pp = layout.pipeParams[k];
        from[k] = layout.startNode[k];
        cum    += layout.numSegments[k];
        to[k]   = cum;                                  // = Σ_{q≤k} numSegments (last new index of k's block)
        const L  = pp.dx * pp.N;                         // meshed length (DESIGN §2.2)
        const Rk = (pp.f * L) / (2.0 * G * pp.D * pp.A * pp.A);   // mirrors INIT_STEADY_STATE arithmetic
        if (!(Rk > 0)) throw new Error(`GGA: non-positive resistance on link ${k} (R=${Rk})`);
        R[k] = Rk;
    }

    // Fixed-head nodes = reservoirs; head from NetworkNode.head (HGL, spec §3c.4).
    // meshNetwork builds reservoirNodes[] from net.nodes.filter(reservoir) in order, so
    // reservoirNodes[j] ↔ resNodes[j] (same filter, same order).
    if (layout.reservoirNodes.length === 0) throw new Error('GGA: network has no reservoir (fixed-head) node');
    const resNodes  = net.nodes.filter(n => n.type === 'reservoir');
    const fixedHead = new Map<number, number>();
    for (let j = 0; j < layout.reservoirNodes.length; j++) {
        const h = resNodes[j]?.head;
        if (h === undefined || !Number.isFinite(h))
            throw new Error(`GGA: reservoir node '${resNodes[j]?.id ?? '?'}' is missing a required finite head`);
        fixedHead.set(layout.reservoirNodes[j], h);
    }

    // Network-node set = pump ∪ every link endpoint. Disconnected-node guard (§2.2):
    // a declared non-pump node that no link touches never appears → count mismatch → reject.
    const allNodes = new Set<number>([layout.pumpNode]);
    for (let k = 0; k < nL; k++) { allNodes.add(from[k]); allNodes.add(to[k]); }
    if (allNodes.size !== net.nodes.length)
        throw new Error(`GGA: disconnected node — ${net.nodes.length} declared, ${allNodes.size} reached by links`);

    // Unknown-head partition = network nodes that are not fixed (pump + junctions).
    const uOfNode = new Map<number, number>();
    let nU = 0;
    for (const n of [...allNodes].sort((a, b) => a - b)) if (!fixedHead.has(n)) uOfNode.set(n, nU++);
    if (nU === 0) throw new Error('GGA: no unknown-head node (degenerate)');
    const pumpU = uOfNode.get(layout.pumpNode);
    if (pumpU === undefined) throw new Error('GGA: pump node is not an unknown-head node');

    return { nL, from, to, R, nU, uOfNode, fixedHead, pumpU };
}

/**
 * Dense LDLᵀ solve of a symmetric positive-definite system M·x = b (DESIGN §3).
 * M is n×n row-major; the system A21·D⁻¹·A12 is SPD (d_k>0 strictly via the laminar
 * floor, A12 full column rank when every unknown node is path-connected to a fixed
 * node — the §2.2 validation guarantees it). Network sizes in scope are O(10) nodes;
 * sparse machinery is excluded (DESIGN §3). Pivot < GGA_PIVOT_MIN → throw (singular ⇒
 * disconnected / zero-resistance, already rejected upstream; defense-in-depth).
 */
function solveSPD_LDLt(M: Float64Array, b: Float64Array, n: number): Float64Array {
    const a = Float64Array.from(M);     // factor in place: a holds L (below diag), d holds D
    const d = new Float64Array(n);
    for (let j = 0; j < n; j++) {
        let dj = a[j * n + j];
        for (let k = 0; k < j; k++) dj -= a[j * n + k] * a[j * n + k] * d[k];
        if (Math.abs(dj) < GGA_PIVOT_MIN)
            throw new Error(`GGA: LDLᵀ pivot ${dj} below ${GGA_PIVOT_MIN} (singular system)`);
        d[j] = dj;
        for (let i = j + 1; i < n; i++) {
            let s = a[i * n + j];
            for (let k = 0; k < j; k++) s -= a[i * n + k] * a[j * n + k] * d[k];
            a[i * n + j] = s / dj;
        }
    }
    const x = Float64Array.from(b);
    for (let i = 0; i < n; i++) for (let k = 0; k < i; k++) x[i] -= a[i * n + k] * x[k];   // L·y = b
    for (let i = 0; i < n; i++) x[i] /= d[i];                                              // D·z = y
    for (let i = n - 1; i >= 0; i--) for (let k = i + 1; k < n; k++) x[i] -= a[k * n + i] * x[k]; // Lᵀ·x = z
    return x;
}

/**
 * BOX: INIT_NETWORK_STEADY_STATE_GGA — network steady state via GGA (spec §3c; DESIGN §1–§10).
 *
 * INPUT
 *   net     EPANET network (Section 9.5) — node/pipe graph + reservoir heads
 *   layout  MeshLayout (meshNetwork output) — meshed per-pipe params + node mapping
 *   source  pump source mode (DESIGN §5.4): 'pumpCurve' (q* injection) | 'fixedFlow'
 *
 * OUTPUT
 *   NetworkSteadyState — link flows, per-mesh-node heads, steadyHead S, pump flow, audit-log
 *
 * METHOD (Todini & Pilati 1988; sign block DESIGN §3):
 *   incidence row k: −1 at from, +1 at to ⇒ H_from − H_to = R_k·Q_k·|Q_k| (head falls
 *   along flow). A21 = A12ᵀ; continuity A21·Q = q (q = demand, withdrawal-positive;
 *   pump injection = negative demand). Newton/GGA with laminar Jacobian floor on D only:
 *     Solve  (A21·D⁻¹·A12)·H = −A21·D⁻¹·(A11·Q + A10·H0) + (A21·Q − q)
 *     Update Q ← Q − D⁻¹·(A11·Q + A12·H + A10·H0)
 *   The floor modifies only D (the preconditioner), never the residual — the converged
 *   solution satisfies the EXACT quadratic head-loss law (DESIGN §4; DOMAIN §8: no state
 *   clamping inside the iteration).
 */
export function INIT_NETWORK_STEADY_STATE_GGA(
    net:    NetworkInput,
    layout: MeshLayout,
    source: GGASource
): NetworkSteadyState {
    // ── Pump injection (DESIGN §5.2 / D-I5-B): the self-consistent steadyHead coupling
    //    collapses analytically — q* = 2·Q0·√(1 − 1/HS_FACTOR), independent of the network. ──
    let inject: number;
    if (source.kind === 'pumpCurve') {
        if (!(HS_FACTOR > 1)) throw new Error('GGA: HS_FACTOR ≤ 1 → imaginary pump root');
        inject = 2.0 * source.Q0 * Math.sqrt(1.0 - 1.0 / HS_FACTOR);
    } else {
        inject = source.Q;
    }

    const g = buildGGAGraph(net, layout);
    const { nL, from, to, R, nU, uOfNode, fixedHead, pumpU } = g;

    // Numerical datum shift (gauge choice, DESIGN §3): solve heads referenced to the
    // highest fixed head, so the large absolute reservoir head (O(50)) does not swamp
    // the O(q*) continuity term in the RHS at sub-Q_LAM flow — a catastrophic-
    // cancellation guard for the laminar regime (test T8). GGA is invariant to a global
    // head shift; Href is added back to every output head. Inert for normal flows
    // (results unchanged within tolerance; bit-identity is unaffected — module unwired).
    let Href = -Infinity;
    for (const h of fixedHead.values()) if (h > Href) Href = h;
    const fixedShift = new Map<number, number>();
    for (const [n, h] of fixedHead) fixedShift.set(n, h - Href);

    const H = new Float64Array(nU);                     // unknown-head solution (shifted datum)
    const headOf = (node: number): number => {          // combined head: unknown H[u] | fixed H0 (shifted)
        const u = uOfNode.get(node);
        return u === undefined ? fixedShift.get(node)! : H[u];
    };

    const demand = new Float64Array(nU);                // nodal demand q (DESIGN §3 sign block)
    demand[pumpU] = -inject;                            // pump injection enters as negative demand

    const Q   = new Float64Array(nL).fill(inject);      // initial guess Q_k⁽⁰⁾ = inject (DESIGN §3)
    const inv = new Float64Array(nL);                   // D⁻¹ diagonal, recomputed each iteration
    const M   = new Float64Array(nU * nU);
    const rhs = new Float64Array(nU);

    let iter = 0, contRes = Infinity, enRes = Infinity, converged = false;
    for (iter = 1; iter <= GGA_MAX_ITER; iter++) {
        // Assemble M = A21·D⁻¹·A12 (SPD) and rhs = −A21·D⁻¹·(A11·Q + A10·H0) + (A21·Q − q).
        M.fill(0); rhs.fill(0);
        for (let k = 0; k < nL; k++) {
            const dk = 2.0 * R[k] * Math.max(Math.abs(Q[k]), Q_LAM);   // laminar floor (D only)
            inv[k]   = 1.0 / dk;
            const uf = uOfNode.get(from[k]);
            const ut = uOfNode.get(to[k]);
            // g0_k = (A11·Q + A10·H0)_k  (A12·H is NOT in the rhs — it is the unknown solved for)
            let g0 = R[k] * Q[k] * Math.abs(Q[k]);
            if (ut === undefined) g0 += fixedShift.get(to[k])!;       // A10 row: +H0 at fixed `to` (shifted)
            if (uf === undefined) g0 -= fixedShift.get(from[k])!;     // A10 row: −H0 at fixed `from` (shifted)
            // A12 column: −1 at `from`, +1 at `to`. Distribute into M and rhs.
            if (uf !== undefined) { M[uf * nU + uf] += inv[k]; rhs[uf] += inv[k] * g0 - Q[k]; }
            if (ut !== undefined) { M[ut * nU + ut] += inv[k]; rhs[ut] += -inv[k] * g0 + Q[k]; }
            if (uf !== undefined && ut !== undefined) { M[uf * nU + ut] -= inv[k]; M[ut * nU + uf] -= inv[k]; }
        }
        for (let i = 0; i < nU; i++) rhs[i] -= demand[i];             // + (A21·Q − q): subtract demand

        const Hnew = solveSPD_LDLt(M, rhs, nU);
        H.set(Hnew);

        // Update Q ← Q − D⁻¹·(A11·Q + A12·H_new + A10·H0); A11·Q + A12·H + A10·H0 = energy residual.
        for (let k = 0; k < nL; k++) {
            const energy = R[k] * Q[k] * Math.abs(Q[k]) + headOf(to[k]) - headOf(from[k]);
            Q[k] -= inv[k] * energy;
        }

        // Residuals at the new (Q, H): continuity at unknown nodes; energy at every link.
        contRes = 0; enRes = 0;
        const net_in = new Float64Array(nU);
        for (let k = 0; k < nL; k++) {
            const uf = uOfNode.get(from[k]);
            const ut = uOfNode.get(to[k]);
            if (uf !== undefined) net_in[uf] -= Q[k];                 // A21: −Q at `from`
            if (ut !== undefined) net_in[ut] += Q[k];                 // A21: +Q at `to`
            const energy = Math.abs(R[k] * Q[k] * Math.abs(Q[k]) + headOf(to[k]) - headOf(from[k]));
            if (energy > enRes) enRes = energy;
        }
        for (let i = 0; i < nU; i++) {
            const c = Math.abs(net_in[i] - demand[i]);
            if (c > contRes) contRes = c;
        }
        if (contRes < GGA_TOL_CONT && enRes < GGA_TOL_ENERGY) { converged = true; break; }
    }
    if (!converged)
        throw new Error(`GGA: no convergence in ${GGA_MAX_ITER} iters (cont=${contRes.toExponential(3)}, energy=${enRes.toExponential(3)})`);

    // steadyHead S = H[pumpNode] + Href (undo datum shift). For pumpCurve the §5.2
    // cancellation divided by S, so S>0 required.
    const S = H[pumpU] + Href;
    if (source.kind === 'pumpCurve' && !(S > 0))
        throw new Error(`GGA: non-positive steadyHead S=${S} (physically invalid pump configuration)`);

    // ── Build per-mesh-node head profile (DESIGN §8) ────────────────────────────────
    // Assembled in the shifted datum (headOf), then Href is added back to every node.
    const nodeHead = new Float64Array(layout.totalNodes);
    for (const [node] of uOfNode) nodeHead[node] = headOf(node);      // unknown network nodes
    for (const [node] of fixedHead) nodeHead[node] = headOf(node);    // fixed network nodes
    for (let k = 0; k < nL; k++) {                                    // interior nodes: march from `from`
        const pp     = layout.pipeParams[k];
        const v      = Q[k] / pp.A;
        const dH     = (pp.f * pp.dx * v * Math.abs(v)) / (2.0 * G * pp.D);   // signed: reversed flow rises
        const Hfrom  = headOf(from[k]);
        const first  = to[k] - layout.numSegments[k] + 1;            // first interior node of k's block
        for (let i = 1; i < pp.N; i++) nodeHead[first + i - 1] = Hfrom - i * dH;   // i=N is the `to` node (set above)
    }
    for (let n = 0; n < layout.totalNodes; n++) nodeHead[n] += Href;  // restore absolute datum

    // No spurious steady cavitation (spec §3c.5): every node head ≥ H_vap = Z + VAPOR_H_REL.
    for (let n = 0; n < layout.totalNodes; n++) {
        const Hvap = layout.Z[n] + VAPOR_H_REL;
        if (nodeHead[n] < Hvap)
            throw new Error(`GGA: spurious steady cavitation at node ${n} — head ${nodeHead[n].toPrecision(6)} < H_vap ${Hvap.toPrecision(6)} (Z=${layout.Z[n]}, margin ${(nodeHead[n] - Hvap).toExponential(3)})`);
    }

    // D2 audit-log (L078: a string, NOT a Float64 output array). Machine-readable head line.
    const auditLog =
        `INIT_NETWORK_STEADY_STATE_GGA mode=${source.kind} inject=${inject.toPrecision(12)} ` +
        `iters=${iter} contRes=${contRes.toExponential(3)} energyRes=${enRes.toExponential(3)} ` +
        `S=${S.toPrecision(12)} Hs=${(HS_FACTOR * S).toPrecision(12)} nL=${nL} nU=${nU} nFixed=${fixedHead.size}`;

    return { linkFlow: Q, nodeHead, steadyHead: S, pumpFlow: inject, auditLog };
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 7e — CALC_BC_VALVE (valve-closure BC — Phase 3.3 / S50)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Physically appended here, after Section 9.6 (EOF) — precedent: Section 9.6 itself.
// Logically Section 7e per spec §7's section-index reservation; `function` declarations
// hoist, so EOF placement is call-order-safe exactly as Section 9.6 is for runCore.

export type ClosureLaw =
  | { law: 'linear';    t0: number; T_close: number }
  | { law: 'parabolic'; t0: number; T_close: number; n: number }
  | { law: 'custom';    points: ReadonlyArray<{ t: number; tau: number }> };

export interface ValveParams {
    Cv0:         number;      // solver-internal SI coefficient [m^2.5/s] = Kv0/11493.9 (3.0b freeze;
                              // conversion happens at input-validation — the solver NEVER sees Kv0)
    law:         ClosureLaw;
    H_down:      number;      // fixed downstream head [m], DATUM-REFERENCED (not gauge), same frame
                              // as ReservoirParams.head — which it generalizes (spec §1.2: as
                              // Cv0 -> inf, H -> H_down reproduces CALC_BC_RESERVOIR). The
                              // user-facing input is a PRESSURE at the valve; the input layer
                              // converts it as Head = Pressure + Elevation and the solver never
                              // sees a pressure (DECISIONS.md 2026-08-09, S62 Step 3.9).
                              // The former "gauge; default 0" wording was never true of the
                              // arithmetic and is what produced a 7.6x-inflated driving head on an
                              // elevated valve (S60). Spec §1.2/§9 item 6 amended accordingly.
    check_valve: boolean;     // default false = reverse flow allowed (S47 ruling 7)
}

export function evalTau(law: ClosureLaw, t: number): number {
    switch (law.law) {
        case 'linear': {
            if (t < law.t0) return 1.0;
            const base = 1.0 - (t - law.t0) / law.T_close;
            return base <= 0.0 ? 0.0 : base;
        }
        case 'parabolic': {
            if (t < law.t0) return 1.0;
            const base = 1.0 - (t - law.t0) / law.T_close;
            return base <= 0.0 ? 0.0 : Math.pow(base, law.n);
        }
        case 'custom': {
            const pts = law.points;
            if (t <= pts[0].t) return Math.min(1.0, Math.max(0.0, pts[0].tau));           // hold-first
            const last = pts[pts.length - 1];
            if (t >= last.t) return Math.min(1.0, Math.max(0.0, last.tau));               // hold-last
            for (let i = 1; i < pts.length; i++) {
                if (t <= pts[i].t) {
                    const w = (t - pts[i - 1].t) / (pts[i].t - pts[i - 1].t);
                    const tau = pts[i - 1].tau + w * (pts[i].tau - pts[i - 1].tau);
                    return Math.min(1.0, Math.max(0.0, tau));                             // clamp [0,1]
                }
            }
            return Math.min(1.0, Math.max(0.0, last.tau));                                // unreachable guard
        }
    }
}

/**
 * BOX: CALC_BC_VALVE — valve-closure boundary (right end, last node) — Section 7e
 *
 * Spec: knowledge/valve_closure_spec.md §2–§3 (S48-released GATE, S47 rulings folded).
 * C+-only terminal (DOMAIN §3); Cv·τ(t) SI orifice discharge (spec §1.1; S48 §9-item-2 ruling);
 * two-step regime decision, NO Newton (DOMAIN §5 / Bug #8; S47 ruling 4);
 * τ = 0 ⇒ dead-end DGCM, pump-STOPPED mirror (spec §3.3; L107 sign double-swap);
 * valve-throat flow step-local, only signed pipe-side Q_in persisted via setQin
 * (S47 ruling 5; L108 — terminal node has no independent throat-flow slot).
 *
 * INPUT
 *   idx    last node index (totalNodes − 1)
 *   coefs  CharCoefs — only Cp and B1 used (no downstream pipe)
 *   valve  ValveParams (solver-internal Cv0 — never Kv0; spec §1.1)
 *   t      current simulation time [s]
 *   pipe   terminal pipe PipeParams (V_max = dx·A)
 */
function CALC_BC_VALVE(
    idx:       number,
    coefs:     CharCoefs,
    prevState: SystemState,
    newState:  SystemState,
    newFlow:   FlowState,
    grid:      GridParams,
    valve:     ValveParams,
    t:         number,
    pipe:      PipeParams
): void {
    const { Cp, B1 } = coefs;
    const dt        = grid.dt;
    const C_gas     = prevState.C_gas[idx];
    const Z         = prevState.Z[idx];
    const V_g_old   = prevState.V_g[idx];
    const V_max     = pipe.dx * pipe.A;
    const H_vap     = Z + VAPOR_H_REL;
    const H_abs_vap = H_BARO + VAPOR_H_REL;

    const tau = evalTau(valve.law, t);
    const Cv  = valve.Cv0 * tau;

    if (Cv <= 0.0) {
        // ── FULLY CLOSED: dead-end DGCM (spec §3.3 — pump-STOPPED mirror, C+ side) ──
        // DC-4 with Q_out = 0:  V_g = V_g_old − dt·(Cp − H)/B1 = a·H + b
        // Cm→Cp + Q_out→Q_in are TWO sign flips that cancel (spec §3.3 derivation) ⇒
        // intercept sign matches solver.ts:1066; a_coef POSITIVE (Bug #4 / DC-4).
        const a_coef   = +dt / B1;
        const b_coef   = V_g_old - dt * Cp / B1;
        const H_liquid = Cp;                       // closed-end fallback (mirror of :1067)

        let H         = SOLVE_DGCM_QUADRATIC(a_coef, b_coef, C_gas, Z, H_liquid);
        let V_g       = a_coef * H + b_coef;
        let C_gas_new = C_gas;

        if (V_g <= 0.0) {
            H   = H_liquid;                        // collapsed → closed-end reflection H = Cp
            V_g = 1e-12;
            if (H < H_vap) H = H_vap;              // vapor-floor safety
        } else if (H < H_vap) {
            H   = H_vap;                           // active cavitation: pin + reconcile
            V_g = a_coef * H_vap + b_coef;
            if (V_g <= 0.0) {
                V_g = 1e-12;                       // C_gas unchanged (Bug #3 discipline, DOMAIN §7)
            } else {
                if (V_g > V_max) V_g = V_max;
                C_gas_new = H_abs_vap * V_g;       // the ONLY C_gas update site (DOMAIN §7)
            }
        } else {
            if (V_g > V_max) V_g = V_max;          // partial collapse: clip only
        }

        newState.H[idx]     = H;
        newFlow.setQin(idx, (Cp - H) / B1);        // pipe-side face — SIGNED, UNCLAMPED (DOMAIN §6;
                                                   // Bug #7 mirror: clamping freezes node at H_vap)
        newState.V_g[idx]   = V_g;
        newState.C_gas[idx] = C_gas_new;
        return;                                    // valve-throat Q_out = 0: step-local, not persisted
    }

    // ── OPEN / PARTIALLY OPEN: two-step regime decision (spec §2.2 — v7 pattern, NO Newton) ──
    // Step 1 — liquid two-branch closed-form solve.
    const Cv2      = Cv * Cv;
    const disc_fwd = (Cv2 * B1) * (Cv2 * B1) + 4.0 * Cv2 * (Cp - valve.H_down);
    let H_liq  = Cp;                               // stands when both branches decline:
                                                   // check-valve clamp Q = 0, H = Cp (pump :1128 mirror)
    let solved = false;
    if (disc_fwd >= 0.0) {
        const Q_fwd = (-Cv2 * B1 + Math.sqrt(disc_fwd)) / 2.0;
        if (Q_fwd >= 0.0) { H_liq = Cp - B1 * Q_fwd; solved = true; }
    }
    if (!solved && !valve.check_valve) {
        // Reverse branch (S47 ruling 7). disc_rev > (Cv²·B1)² ≥ 0 whenever this branch is
        // reached (forward invalid ⟺ Cp < H_down ⟹ H_down − Cp > 0) — spec §2.2 well-posedness;
        // minus root is unconditionally the physical (negative) root there.
        const disc_rev = (Cv2 * B1) * (Cv2 * B1) + 4.0 * Cv2 * (valve.H_down - Cp);
        const Q_rev    = (Cv2 * B1 - Math.sqrt(disc_rev)) / 2.0;
        H_liq = Cp - B1 * Q_rev;
    }

    // Step 2 — regime decision (DOMAIN §5 / Bug #8 discipline: deterministic, single pass).
    if (H_liq >= H_vap) {
        newState.H[idx]     = H_liq;
        newFlow.setQin(idx, (Cp - H_liq) / B1);    // pipe-side face via (Cp−H)/B1 — S47 ruling 5 form
        newState.V_g[idx]   = 1e-12;               // liquid state: seed reset (v7 mirror :1141)
        newState.C_gas[idx] = C_gas;               // preserved — never zeroed (Bug #3)
        return;
    }

    // Cavitation regime: pin H = H_vap (spec §3.1 — pump running-cavitation mirror :1146-1168,
    // Cp↔Cm / Q_in_vap↔Q_out_vap swapped).
    const Q_in_vap  = (Cp - H_vap) / B1;                                     // pipe-side, SIGNED
    const Q_out_vap = Cv * Math.sqrt(Math.max(H_vap - valve.H_down, 0.0));   // throat, ONE-WAY v1
                     // ^ conservative one-way form; reverse-throat refill deferred with recorded
                     //   OVER-prediction bias of cavity volume/persistence (spec §3.1, S47 adjudicated)
    let V_g = V_g_old + dt * (Q_out_vap - Q_in_vap);                         // DC-4 net-outflow
    let C_gas_new = C_gas;
    if (V_g <= 1e-12) {
        V_g = 1e-12;                               // collapse seed; C_gas unchanged
    } else {
        if (V_g > V_max) V_g = V_max;
        C_gas_new = H_abs_vap * V_g;               // gas constant locked to vapor-floor state
    }
    newState.H[idx]     = H_vap;
    newFlow.setQin(idx, Q_in_vap);
    newState.V_g[idx]   = V_g;
    newState.C_gas[idx] = C_gas_new;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 7h — CALC_BC_QPRV (quick-acting pressure relief valve at the end valve — Q19)
// ═══════════════════════════════════════════════════════════════════════════════

/** Q19 QPRV, solver-facing (the input layer converts size / Kv, as the valve's Kv0 → Cv0). */
export interface QprvBC {
    Cq:          number;   // fully open: Q = Cq·√(H − Z) [m^2.5/s]; O1 reading Q[m³/h] = Kv·√(P/10)
    closingTime: number;   // full stroke, open → shut [s]
    runTime?:    number;   // Q21 sizing study only: run length [s] instead of 40·L/a; absent = today's run
}
const QPRV_OPEN_S        = 1.0;    // full stroke, shut → open [s] ("opens within 1 s", ruling 2026-10-28)
const QPRV_THRESHOLD_M   = 7.0;    // opens above reference + 7 m, closes below it (ruling 2026-10-28)
const QPRV_BISECT_ITERS  = 80;     // numerics: 80 halvings of a ≤ 1e4 m bracket, far below 1e-9 m

/**
 * BOX: CALC_BC_QPRV — the end-valve node (SECTION 7e) with a QPRV discharging there (Q19).
 *
 * Ruling 2026-10-28 (builder/inputs/Q19_surge_valves.md): right upstream of the line-end valve.
 * Placed AT the valve node (O2, the 10 m piece, pending). It discharges to atmosphere at the node
 * elevation, Q_r = s·Cq·√max(H − Z, 0), s ∈ [0,1] its opening. One C+ face feeds the valve throat
 * and the QPRV, both liquid orifices:
 *   (Cp − H)/B1 = Qv(H) + Q_r(H),   Qv = Cv·τ·√(H − H_down), signed, check valve, as SECTION 7e
 *
 * Opening (builder reading, LOOK-AT Q19): s opens while the head this step would be above the
 * threshold H_open = reference + 7 m, and closes while it would be below — at most a full stroke in
 * QPRV_OPEN_S opening, in the closing time closing. The opening s* that holds H = H_open this step
 * is closed form (the equation above at H = H_open); s = s* clipped to those rate limits and [0,1].
 * A previous-step relay instead jumps s by dt/QPRV_OPEN_S per step, i.e. B1·ΔQ metres per step, and
 * chatters at a mesh-dependent amplitude.
 *
 * Then H: the right side rises with H, the left falls — one root, by bisection (no Newton, DOMAIN
 * §5/§8). Writes nothing (done = false) when s = 0 or the root is at or below Z: there Q_r = 0, the
 * root is the valve's own, and the caller runs SECTION 7e unchanged (dead end, vapour, air valve).
 * Above Z the node is liquid (H > Z > H_vap): V_g = 1e-12 seed, C_gas preserved — SECTION 7e's liquid
 * branch (DOMAIN §7, Bug #3).
 */
function CALC_BC_QPRV(
    idx:       number,
    coefs:     CharCoefs,
    prevState: SystemState,
    newState:  SystemState,
    newFlow:   FlowState,
    grid:      GridParams,
    valve:     ValveParams,
    t:         number,
    qp:        QprvBC & { H_open: number },
    s_old:     number            // opening at the previous step
): { s: number; done: boolean } {
    const { Cp, B1 } = coefs;
    const Z  = prevState.Z[idx];
    const Cv = valve.Cv0 * evalTau(valve.law, t);
    const Qv = (H: number): number => {
        if (Cv <= 0.0) return 0.0;
        const d = H - valve.H_down;
        if (d >= 0.0) return Cv * Math.sqrt(d);
        return valve.check_valve ? 0.0 : -Cv * Math.sqrt(-d);
    };
    const Q_need = (Cp - qp.H_open) / B1 - Qv(qp.H_open);     // QPRV flow that holds H = H_open
    const s_hold = Q_need <= 0.0 ? 0.0
        : qp.H_open > Z ? Q_need / (qp.Cq * Math.sqrt(qp.H_open - Z)) : Infinity;
    const s = Math.max(0.0, Math.min(1.0, s_old + grid.dt / QPRV_OPEN_S,
                                     Math.max(s_hold, s_old - grid.dt / qp.closingTime)));
    if (s <= 0.0) return { s, done: false };
    const Cq_s = s * qp.Cq;
    const f = (H: number): number => (Cp - H) / B1 - Qv(H) - Cq_s * Math.sqrt(Math.max(H - Z, 0.0));
    if (!(f(Z) > 0.0)) return { s, done: false };
    let lo = Z, hi = Math.max(Cp, valve.H_down);   // f(lo) > 0 ≥ f(hi)
    for (let k = 0; k < QPRV_BISECT_ITERS; k++) {
        const mid = 0.5 * (lo + hi);
        if (f(mid) > 0.0) lo = mid; else hi = mid;
    }
    const H = 0.5 * (lo + hi);
    newState.H[idx]     = H;
    newFlow.setQin(idx, (Cp - H) / B1);            // pipe-side face, signed (S47 ruling 5 form)
    newState.V_g[idx]   = 1e-12;                   // liquid state: seed reset (SECTION 7e)
    newState.C_gas[idx] = prevState.C_gas[idx];    // preserved — never zeroed (Bug #3)
    return { s, done: true };
}

// ── PREPARE_valve — moved from runWaterHammerSimulationValve (Row 3.11 Unit A, S65) ──
// PURE MOVE of the entry point's former body, verbatim and in its existing statement order.
// Carries `ASSERT_VALVE_CV0` and the H_valve_steady derivation, both in their existing positions.
// The gate calls this and nothing else (`SPEC_S63.md` §2.2 item 3). The entry point calls it and
// then `runCore`, whose behaviour — including which guard throws first — is unchanged.
export function PREPARE_valve(
    inputPipes: PipeSection[],
    pump:       PumpParams,
    valve:      ValveParams,
    trace?:     (fn: string) => void,
    collect?:   (f: GateFinding) => void   // S67 D2 — see meshNetwork; omitted ⟹ guards throw
): SteadyStateResult {
    trace?.(PREPARE_valve.name);   // §8.3(a) seam: proves the gate and the run enter the SAME function
    // Steady state: fully-open valve passing Q0 sits at H_valve = H_down + (Q0/Cv0)²
    // (forward discharge law inverted, spec §1.2). Feeding this as the equivalent
    // reservoir head reuses INIT_STEADY_STATE unchanged; for the §1.4 anchor
    // (Cv0 = Q0/√30, H_down = 0) it reproduces the verified DEFAULT 30 m to
    // floating-point precision (algebraically exact; ~1e-14 FP noise via sqrt→div→square).
    // Step 3.12 / S63: input contract before the first use of valve.Cv0. SECTION 9.8.
    ASSERT_VALVE_CV0(valve.Cv0, 'runWaterHammerSimulationValve');
    // Q10: with a user curve the steady flow comes from the curve (DOMAIN §15 (iv)); `pump` becomes
    // a copy carrying the derived Q0. Contract asserts first (SECTION 9.11). No curve: unchanged.
    if (pump.curve !== undefined) {
        ASSERT_PUMP_CURVE(pump, 'runWaterHammerSimulationValve');
        pump = { ...pump, initialFlow: ASSERT_PUMP_DUTY_POINT(inputPipes, pump.curve, valve, pump.elevation,
                                                             'runWaterHammerSimulationValve') };
    }

    const Q0 = pump.initialFlow;
    const H_valve_steady = valve.H_down + (Q0 / valve.Cv0) * (Q0 / valve.Cv0);
    const reservoir: ReservoirParams = { head: H_valve_steady };
    const net    = legacyToNetwork(inputPipes, pump, reservoir);
    const layout = meshNetwork(net, collect);
    return { net, layout, pump, reservoir, valve,
             init: INIT_RUN_STATE(net, layout, pump, reservoir, 'legacy', undefined) };
}

export function runWaterHammerSimulationValve(
    inputPipes: PipeSection[],
    pump:       PumpParams,
    valve:      ValveParams,
    trace?:     (fn: string) => void,
    airValves?: AirValveBC[],              // Q14
    qprv?:      QprvBC                     // Q19
): SimulationResults {
    const prep = PREPARE_valve(inputPipes, pump, valve, trace);
    return runCore(prep.net, prep.layout, prep.pump, prep.reservoir, 'legacy', undefined, inputPipes, valve,
                   undefined, airValves, qprv);
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 7f — CALC_BC_RESERVOIR_UP (upstream constant-head reservoir BC — Phase 3.6 / S57)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Physically appended here, after Section 7e — same EOF-placement precedent (`function`
// declarations hoist, so the runCore call site at step 1 of the loop is call-order-safe).
// Logically Section 7f per gravity_fed_valve_spec.md §1.2's section-index assignment.

/**
 * BOX: CALC_BC_RESERVOIR_UP — upstream constant-head reservoir (left end, node 0) — Section 7f
 *
 * Spec: knowledge/gravity_fed_valve_spec.md §1.2 (S56-released GATE; DECISIONS 2026-07-23).
 * C−-only node-0 boundary (DOMAIN §3); left-right mirror of CALC_BC_RESERVOIR (Section 7d):
 * Cp→Cm, B1→B2, Q_in→Q_out, one sign flip ((H_res_up − Cm) vs (Cp − H_res)) — L107 double-swap;
 * same algebra as the pump BC's pipe face (H − Cm)/B (Section 7c) with H := H_res_up.
 * SIGNED, unclamped Q_out — reverse flow INTO the reservoir is physical surge relief; the
 * boundary reflects with r = −1 on both swings (spec §2.2). No cavitation branch: a constant-head
 * boundary cannot reach H_vap (head pinned by definition; input-time vapor guard in the entry
 * point). No DGCM, no quadratic — two assignments and a division, like its right-end twin.
 *
 * INPUT
 *   idx       node 0
 *   coefs     CharCoefs — only Cm and B2 used (no upstream pipe)
 *   H_res_up  fixed upstream reservoir head [m]
 *
 * OUTPUT
 *   H[idx]     = H_res_up                  (constant-head enforcement, held every step)
 *   Q_out[idx] = (H_res_up − Cm) / B2      (flow leaving node 0 into the pipe → qL[0][0],
 *                                           the slot feeding node 1's C+ read)
 *   V_g[idx]   = unchanged                 (reservoir has no gas cavity — mirror of Section 7d)
 *   C_gas[idx] = never touched             (DOMAIN §4/§7 — no cavity site here)
 *
 * NOT written: Q_in[0] (the pump-face slot, qPumpFace) — the pump face does not exist in this
 * topology and the slot is physics-inert when CALC_BC_PUMP_DGCM is not dispatched (its only
 * reads outside Section 7c are the q_in[0] output telemetry). q_in[0] therefore holds its
 * INIT_STEADY_STATE value Q0 for the whole run in gravity mode — telemetry caveat, RESULTS_S57.
 */
function CALC_BC_RESERVOIR_UP(
    idx:       number,
    coefs:     CharCoefs,
    prevState: SystemState,
    newState:  SystemState,
    newFlow:   FlowState,
    H_res_up:  number
): void {
    const { Cm, B2 } = coefs;
    newState.H[idx]     = H_res_up;
    newFlow.setQout(idx, (H_res_up - Cm) / B2);   // SIGNED, unclamped (DOMAIN §6 discipline)
    newState.V_g[idx]   = prevState.V_g[idx];
}

/** Upstream boundary input for the gravity-fed entry point (spec §1.3/§1.4 — both conventions).
 *  `head` form (application-facing): reservoir head known, Q0 derived by the closed form.
 *  Anchor form (fixture convention): Q0 + steady valve head known, H_res_up derived. */
export type GravityUpstream =
  | { head: number; elevation: number }
  | { Q0: number; H_valve_steady: number; elevation: number };

/** Trip/halt placeholder for the never-dispatched pump-params carrier: far beyond any
 *  maxTime = 40·travelTime (spec §1.4 note 2 — trip disabled; also keeps the settle
 *  early-exit inert, so gravity runs are deterministic fixed-length). */
const GRAVITY_TRIP_NEVER_S = 1e9;

/**
 * BOX: runWaterHammerSimulationGravityValve — gravity-fed scenario entry point (Section 7f)
 *
 * Spec: knowledge/gravity_fed_valve_spec.md §1.3–§1.4; OI-8 (general selectable topology).
 * Topology: upstream constant-head reservoir (node 0, SECTION 7f BC) → descending/horizontal
 * chain → CALC_BC_VALVE at the terminal (SECTION 7e, unchanged). No pump, no check valves —
 * the pump-params carrier below is a meshing/init vehicle only (legacyToNetwork types node 0
 * 'pump' as a BFS anchor — a label, not physics) and CALC_BC_PUMP_DGCM is never dispatched.
 * No trip inputs are accepted: pump trip and gravity dispatch are mutually exclusive by
 * construction (spec §1.4 note 3).
 *
 * Steady state (§1.3, closed form — no pump curve, no iteration):
 *   Q0 = sqrt((H_res_up − H_down) / (Σ f·L/(D·2g·A²) + 1/Cv0²))
 * INIT_STEADY_STATE is reused unchanged via the equivalent-head precedent (Section 7e entry
 * point): reservoir carries H_valve_steady = H_down + (Q0/Cv0)², and the initialiser's returned
 * pumpHead is H_res_up by construction. In anchor form, H_res_up is derived with the SAME FP
 * ops as INIT_STEADY_STATE's totalLoss ⟹ the transient hold head equals the init head
 * bit-exactly (zero-ripple steady hold — the L090b/L084-class negative control, spec §1.3).
 * In head form the user's head is enforced verbatim (init mismatch ≲1e-13 m, decays).
 */
// ── PREPARE_gravityValve — moved from runWaterHammerSimulationGravityValve (Row 3.11 Unit A, S65) ──
// PURE MOVE of the entry point's former body, verbatim and in its existing statement order.
// The heaviest path: `ASSERT_VALVE_CV0`, `ASSERT_GRAVITY_DRIVING_HEAD`, the two-convention
// (Q0, H_valve_steady) resolution, the pump carrier, the totalLoss/H_res_up derivation, AND the
// inline vapor guard — all moved verbatim, in order. The vapor guard in particular must stay
// BETWEEN meshNetwork and the init: move it after, and a gravity input that reports the vapor
// message today would report ASSERT_INIT_ADMISSIBLE's message instead. Guard ordering is
// behaviour, not detail (§2.2 item 2).
// The gate calls this and nothing else (`SPEC_S63.md` §2.2 item 3). The entry point calls it and
// then `runCore`, whose behaviour — including which guard throws first — is unchanged.
export function PREPARE_gravityValve(
    inputPipes: PipeSection[],
    upstream:   GravityUpstream,
    valve:      ValveParams,
    trace?:     (fn: string) => void,
    collect?:   (f: GateFinding) => void   // S67 D2 — see meshNetwork; omitted ⟹ guards throw
): SteadyStateResult {
    trace?.(PREPARE_gravityValve.name);   // §8.3(a) seam: proves the gate and the run enter the SAME function
    // Step 3.12 / S63: input contract before the first use of valve.Cv0. SECTION 9.8.
    ASSERT_VALVE_CV0(valve.Cv0, 'runWaterHammerSimulationGravityValve');

    // §1.3 closed-form steady triangle — resolve (Q0, H_valve_steady) from either convention.
    let Q0: number;
    let H_valve_steady: number;
    if ('head' in upstream) {
        // Step 3.12 / S63: the head form is the ONLY branch that solves for Q0 from
        // (head − H_down); the anchor form below supplies Q0 directly and has nothing to guard.
        ASSERT_GRAVITY_DRIVING_HEAD(upstream.head, valve.H_down,
                                    'runWaterHammerSimulationGravityValve');
        const F = inputPipes.reduce((acc, p) => {
            const A = Math.PI * p.diameter * p.diameter / 4.0;
            return acc + (p.frictionFactor * p.length) / (p.diameter * 2.0 * G * A * A);
        }, 0.0);
        Q0 = Math.sqrt((upstream.head - valve.H_down) / (F + 1.0 / (valve.Cv0 * valve.Cv0)));
        H_valve_steady = valve.H_down + (Q0 / valve.Cv0) * (Q0 / valve.Cv0);   // Section 7e form
    } else {
        Q0 = upstream.Q0;
        H_valve_steady = upstream.H_valve_steady;
    }

    // Pump-params carrier (§1.4 note 2): never dispatched. elevation = node-0 elevation
    // (feeds legacyToNetwork n0 + steadyPressureHead); initialHead is a UI-only no-op
    // (DECISIONS 2026-05-06; runWaterHammerSimulationNetwork precedent).
    const pump: PumpParams = {
        initialHead: 0,
        initialFlow: Q0,
        tripTime:    GRAVITY_TRIP_NEVER_S,
        haltTime:    GRAVITY_TRIP_NEVER_S,
        elevation:   upstream.elevation
    };
    const reservoir: ReservoirParams = { head: H_valve_steady };
    const net    = legacyToNetwork(inputPipes, pump, reservoir);
    const layout = meshNetwork(net, collect);

    // Enforced boundary head. Anchor form: H_valve_steady + totalLoss with token-identical FP
    // ops to INIT_STEADY_STATE ⟹ bit-equal to runCore's pumpHead. Head form: user head verbatim.
    const totalLoss = layout.pipeParams.reduce((acc, p) => {
        const v = Q0 / p.A;
        return acc + (p.f * p.dx * p.N * v * v) / (2.0 * G * p.D);
    }, 0.0);
    const H_res_up = 'head' in upstream ? upstream.head : H_valve_steady + totalLoss;

    // Input-time vapor guard (spec §1.2/§3.5, 3.0b-equivalent validation level).
    if (!(H_res_up > upstream.elevation + VAPOR_H_REL)) {
        throw new Error(
            `Upstream reservoir head (${H_res_up} m) must sit above the local vapor head at ` +
            `node 0 (${upstream.elevation + VAPOR_H_REL} m = node-0 elevation + vapor head).`
        );
    }
    return { net, layout, pump, reservoir, valve, upstreamReservoir: { head: H_res_up },
             init: INIT_RUN_STATE(net, layout, pump, reservoir, 'legacy', undefined) };
}

export function runWaterHammerSimulationGravityValve(
    inputPipes: PipeSection[],
    upstream:   GravityUpstream,
    valve:      ValveParams,
    trace?:     (fn: string) => void,
    airValves?: AirValveBC[],              // Q14
    qprv?:      QprvBC                     // Q19
): SimulationResults {
    const prep = PREPARE_gravityValve(inputPipes, upstream, valve, trace);
    return runCore(prep.net, prep.layout, prep.pump, prep.reservoir, 'legacy', undefined, inputPipes, valve,
                   prep.upstreamReservoir, airValves, qprv);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 9.7 — INITIAL-CONDITION ADMISSIBILITY  (Fixes 2+3, Step 3.9 / S62)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Neither init path validated its own output. INIT_STEADY_STATE (:1362-1373) marches down
// subtracting friction and writes H unconditionally; the only init-time guard (:2626) tests
// node 0 alone. S60 diagnosed a real gravity-fed run whose computed steady state placed 276 of
// 345 nodes below vapor pressure and gave the valve node a NEGATIVE C_gas — never clamped,
// because the vapor floor is enforced in the transient loop, not at initialisation.
//
// The floor asserted here is the vapor floor H_vap = Z + VAPOR_H_REL. That is the invariant the
// transient loop actually enforces at every DGCM node and every CAVITATING boundary condition
// (:786, :861, :956, :1079, :2517) and the one INIT_NETWORK_STEADY_STATE_GGA has always enforced
// at :2394-2399.   [line refs re-based S65 after the Unit A split] Note the fixed-head BCs (CALC_BC_RESERVOIR, CALC_BC_RESERVOIR_UP) pin H with no
// vapor check at all, so this validator is BROADER than that justification, not narrower — at
// those nodes it is the only init-time floor there is.
// Legacy and GGA init therefore carry an identical admissibility contract; before this, legacy
// accepted states GGA rejected.
//
// NOT the absolute-vacuum floor Z - H_BARO: that sits 0.53 m lower, and the band between them is
// exactly the BUGLOG Issue #3 regime (C_gas below H_abs_vap*V_g, where the DGCM quadratic's only
// V_g > 0 root is the vacuum root — vapor floor every step, phantom cavities, chattering).
//
// ADD-ONLY (L068): read-only, throws or returns. Writes nothing, so DC-4/DC-7 cavity bookkeeping
// is untouched and every frozen baseline is bit-identical by construction.
function ASSERT_INIT_ADMISSIBLE(st: SystemState, totalNodes: number, ctx: string): void {
    const f = FIND_INIT_ADMISSIBLE(st, totalNodes);
    if (f.length) throw new Error(`${ctx}: ${f[0].assertText ?? f[0].message}`);
}

/**
 * B7 — initial-condition admissibility. Pure; returns EVERY offending node, in the same order the
 * assert would have hit them.
 *
 * ORDERING IS LOAD-BEARING. The original is ONE loop that tests vapour then `C_gas` at each node and
 * throws immediately. So this walks nodes in the same order and emits vapour before `C_gas` AT EACH
 * NODE — not all vapour findings followed by all `C_gas` findings. Two separate passes would put a
 * later node's vapour finding at `f[0]` where the original threw an earlier node's `C_gas` message,
 * silently breaking the byte-identity of the thrown text.
 *
 * WORDING SPLITS FROM THE THROWN TEXT HERE, and only here (`assertText`). The thrown sentence ends
 * "check the downstream boundary convention and the elevation profile" — it tells the reader to fix
 * their input. But being below vapour is a TOOL-LIMIT state: the pipeline is often fine and simply
 * runs partly full, which this solver has no representation for (DC-12 SCOPE LIMIT, L150). §4.3
 * forbids invalid-input phrasing there. The thrown text predates that rule (S62, 2026-08-09; the
 * scope-limit block was added 2026-08-12) and never reached a user before this row, so it is kept
 * verbatim for the throw — it is developer-facing and `kv_sensitivity_probe_S62.ts` parses it —
 * while the gate shows compliant wording.
 */
export function FIND_INIT_ADMISSIBLE(
    st: SystemState,
    totalNodes: number,
    /**
     * Which §4.4 wording the B7 message takes. `SPEC_S63.md` §4.4 is explicit that the two differ:
     * §5's "runs partly full and keeps delivering" reasoning assumes a source reservoir at a known
     * elevation and **has no analogue for a pump-fed main**, where B7 must instead say the pipeline
     * cannot stay full at this operating point. DC-12's SCOPE LIMIT block, which supplies the
     * partly-full reasoning, is written for gravity mains only.
     *
     * Defaults to `'gravity'`, which is the wording S66 shipped, so the throw path and every
     * existing caller are unchanged. The gate passes the real scenario class.
     */
    scenarioClass: 'gravity' | 'pump' = 'gravity',
): GateFinding[] {
    const out: GateFinding[] = [];
    for (let n = 0; n < totalNodes; n++) {
        const Hvap = st.Z[n] + VAPOR_H_REL;
        // `!(x >= y)` rather than `x < y`: this form also rejects NaN, which a `<` test passes.
        if (!(st.H[n] >= Hvap)) {
            out.push({
                code: 'B7', severity: 'blocking', kind: 'tool-limit',
                where: `node ${n} (elevation ${st.Z[n]} m)`,
                message:
                    `the starting condition at node ${n} sits below vapor pressure — ` +
                    `H=${st.H[n].toPrecision(6)} < H_vap=${Hvap.toPrecision(6)} (Z=${st.Z[n]}, ` +
                    `margin ${(st.H[n] - Hvap).toExponential(3)}). Water cannot hold a pressure ` +
                    `that low, so the column would separate at this point and the pipe would not ` +
                    `run full there. This program models a full pipe only, so it cannot compute a ` +
                    `transient for this starting condition. That is a limit of this tool, not a ` +
                    (scenarioClass === 'gravity'
                        // §5's gravity framing: a real main CAN run partly full past a high point.
                        ? `verdict on the pipeline — a main can run partly full past a high point ` +
                          `and keep delivering.`
                        // §4.4: that claim is unestablished for a pump-fed main, where the driving
                        // head comes from a pump curve rather than a fixed water level. State the
                        // shortfall and stop — no control-point flow, no partly-full promise.
                        : `verdict on the pipeline — but at this operating point, with this ` +
                          `elevation profile, the line cannot be kept full: it falls ` +
                          `${Math.abs(st.H[n] - Hvap).toPrecision(4)} m short here. A different ` +
                          `duty point or a different profile may well stay full.`),
                assertText:
                    `the computed steady state at node ${n} is below vapor pressure — ` +
                    `H=${st.H[n].toPrecision(6)} < H_vap=${Hvap.toPrecision(6)} (Z=${st.Z[n]}, ` +
                    `margin ${(st.H[n] - Hvap).toExponential(3)}). A liquid column cannot hold this ` +
                    `state at rest, so it is not a steady state — check the downstream boundary ` +
                    `convention and the elevation profile.`
            });
        }
        // Strictly weaker than the head test above once C_gas is populated from it (S62 F8:
        // C_gas = (H - Z + H_BARO)*V_g, so C_gas > 0 <=> H > Z - H_BARO, given V_g > 0).
        // Retained as the NaN / zero-area / degenerate-V_g catch, NOT as independent evidence.
        //
        // `else if`, NOT a second `if` — corrected S67 after the action audit. Because this test is
        // strictly weaker, `H_vap = Z - 9.8` sits just 0.53 m above `Z - H_BARO`, so ANY node whose
        // vapour margin is worse than -0.53 m fails both. S66's two independent `if`s therefore
        // emitted B7 (tool-limit) AND B1 ("Check pipe diameter and length") for the same node — a
        // §4.3 violation on a node whose diameter and length are fine, and it fired on 17 nodes of
        // the flagship B7 case. `else if` also restores the ORIGINAL semantics exactly: the assert
        // threw on whichever test failed first and never evaluated the second at that node. `f[0]`
        // is unaffected either way, so the thrown text stays byte-identical.
        else if (!(st.C_gas[n] > 0)) {
            // B1, NOT B7 — corrected S67, same spec-wins rule the user applied to B5's second arm.
            // §4.1's B7 row is "computed starting head below vapour at any point", which is the arm
            // ABOVE; and §4.1 places B7 in the tool-limit group, so a B7 tagged contract-violation
            // (as S66 had this) cannot be right either way. What this arm actually catches is a
            // degenerate geometry or a non-numeric input — zero area, NaN head — which is precisely
            // §4.1's B1 row, "any required input empty, non-numeric, or not finite ... names which
            // field". As B1 the existing wording is legal: contract violations SHOULD name the
            // offending input, so "Check pipe diameter and length" stays, unchanged.
            // Classification only — the loop order, the text and the thrown `f[0]` are untouched.
            out.push({
                code: 'B1', severity: 'blocking', kind: 'contract-violation',
                where: `node ${n}`,
                message:
                    `initial C_gas at node ${n} is not positive (${st.C_gas[n]}) — C_gas is ` +
                    `absolute pressure x volume and must be > 0. Check pipe diameter and length ` +
                    `(V_g = ALPHA_G0*dx*A) as well as the initial head.`
            });
        }
    }
    return out;
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 9.8 — VALVE INPUT-CONTRACT GUARDS  (Step 3.12 / S63)
// ═══════════════════════════════════════════════════════════════════════════════
//
// SECTION 9.7 validates a COMPUTED steady state. These validate the RAW INPUTS that produce it,
// at the two valve entry points, before any arithmetic consumes them. The distinction matters:
// S63 measured four bad inputs that 9.7 does not stop, and two more that it stops with the wrong
// diagnosis (`findings/phase_3.12_guards/RESULTS_S63.md`, pre-guard arm).
//
// Why 9.7 is not sufficient here — measured, not argued:
//   * Cv0 < 0, either entry point: the init snapshot squares the sign away — H_valve_steady =
//     H_down + (Q0/Cv0)^2 is identical to the +Cv0 run to the last digit, so 9.7 sees an
//     admissible state and passes. But CALC_BC_VALVE consumes Cv = Cv0*tau UN-SQUARED (:2404)
//     and routes Cv <= 0 to the FULLY-CLOSED dead-end branch (:2406). The valve is therefore shut
//     from step 1 for the whole run. Measured on the S63 topology: t=0 head identical to the
//     control (84.70591594317169), step 1 head 363.895 against the control's 84.706. The run
//     completes and returns a full, plausible-looking surge history for a valve that was never
//     open. This is the silent-wrong-answer class DC-12 was written about, one layer earlier.
//   * Cv0 = 0 at Section 7e: Q0 is pump.initialFlow (finite, user-supplied, NOT derived through
//     Cv0), so Q0/Cv0 = Infinity and H_valve_steady = +Infinity. 9.7 tests `!(H >= H_vap)` and
//     `!(C_gas > 0)`; +Infinity passes BOTH. Measured: 1601 frames returned, head +Infinity at
//     t=0 and step 1, NaN by step 2. Nothing anywhere refuses it.
//     (At Section 7f the same input instead gives 0/0 = NaN, which 9.7 does catch — but reports
//     as "below vapor pressure at node 0", pointing at the elevation profile rather than at the
//     coefficient. Right refusal, wrong cause.)
//   * head <= H_down, head form: `:2648`'s vapor guard tests H_res_up (the user's own finite
//     head) and passes. head < H_down then yields sqrt(negative) = NaN — caught by 9.7, again
//     misattributed to vapor pressure. head == H_down yields Q0 = 0 exactly, which is finite and
//     admissible, so it runs — and does NOT hold: the valve node drops from 100 m to the vapor
//     floor 40.2 m at step 1 while its upstream neighbour goes NaN immediately, and the NaN
//     reaches the valve node itself at frame 120. 1600 of 1601 frames contain non-finite heads,
//     and all 1601 are still returned. Figures measured by `findings/phase_3.12_guards/
//     anchor_probe_S63.ts` (cases A1/R1); see RESULTS_S63.md §6 for the full record.
//     The zero-flow state is NOT an artifact of this entry point or of the anchor form: the root
//     cause is Re = 0 at :1566 -> COMPUTE_MIAB_PIPE_PARAMS (:413-417) returning k_u = +Infinity,
//     whose MIAB term is then Infinity*0 = NaN. Case R1 reproduces it identically from
//     runWaterHammerSimulationValve with initialFlow = 0 and every other input valid, so it is
//     reachable from EVERY entry point. Out of row 3.12 scope; logged, not fixed.
//
// ADD-ONLY (L068): both functions are read-only and either throw or return. No state is written,
// no arithmetic is altered, so every input that was valid before follows a bit-identical path and
// the frozen baselines are unchanged by construction — the SECTION 9.7 precedent (S62).
//
// UNIT BOUNDARY (3.0b freeze, :2322-2323): the solver never sees Kv0, so these messages name Cv0
// and describe the UI conversion in words only. KV0_TO_CV0 stays in scenario_dispatch.ts (:39).

/**
 * Valve flow coefficient must be strictly positive, at BOTH valve entry points.
 *
 * `!(Cv0 > 0)` rather than `Cv0 <= 0`: this form also rejects NaN, which a `<=` test passes —
 * the same idiom and the same reason as SECTION 9.7.
 *
 * Path-independence is the point of the shared helper: a guard on one entry point only would
 * leave the two paths with different admissibility contracts, which L138/L139 and DC-12
 * ("Both init paths carry the same contract") both classify as a defect in its own right.
 */
function ASSERT_VALVE_CV0(Cv0: number, ctx: string): void {
    // FINITE and positive. `Number.isFinite` rejects NaN and both infinities; the `> 0` test then
    // rejects zero and negatives. `!(Cv0 > 0)` alone would ADMIT +Infinity, and +Infinity is not
    // the harmless "wide-open valve" limit the ValveParams docstring (:2327) describes. Measured
    // on the S63 topology: H_valve_steady = H_down = 50 as documented, but CALC_BC_VALVE then
    // evaluates (-Infinity + Infinity)/2 = NaN for Q_fwd, NaN >= H_vap is false, and the valve
    // node is pinned at the vapor floor 40.2 m for 1600 of 1601 frames — the code does the
    // OPPOSITE of its own documented limit, silently. Large-but-finite overflows the same way
    // (Cv0 = 1e150: 371 frames pinned at vapor). Both return a full, meaningless history.
    const f = FIND_VALVE_CV0(Cv0);
    if (f.length) throw new Error(`${ctx}: ${f[0].assertText ?? f[0].message}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 9.10 — GATE FINDINGS  (Row 3.11 Unit B, S66)
// ═══════════════════════════════════════════════════════════════════════════════
//
// `SPEC_S63.md` §4 requires the gate to LIST its checks with verdicts. A guard that throws cannot
// appear in a list of checks that return verdicts — so each `ASSERT_` guard is split into a pure
// `FIND_` predicate that returns findings and never throws, plus the existing `ASSERT_` wrapper that
// throws the first one. The assert keeps its exact call site (DC-12 names it), and because `FIND_`
// returns the message WITHOUT the `ctx:` prefix that the wrapper prepends, thrown messages stay
// byte-identical — which the shipped guard fixtures assert on.
//
// The gate gets EVERY finding rather than the first: `ASSERT_INIT_ADMISSIBLE` throws at the first
// bad node, while `FIND_INIT_ADMISSIBLE` reports all of them, which is what lets a chart mark the
// offending reach (`SPEC_S63.md` §5.3) instead of a single point.

/** Exactly two severity tiers, program-wide. A third is forbidden — CKPT_B2_AMENDMENT_BRIEF §2. */
export type GateSeverity = 'blocking' | 'advisory';

/**
 * `SPEC_S63.md` §4.1's split, and it GOVERNS WORDING: a `tool-limit` message describes what this
 * program cannot compute and may never say or imply that the input is invalid (§4.3, L150). A
 * `contract-violation` message names the offending input, because the numbers given cannot describe
 * any pipeline.
 */
export type GateKind = 'contract-violation' | 'tool-limit';

export type GateCode =
    'B1' | 'B2' | 'B3' | 'B4' | 'B5' | 'B6' | 'B7' | 'B8' | 'B9' |
    'B10' | 'B11' |   // Q10: invalid pump curve | suction pressure too low (internal codes, never shown)
    'A1' | 'A2' | 'A3' | 'A4' | 'A5' |
    'A6' | 'A7';      // Q10: pump curve hump removed | duty point outside pump curve

export interface GateFinding {
    code:     GateCode;
    severity: GateSeverity;
    kind:     GateKind;
    /** §4.2: every finding names its location — advisory items to the same detail as blocking. */
    where:    string;
    /** User-facing. Governed by `kind` per §4.3. */
    message:  string;
    /**
     * Legacy thrown text, present ONLY where it must differ from `message`. One case exists:
     * `ASSERT_INIT_ADMISSIBLE`'s text ends by telling the reader to check their input, which §4.3
     * forbids for a tool-limit state. That text predates the rule (written S62-08-09; DC-12's
     * SCOPE LIMIT block added 2026-08-12) and never reached a user before this row. It is kept
     * byte-identical for the throw — it is developer-facing, and a shipped probe parses it — while
     * the gate shows compliant wording. Everywhere else the two are the same string.
     */
    assertText?: string;
}

/** `severity` is a pure function of `code`, so an advisory can never be promoted by accident. */
export function GATE_SEVERITY(code: GateCode): GateSeverity {
    return code.charAt(0) === 'A' ? 'advisory' : 'blocking';
}

/**
 * Datum-referenced head below which the liquid at elevation `Z` vaporises [m].
 *
 * Exported for the checks engine's A3 (margin above the vapour line) so it reads THIS floor rather
 * than declaring one — `VAPOR_H_REL` is module-private and must stay that way. Advisory A3 and the
 * blocking B7 must agree on where the line is; two constants for one line is the §2 failure the
 * whole row exists to prevent. `ASSERT_INIT_ADMISSIBLE` / `FIND_INIT_ADMISSIBLE` compute the same
 * `st.Z[n] + VAPOR_H_REL` inline and are left untouched — a shared helper there would have been an
 * edit inside the byte-identity envelope for no gain.
 */
export function VAPOR_HEAD_AT(Z: number): number {
    return Z + VAPOR_H_REL;
}

/** B6 — the valve coefficient. Pure; the wording is `ASSERT_VALVE_CV0`'s, moved unchanged. */
export function FIND_VALVE_CV0(Cv0: number): GateFinding[] {
    if (!Number.isFinite(Cv0) || !(Cv0 > 0)) {
        return [{
            code: 'B6', severity: 'blocking', kind: 'contract-violation',
            where: 'Valve flow coefficient (Kv)',
            message:
                `the valve flow coefficient must be a finite number greater than zero ` +
                `(given Cv0 = ${Cv0}). Cv0 is the solver-side coefficient the application converts ` +
                `from the Kv0 you enter, so a zero, negative, missing, or non-numeric Kv0 arrives ` +
                `here. A valve that is shut for the entire run is not a valve-closure simulation: ` +
                `zero divides in the steady-state head H_down + (Q0/Cv0)^2, and a negative value ` +
                `passes that squared expression unchanged while CALC_BC_VALVE holds the valve fully ` +
                `closed from the first timestep — which would return a complete but meaningless ` +
                `pressure history. Enter the valve's fully-open flow coefficient.`
        }];
    }
    return [];
}

/**
 * Gravity head form only: the upstream reservoir head must strictly exceed the downstream head
 * at the valve, or the closed-form steady triangle Q0 = sqrt((head - H_down)/(...)) has no
 * usable root.
 *
 * The two rejected cases are physically DIFFERENT and are reported differently (L150 — "state
 * which one you mean"; DC-12 scope-limit note). Neither is a model-class refusal: both are
 * genuine input errors about this solver's contract, not a claim that the described system
 * cannot exist.
 *
 * NOT applied to the anchor form `{Q0, H_valve_steady}`, which supplies Q0 directly and never
 * evaluates this difference.
 *
 * This rejection SET duplicates the UI-layer guard in scenario_dispatch.ts (:166). That is one
 * gate placed at two layers, not two independent checks (L147) — it exists here because a direct
 * solver caller, including every fixture in findings/, bypasses the UI layer entirely.
 *
 * SCOPE, stated so the message is not read wider than it is: this validates the HEAD-FORM entry
 * contract, not the physical system. A downstream head above the source head is representable in
 * the transient — CALC_BC_VALVE supports reverse flow when check_valve is false (:2455-2462, S47
 * ruling 7) — but this entry point initialises FORWARD-FLOW gravity mains from a closed-form
 * steady triangle, and that triangle has no real root here. Distinct again from DC-12's
 * sub-vapor gravity case, which is a model-class limit rather than an input error (L150).
 */
function ASSERT_GRAVITY_DRIVING_HEAD(head: number, H_down: number, ctx: string): void {
    // Finiteness first, for the same reason as ASSERT_VALVE_CV0: `!(head > H_down)` alone ADMITS
    // head = +Infinity (Infinity > any finite H_down is true), and `:2648`'s vapor guard also
    // passes trivially on an infinite H_res_up — so Q0, H_valve_steady and H_res_up all become
    // Infinity and reach INIT_STEADY_STATE unrefused. NaN in either argument is caught by the
    // `!(head > H_down)` form below, but is named explicitly here so the message says which.
    const f = FIND_GRAVITY_DRIVING_HEAD(head, H_down);
    if (f.length) throw new Error(`${ctx}: ${f[0].assertText ?? f[0].message}`);
}

/**
 * B5 — the gravity driving head. Pure; wording moved unchanged from `ASSERT_GRAVITY_DRIVING_HEAD`.
 *
 * BOTH ARMS ARE `contract-violation`. S66 tagged the second arm `tool-limit`, reasoning that a
 * reservoir at or below the valve is a real, buildable arrangement this entry point simply does not
 * initialise. That reasoning is sound about the physics but it contradicts the spec: `SPEC_S63.md`
 * §4.1 and `CKPT_B2_AMENDMENT_BRIEF_S64.md` §2 BOTH list B5 among the contract violations, and both
 * post-date L150 (ruled 2026-08-16 and 2026-08-20; L150 is 2026-08-12), so the classification was
 * made with L150 already in view. Corrected S67 on the user's ruling — spec wins.
 *
 * This is not cosmetic: `kind` selects the wording rule. Under §4.3 a `tool-limit` message may never
 * tell the user to check their input, and this arm's text ends by doing exactly that ("Check the
 * downstream pressure at the valve..."). Mis-tagged, it fails the §8.4 wording assertion; tagged as
 * the spec has it, the existing text is compliant and is preserved byte-for-byte.
 */
export function FIND_GRAVITY_DRIVING_HEAD(head: number, H_down: number): GateFinding[] {
    if (!Number.isFinite(head) || !Number.isFinite(H_down)) {
        return [{
            code: 'B5', severity: 'blocking', kind: 'contract-violation',
            where: 'Upstream reservoir head / downstream head at the valve',
            message:
                `the upstream reservoir head and the downstream head at the valve must both ` +
                `be finite numbers (given head = ${head} m, H_down = ${H_down} m). A missing or ` +
                `non-numeric entry reaches the solver as NaN, and an unbounded one propagates ` +
                `through the whole steady-state profile without ever being refused.`
        }];
    }
    if (!(head > H_down)) {
        const why = (head === H_down)
            ? `They are equal, so the steady flow is exactly zero. A system at rest is a valid ` +
              `physical state, but it is not a transient to simulate — there is no flow for the ` +
              `valve to stop. Raise the reservoir head or lower the downstream head at the valve.`
            : `The reservoir sits below the valve's downstream boundary, so the closed-form ` +
              `steady triangle this entry point starts from has no real root — it initialises ` +
              `forward-flow gravity mains only. This is a limit of how the run is set up, not a ` +
              `claim that the system you described cannot exist. Check the downstream pressure ` +
              `at the valve: it is measured AT the valve, and the valve's own elevation is ` +
              `added to it automatically.`;
        return [{
            code: 'B5', severity: 'blocking', kind: 'contract-violation',   // S67: spec §4.1 wins
            where: 'Upstream reservoir head / downstream head at the valve',
            message:
                `the upstream reservoir head (${head} m) must be greater than the downstream ` +
                `head at the valve (${H_down} m) — both datum-referenced. ${why}`
        }];
    }
    return [];
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 9.11 — PUMP-CURVE INPUT CONTRACT  (Q10, DOMAIN §15 (vii))
// ═══════════════════════════════════════════════════════════════════════════════
//
// Same split as SECTION 9.8/9.10: pure `FIND_` predicates the gate lists, `ASSERT_` wrappers that
// `PREPARE_valve` calls before the curve is used. One gate at two layers (L147): the gate reaches
// the same `FIND_` calls through `scenario_dispatch.ts`, so a direct solver caller is refused too.
// Every comparison is in the NaN-refusing form `!(x > y)` (DC-13/DC-14).

const PUMP_CURVE_FAIL = 'Invalid pump curve';

function pumpCurveFinding(message: string): GateFinding {
    return { code: 'B10', severity: GATE_SEVERITY('B10'), kind: 'contract-violation',
             where: 'Pump curve', message: `${PUMP_CURVE_FAIL}: ${message}` };
}

/** B10 — the fitted curve itself: a, b, c, H_suct finite; a < 0; b ≤ 0; c > 0. */
export function FIND_PUMP_CURVE(curve: PumpCurve): GateFinding[] {
    const { a, b, c, H_suct } = curve;
    if (![a, b, c, H_suct].every(Number.isFinite)) {
        return [pumpCurveFinding(`coefficients and suction head must be finite (a = ${a}, b = ${b}, ` +
                                 `c = ${c}, H_suct = ${H_suct}).`)];
    }
    if (!(a < 0) || !(b <= 0) || !(c > 0)) {
        return [pumpCurveFinding(`the curve must fall with flow and have no hump: a < 0, b ≤ 0, c > 0 ` +
                                 `(given a = ${a}, b = ${b}, c = ${c}).`)];
    }
    return [];
}

/** `FIND_PUMP_CURVE`, plus the carrier rule: trip never (`tripTime = haltTime = Infinity`, W2). */
function ASSERT_PUMP_CURVE(pump: PumpParams, ctx: string): void {
    const f = FIND_PUMP_CURVE(pump.curve!);
    if (f.length) throw new Error(`${ctx}: ${f[0].message}`);
    if (pump.tripTime !== Infinity || pump.haltTime !== Infinity) {
        throw new Error(`${ctx}: a user pump curve needs tripTime = haltTime = Infinity (trip never; ` +
                        `given ${pump.tripTime}, ${pump.haltTime}).`);
    }
}

/** Duty point (DOMAIN §15 (iv)): findings and, when there are none, the derived steady flow Q0. */
function PUMP_DUTY_POINT(
    pipes: PipeSection[], curve: PumpCurve, valve: ValveParams, Z0: number
): { findings: GateFinding[]; Q0: number } {
    const { a, b, c, H_suct } = curve;
    const fail = (f: GateFinding) => ({ findings: [f], Q0: NaN });
    if (!Number.isFinite(valve.H_down) || !Number.isFinite(H_suct) || !Number.isFinite(Z0)) {
        return fail({ code: 'B1', severity: GATE_SEVERITY('B1'), kind: 'contract-violation',
            where: 'Suction head / downstream head at the valve',
            message: `suction head, pump elevation and downstream head must be finite (H_suct = ` +
                     `${H_suct} m, Z0 = ${Z0} m, H_down = ${valve.H_down} m).` });
    }
    // Suction floor (DC-12, plan §5 P1): a fixed-head inlet at or below vapour is not a liquid inlet.
    if (!(H_suct - Z0 > VAPOR_H_REL)) {
        return fail({ code: 'B11', severity: GATE_SEVERITY('B11'), kind: 'contract-violation',
            where: 'Suction pressure',
            message: `Suction pressure too low: ${H_suct - Z0} m is at or below vapour pressure ` +
                     `(${VAPOR_H_REL} m gauge).` });
    }
    const K = pipes.reduce((acc, p) => {
        const A = Math.PI * p.diameter * p.diameter / 4.0;
        return acc + (p.frictionFactor * p.length) / (p.diameter * 2.0 * G * A * A);
    }, 0.0) + 1.0 / (valve.Cv0 * valve.Cv0);
    const C = c + H_suct - valve.H_down;
    if (!(C > 0)) {
        return fail({ code: 'B5', severity: GATE_SEVERITY('B5'), kind: 'contract-violation',
            where: 'Pump shut-off head / downstream head at the valve',
            message: `Insufficient pressure/head: suction head + shut-off head (${H_suct + c} m) must ` +
                     `exceed the downstream head at the valve (${valve.H_down} m).` });
    }
    if (!(K - a > 0)) return fail(pumpCurveFinding(`no steady duty point (K − a = ${K - a}).`));
    const Q0 = 2.0 * C / (Math.sqrt(b * b + 4.0 * (K - a) * C) - b);   // cancellation-free (b ≤ 0)
    if (!(Number.isFinite(Q0) && Q0 > 0)) return fail(pumpCurveFinding(`no steady duty point (Q0 = ${Q0}).`));
    const rise = a * Q0 * Q0 + b * Q0 + c;
    if (!(rise > 0)) {
        return fail(pumpCurveFinding(`pump head at the duty point (Q0 = ${Q0} m³/s) is ${rise} m; it ` +
                                     `must be above zero.`));
    }
    return { findings: [], Q0 };
}

/** B1/B11/B5/B10 — the duty point on the pump-fed valve path. Z0 = pump elevation (review F1). */
export function FIND_PUMP_DUTY_POINT(
    pipes: PipeSection[], curve: PumpCurve, valve: ValveParams, Z0: number
): GateFinding[] {
    return PUMP_DUTY_POINT(pipes, curve, valve, Z0).findings;
}

/** Throws the first `FIND_PUMP_DUTY_POINT` finding; else returns the derived Q0. */
function ASSERT_PUMP_DUTY_POINT(
    pipes: PipeSection[], curve: PumpCurve, valve: ValveParams, Z0: number, ctx: string
): number {
    const r = PUMP_DUTY_POINT(pipes, curve, valve, Z0);
    if (r.findings.length) throw new Error(`${ctx}: ${r.findings[0].message}`);
    return r.Q0;
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 9.9 — UNSTEADY-FRICTION VALIDITY CONTRACT  (Step 3.13 / S64)
// ═══════════════════════════════════════════════════════════════════════════════
//
// WHAT THIS CLOSES. L152: zero and near-zero steady flow produce non-numbers from every entry
// point. SECTION 9.7 validates a COMPUTED steady state; SECTION 9.8 validates the RAW VALVE INPUTS.
// Neither sees this one, because the fault is upstream of both — it is in the Reynolds number the
// unsteady-friction coefficients are frozen at, inside meshNetwork itself (:1566/:1575).
//
// WHY meshNetwork AND NOT AN ENTRY POINT. All four exported entry points call meshNetwork, and the
// gravity path packs its DERIVED Q0 into the same net.pump.initialFlow field before doing so. One
// guard here is therefore entry-point-independent by construction, which is exactly what L152
// requires — the defect was mis-diagnosed at S63 as an anchor-form fault until a second entry point
// reproduced it identically.
//   SCOPE LIMIT, stated so it is not read wider than it is: Re at :1566 is computed from the
//   GLOBAL net.pump.initialFlow for every segment. That is correct where flow is conserved along
//   the route — series topologies. On a BRANCHED network, per-branch flow is not resolved until
//   INIT_NETWORK_STEADY_STATE_GGA runs inside runCore, AFTER meshing, so every branch inherits the
//   trunk's Re. This guard therefore validates series mains; on a branched network it validates the
//   trunk's Re applied to every reach. That pre-existing defect is logged in BACKLOG.md — it is NOT
//   introduced here and NOT fixed here.
//   ONE CONSEQUENCE THIS GUARD DOES ADD (physics audit W6, S64): the refusal message names a PIPE
//   and a FLOW. On a branched network that pairing can be wrong — the named branch may not carry
//   the quoted flow at all, because no per-branch flow exists yet at this point in the run. The
//   verdict (refuse) stays sound, since the trunk flow bounds the branches; the ATTRIBUTION does
//   not. Anyone extending this guard to branched topologies must move it after GGA resolves, or
//   stop naming a segment.
//
// THE THRESHOLD IS THE ROUTINE'S OWN CONTRACT, NOT A MEASURED CLIFF — and that is deliberate.
// COMPUTE_MIAB_PIPE_PARAMS declares Re > 4000 at :397 and assumes "smooth turbulent pipe throughout
// the transient" (:409). Adopting the declared contract requires no independent physical judgement;
// picking a lower number measured from this solver's failure behaviour would substitute one. S64
// measured the failure behaviour anyway, because SPEC_S63.md §4.3 required it and because a guard
// should be sized knowingly:
//
//   * NON-FINITE output appears only below Re ~= 4.4, and NOT MONOTONICALLY — at D=0.25, Re=4.0
//     fails, 4.1-4.3 do not, 4.4 fails again, 4.5 does not. Whether a diverging run overflows to
//     Infinity or merely reaches 1e6 m within the run length is a coin flip. A threshold sized to
//     "where the non-numbers stop" would be sized to that coin flip.
//   * The DANGEROUS band is Re ~= 4 to ~= 40, where output is FINITE, complete, plausible-shaped
//     and wrong by 1e6-1e9 times the Joukowsky bound. Nothing in the returned history looks wrong.
//     This is the silent-wrong-answer class DC-12 exists to prevent.
//   * Re <= 0 fails AT ANY MAGNITUDE: Re = -1.27e6 (initialFlow = -0.5) returns 1600/1601
//     non-finite frames, because Re^0.05 of a negative number is NaN. The failing condition is the
//     SIGN, not the size. A magnitude test alone would miss it.
//   * SPEC_S63.md §4.3 feared a threshold at 4000 would "refuse systems that work". Measured, it
//     does not: at D=0.5, Re=4000 is V = 8 mm/s. Ordinary operating velocities (0.5-3 m/s) sit at
//     Re = 2.5e5-1.5e6, where the solver matches the Joukowsky bound to 1-5% at both diameters
//     tested. No TRANSMISSION MAIN is refused by this guard.
//     Stated precisely, because the unqualified version was an overclaim (physics audit W3, S64):
//     this was measured at two diameters (0.5 and 0.25 m) on one fixture. V_min = Re_min*nu/D, so
//     the velocity floor RISES as the pipe narrows — a small-bore laboratory rig (D ~ 20 mm at
//     ~0.1 m/s, Re ~ 2200) IS refused. That refusal is still correct for a Vardy-Brown turbulent
//     model, since laminar/transitional water hammer needs a different unsteady-friction model
//     (Zielke-class) that this solver does not implement — but it is a real refusal of a real
//     apparatus, not a vacuous one, and the comment should not pretend otherwise.
//   Evidence: findings/phase_3.13_low_re_guard/{low_re_probe_S64.ts, run_S64_preguard.txt,
//   RESULTS_S64.md}. Every figure above is reproducible from that harness.
//
// GUARD ORDERING IS BEHAVIOUR, NOT DETAIL (SPEC_S63.md §2.2). This guard fires inside meshNetwork,
// so it precedes ASSERT_INIT_ADMISSIBLE (SECTION 9.7, called inside runCore) and follows
// ASSERT_VALVE_CV0 / ASSERT_GRAVITY_DRIVING_HEAD (SECTION 9.8, called before meshNetwork on the two
// valve paths). DELIBERATE: an input that is BOTH below the friction contract AND sub-vapor at init
// now reports the flow, not the vapor line.
//   WHY, and HOW FAR THAT REASONING ACTUALLY REACHES (narrowed after physics audit W4, S64). On the
//   VALVE entry points the flow is demonstrably the more fundamental fault: H_valve_steady =
//   H_down + (Q0/Cv0)^2 is DERIVED from the flow (`PREPARE_valve`'s H_valve_steady), so the sub-vapor profile is a CONSEQUENCE
//   of the inadmissible flow, and reporting it instead is exactly the "right refusal, wrong cause"
//   pattern row 3.12 was written to eliminate. That is the case demonstrated (probe case D1).
//   On runWaterHammerSimulation / ...Network the reservoir head does NOT depend on initialFlow, so
//   a low-Re-plus-sub-vapor input there has an ELEVATION-driven vapor fault that the flow message
//   does not explain. The refusal is still correct — the flow is independently inadmissible and no
//   trustworthy transient exists either way — but the "cause vs consequence" argument is NOT
//   established on those paths and must not be cited as if it were.
//   The precedence also corrects two measured misattributions: initialFlow = NaN and diameter = 0
//   were previously refused as "below vapor pressure" / "C_gas is not positive", pointing at the
//   elevation profile and the cavity model rather than at the input actually at fault.
//
// THIS IS A CONTRACT BOUNDARY, NOT A VERIFIED-ACCURACY BOUNDARY (physics audit W5, S64). Passing
// this guard means the inputs are inside the friction model's declared range. It does NOT certify
// the result. Immediately above the threshold, peak/Joukowsky ratios of 29 / 26.8 / 16.2 were
// measured at Re = 4000 / 5000 / 10000; RESULTS_S64.md §5.1 traces those to a flow-independent
// ~H_down/3 excursion whose cause is explicitly NOT established. Do not cite this guard as evidence
// that results just above 4000 are trustworthy. (Boundary note: `!(Re > RE_MIAB_MIN)` refuses
// Re == 4000 exactly; the sweep log shows ADMIT at its "4000" row only because the round-trip
// through flow lands a hair above. FP-dependent at the exact boundary, by design, not a defect.)
//
// ADD-ONLY (L068): this function is read-only and either throws or returns. meshNetwork gains one
// collection array, one push, and one call — no arithmetic is altered, so every input that was
// admitted before follows a bit-identical path. Note precisely what that does and does not
// guarantee: an ADMITTED run is bit-identical BY CONSTRUCTION; that every previously-passing
// fixture is STILL admitted is an empirical fact about where each fixture's Re sits, and is
// established by the regression run, not by code structure.

/** COMPUTE_MIAB_PIPE_PARAMS' own declared input contract (:397). Not a measured cliff — see above. */
const RE_MIAB_MIN = 4000;

/**
 * Every pipe segment's steady Reynolds number must satisfy the unsteady-friction routine's
 * declared contract before its coefficients are consumed.
 *
 * `!Number.isFinite(Re) || !(Re > RE_MIAB_MIN)` — the SECTION 9.8 idiom, for the same three
 * reasons: `!(Re > x)` also rejects NaN, which `<=` passes; the explicit finiteness test also
 * rejects +Infinity, which `Re > 4000` would otherwise ADMIT (measured at S64: initialFlow =
 * +Infinity previously reached SECTION 9.7 and was refused there as a vapor-pressure problem); and
 * the same form covers the negative-sign case without a separate magnitude test.
 *
 * REPORTS THE BINDING SEGMENT. Re = 4Q/(pi*D*nu) is INVERSELY proportional to diameter, so on a
 * mixed-diameter main the LARGEST-diameter reach binds first — the opposite of the intuitive guess,
 * and the reason a single system-wide minimum is the wrong check (L152; SPEC_S63.md §4.3). The
 * sample file steps 580 -> 480 -> 430 mm and can be comfortably turbulent in its narrow reaches
 * while below contract in its widest.
 */
function ASSERT_MIAB_RE_CONTRACT(
    segments: { id: string; D: number; Re: number }[],
    Q: number,
    ctx: string
): void {
    const f = FIND_MIAB_RE_CONTRACT(segments, Q);
    if (f.length) throw new Error(`${ctx}: ${f[0].assertText ?? f[0].message}`);
}

/**
 * B1/B2/B3 — the unsteady-friction contract. Pure; the wording is `ASSERT_MIAB_RE_CONTRACT`'s,
 * moved unchanged, and `ASSERT_` now throws `f[0]` so the message stays byte-identical.
 *
 * FOUR ARMS, THREE CHECKS (`SESSION-PLAN` D1.2). The arms do not share a code, and tagging them
 * uniformly B3 would report a contract violation in tool-limit wording AND leave B2 — whose ONLY
 * source is the `Re === 0` arm — unimplemented:
 *
 *   | arm | condition               | code | kind                | why                                    |
 *   |-----|-------------------------|------|---------------------|----------------------------------------|
 *   |  1  | `Re` non-finite         | B1   | contract-violation  | the numbers cannot describe a pipeline |
 *   |  2  | `Re === 0`              | B2   | tool-limit          | nothing for the transient to change    |
 *   |  3  | `Re < 0`                | B1   | contract-violation  | direction-convention error; SEE BELOW  |
 *   |  4  | `0 < Re < RE_MIAB_MIN`  | B3   | tool-limit          | the genuine model-validity limit       |
 *
 * ARM 3 IS SPECIFIED — the gap is CLOSED (S67, 2026-08-31). It was raised at S66 and carried as an
 * open item: the guard had refused a negative steady flow since S64, and `SPEC_S63.md` §4 had no row
 * for it. The user delegated the ruling, and §4.1's B1 row was widened to cover it — B1 was already
 * the general "the inputs cannot describe this system" row. NOT B3, which is a tool-limit state and
 * would dress a contract violation in tool-limit wording; NOT a new code, which `CKPT_B2_AMENDMENT_
 * BRIEF_S64.md` §2 forbids without a ruling. See `SPEC_S63.md` §4.1's amendment note and
 * `DECISIONS.md` 2026-08-31. The emitted code and wording below are UNCHANGED by that close — they
 * were already right; only the spec's authority for them was missing.
 *
 * ONE finding, not one per segment: the selection below (first non-finite, else minimum `Re`) is
 * the existing behaviour and it is load-bearing for the wording — `selectedByMinRe` governs the
 * "widest reach binds" sentence and is only TRUE where the segment was chosen by minimum `Re`
 * (physics audit W1, S64). Reporting every out-of-contract segment would have to claim that
 * sentence for reaches it was never derived for.
 */
export function FIND_MIAB_RE_CONTRACT(
    segments: { id: string; D: number; Re: number }[],
    Q: number
): GateFinding[] {
    if (segments.length === 0) return [];       // empty pipe list is a different, pre-existing
                                                // defect (:1543-1544 TypeError, BACKLOG case E1)

    // A non-finite Re is reported in preference to a merely-small one: it names a broken input
    // rather than a regime limit, and the two carry different wording below.
    //
    // `selectedByMinRe` matters for the WORDING, not the verdict (physics audit W1, S64). The
    // "widest reach binds" sentence is only true when the segment was chosen as the minimum Re over
    // a shared flow. In the non-finite arm the segment is simply the FIRST one with a broken value —
    // a diameter of 0 on the NARROWEST reach would then be reported as "the widest reach", which is
    // false. Claim it only where it was actually derived.
    let worst = segments.find(s => !Number.isFinite(s.Re));
    const selectedByMinRe = worst === undefined;
    if (worst === undefined) {
        worst = segments[0];
        for (const s of segments) if (s.Re < worst.Re) worst = s;
        if (worst.Re > RE_MIAB_MIN) return [];  // every segment inside contract — admit
    }

    const { id, D, Re } = worst;
    const V    = Re * NU_WATER / D;             // the quantity an engineer actually thinks in
    const Vmin = RE_MIAB_MIN * NU_WATER / D;

    // Per-arm code/kind/where. The `why` strings are UNCHANGED — each already observes its own
    // arm's §4.1 class (arms 1 and 3 name the offending input; arms 2 and 4 say what this program
    // cannot compute and never call the input invalid), so no rewording is owed here. `where` is
    // new — §4.2 requires every finding to name its location — and names the binding reach plus
    // the input the message itself points at.
    let code: GateCode;
    let kind: GateKind;
    let where: string;
    let why: string;
    if (!Number.isFinite(Re)) {
        code = 'B1'; kind = 'contract-violation';
        where = `Pipe "${id}" — steady flow or pipe diameter`;
        why = `Its Reynolds number is ${Re}, which means one of the inputs it is computed from is `
            + `missing, non-numeric, or unbounded: the steady flow (given ${Q} m3/s) or the pipe `
            + `diameter (given ${D} m). This is an input-contract failure, not a limit of the `
            + `model — the numbers supplied cannot describe any pipeline.`;
    } else if (Re === 0) {
        code = 'B2'; kind = 'tool-limit';
        where = `Pipe "${id}" — steady flow`;
        why = `Its steady flow is exactly zero, so there is nothing for the transient to change. `
            + `A system at rest is a valid physical state, but it is not a surge event: with no `
            + `moving column there is no momentum to arrest and no pressure wave to compute.`;
    } else if (Re < 0) {
        code = 'B1'; kind = 'contract-violation';   // D7.2 spec gap — no §4 row exists for this arm
        where = `Pipe "${id}" — steady flow`;
        why = `Its Reynolds number is negative (${Re}), because the steady flow was given as `
            + `${Q} m3/s. This entry point initialises FORWARD flow; a negative value is a `
            + `direction-convention error in the input, not a reverse-flow transient — reverse `
            + `flow during the run is modelled separately. Magnitude does not rescue it: the `
            + `unsteady-friction coefficient takes a fractional power of Re and is undefined for `
            + `any negative value, however large.`;
    } else {
        code = 'B3'; kind = 'tool-limit';
        where = `Pipe "${id}" — steady flow`;
        why = `Its steady flow of ${Q} m3/s gives a velocity of ${V.toExponential(3)} m/s and a `
            + `Reynolds number of ${Re.toExponential(4)}, below the ${RE_MIAB_MIN} that the `
            + `unsteady-friction model requires — that model assumes fully turbulent flow, and `
            + `below its range its coefficients are not merely inaccurate but unbounded. This is a `
            + `limit of this tool, NOT a verdict on the pipeline: a main can run this slowly in `
            + `reality, and this program simply cannot compute a trustworthy transient for it. `
            + `This reach needs roughly ${Vmin.toExponential(3)} m/s or more to be simulated.`;
    }

    // Only appended when the segment really was chosen as the minimum Re over a shared flow.
    const tail = selectedByMinRe
        ? ` Reynolds number falls as diameter RISES, so on a mixed-diameter line it is the WIDEST `
          + `reach that limits the run, not the narrowest — "${id}" is the widest reach carrying `
          + `this flow.`
        : ` "${id}" is named because it is the first reach whose Reynolds number could not be `
          + `computed at all, not because it is the widest — with a broken value there is nothing `
          + `to rank the reaches by.`;

    return [{
        code, severity: GATE_SEVERITY(code), kind, where,
        message:
            `pipe "${id}" (diameter ${D} m) is outside the unsteady-friction model's valid `
            + `range. ${why}${tail}`
    }];
}



