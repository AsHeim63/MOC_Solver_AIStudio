// ── scenario_dispatch.ts — Step 3.7 UI scenario-selector dispatch layer (S58) ───────────────────
//
// UI DISPATCH ONLY — no solver logic, no solver.ts edits (SESSION-PLAN S58, work-order Task 3).
// This file is the PASTE-BLOCK SOURCE for the App.tsx dispatch section (AISTUDIO_PASTE_S58.md):
// the AI Studio copy differs ONLY in the import path ('./solver' there, relative path here) —
// S42 EOL/import-path-only precedent. API is PROVISIONAL until the live App.tsx read (plan-audit
// F2, disclosed accepted risk); confirmed verbatim-copy status is established at Step 3, not here.
//
// Scenario → entry-point routing (OI-8: selectable topology, DECISIONS.md 2026-07-23):
//   'pump-trip'     → runWaterHammerSimulation           (existing default — call preserved verbatim)
//   'pump-valve'    → runWaterHammerSimulationValve      (step 3.3 / S50, Section 7e)
//   'gravity-valve' → runWaterHammerSimulationGravityValve (step 3.6 / S57, Section 7f, head form)
//
// Unit boundary (3.0b freeze; see the `Cv0` field comment on `ValveParams` in solver.ts): the solver NEVER sees Kv0. The UI-facing
// metric coefficient Kv0 [m³/h @ 1 bar] converts here via Cv0 = Kv0 / KV0_TO_CV0. A direct-Cv0
// input alternative exists so hash-gated reproductions can inject the solver-exact coefficient
// (plan-audit F1: Kv0 round-trip through the constant is not bit-safe in FP; rounded display
// values are never hash-safe).
//
// Head-form guard (UI layer): runWaterHammerSimulationGravityValve's head form computes
// Q0 = sqrt((head − H_down)/(…)) — head < H_down (strict) yields NaN, and the solver-side
// inline vapor guard in `PREPARE_gravityValve` can PASS on a NaN-Q0 run. Solver-side hardening is a tracked open item
// (moc-physics-auditor S57 minor; Do-NOT list — no solver edit this session). This layer
// rejects head ≤ H_down (deliberately over-conservative at the equality boundary, where the
// solver would produce the degenerate Q0 = 0).

import {
    runWaterHammerSimulation,
    runWaterHammerSimulationValve,
    runWaterHammerSimulationGravityValve,
    PREPARE_pump, PREPARE_valve, PREPARE_gravityValve, SteadyStateResult,
    PipeSection, PumpParams, ReservoirParams,
    ValveParams, ClosureLaw, SimulationResults,
    GateFinding, GateCode, GateKind, GATE_SEVERITY, VAPOR_HEAD_AT,
    PumpCurve, FIND_PUMP_CURVE, FIND_PUMP_DUTY_POINT, FIND_VALVE_CV0, AirValveBC, QprvBC
} from './solver';
import { fitPumpCurve, pumpCurveFitFault, PumpCurvePoint } from './pump_curve';

export type Scenario = 'pump-trip' | 'pump-valve' | 'gravity-valve';

/** Kv0→Cv0 conversion factor (3.0b freeze: Cv0 = Kv0/11493.9; DECISIONS.md 2026-07-12 g-constant
 *  chain, G = 9.81). Named constant per plan-audit F9 — never inline the literal. */
export const KV0_TO_CV0 = 11493.9;

/** Trip/halt placeholder disabling the pump-trip event in the pump-fed valve-closure scenario
 *  (valve closure is the SOLE excitation — valve_closure_spec §6.3 non-goal: no pump-trip-coupled
 *  closure; valve_fixture.ts:60 convention: tripTime 1e9, haltTime 2e9, far beyond any maxTime). */
export const PUMP_TRIP_NEVER_S = 1e9;

/** UI-facing valve coefficient: Kv0 (metric, converted here) or Cv0 (solver-exact injection —
 *  reproduction/test seam; the UI form uses Kv0). */
export type ValveCoefficient = { Kv0: number } | { Cv0: number };

/**
 * Vapor pressure as a gauge head [m] — DC-1.
 *
 * NO LONGER A HAND-COPY (S67). This was the literal `-9.8`, with a comment conceding "the solver
 * constant is not exported; any drift between these two values is a bug in THIS file". Row 3.11
 * exported `VAPOR_HEAD_AT` for the gate's A3, and `VAPOR_HEAD_AT(0)` IS `VAPOR_H_REL` — so the
 * second constant is now derived from the first and cannot drift. Same value, one source. Leaving a
 * duplicate here while the row's own engine imports the original would have been the "two constants
 * for one line" failure §2 exists to prevent, surviving one file over from where it was fixed.
 */
export const VAPOR_PRESSURE_GAUGE_M = VAPOR_HEAD_AT(0);

export interface SelectorValveInput {
    coefficient: ValveCoefficient;
    law:         ClosureLaw;

    /** Verbatim datum-referenced head [m] — the reproduction/test escape hatch, so hash-gated
     *  fixtures inject the solver-exact value unchanged. Exactly one of `H_down` /
     *  `downstreamPressure` must be supplied.
     *
     *  NOT "gauge". `ValveParams.H_down` is datum-referenced head and always was — the solver's
     *  five arithmetic consumption sites are uniformly datum-referenced (S61 five-site inventory,
     *  DECISIONS.md 2026-08-09). The old "gauge; use 0 for open air" framing is what produced a
     *  7.6x-inflated driving head on an elevated valve (S60). */
    H_down?:     number;

    /** USER-FACING downstream boundary: gauge PRESSURE at the valve, in metres of water column.
     *  Converted here via `Head = Pressure + Elevation` (DECISIONS.md 2026-08-09, Part 1).
     *  Discharge to open air is 0 — which under this convention no longer silently means
     *  "datum head 0". */
    downstreamPressure?: number;

    check_valve: boolean;
}

/**
 * Resolve the downstream boundary to the datum-referenced head the solver expects.
 *
 * Unit boundary, mirroring the 3.0b Kv0 freeze above: the solver never sees a pressure, exactly as
 * it never sees Kv0. Valve elevation is the last pipe's `endElevation` (`PipeSection.endElevation`,
 * solver.ts:39), which becomes the terminal node's Z via `legacyToNetwork` and the meshing
 * interpolation — the node `CALC_BC_VALVE` is dispatched at.
 */
export function resolveHDown(v: SelectorValveInput, pipes: PipeSection[]): number {
    const f = FIND_DOWNSTREAM_BOUNDARY(v, pipes);
    if (f.length) throw new Error(f[0].assertText ?? f[0].message);
    if (v.H_down !== undefined) return v.H_down;
    return v.downstreamPressure! + pipes[pipes.length - 1].endElevation;
}

/**
 * B1/B8/B4 — the downstream-boundary input contract. Pure; every message is `resolveHDown`'s,
 * moved unchanged. Unlike the solver's `ASSERT_` guards these throws carry no `ctx:` prefix, so
 * here `message` IS the thrown string with nothing stripped or added.
 *
 * ORDER IS BEHAVIOUR, and the early return is the part that is easy to lose: when a datum head is
 * supplied, `resolveHDown` returns BEFORE the pipe-list and vapour checks. An empty pipe list with
 * `H_down` given is therefore NOT refused here, and must not become refused — the fixtures use that
 * escape hatch. The `return []` below reproduces that exit, it is not a fall-through.
 *
 * ON THE THIRD ARM'S CODE. The threshold is `< VAPOR_PRESSURE_GAUGE_M` (−9.8 m), which is LOOSER
 * than B4's "any entered pressure is negative" (< 0) — a −5 m entry passes this guard and trips B4.
 * So at the gate this arm is reached only for input B4 has already refused; it survives for direct
 * callers of `resolveHDown`, which bypass the gate entirely. Both are `B4` (§4.1's row for an
 * entered pressure), and the engine reports one — see `gate_checks.ts`.
 */
export function FIND_DOWNSTREAM_BOUNDARY(
    v: SelectorValveInput, pipes: PipeSection[]
): GateFinding[] {
    const hasHead     = v.H_down !== undefined;
    const hasPressure = v.downstreamPressure !== undefined;
    if (hasHead === hasPressure) {
        return [GATE_FINDING('B1', 'contract-violation', 'Downstream boundary at the valve',
            'Supply exactly one downstream boundary: either the downstream pressure at the valve ' +
            '(downstreamPressure — the normal input, 0 for discharge to open air) or a ' +
            'datum-referenced head (H_down — the reproduction escape hatch). ' +
            (hasHead ? 'Both were given.' : 'Neither was given.')
        )];
    }
    if (hasHead) return [];     // early return — the two checks below are NOT reached on this path
    if (pipes.length === 0) {
        return [GATE_FINDING('B8', 'contract-violation', 'Pipe list',
            'Cannot resolve the downstream boundary: the pipe list is empty.'
        )];
    }
    if (v.downstreamPressure! < VAPOR_PRESSURE_GAUGE_M) {
        return [GATE_FINDING('B4', 'contract-violation', 'Downstream pressure at the valve',
            `Downstream pressure at the valve (${v.downstreamPressure} m) is below vapor pressure ` +
            `(${VAPOR_PRESSURE_GAUGE_M} m). A boundary cannot hold a pressure the liquid cannot ` +
            `sustain.`
        )];
    }
    return [];
}

/** One place that builds a finding, so `severity` is never passed in by hand (D5). */
function GATE_FINDING(code: GateCode, kind: GateKind, where: string, message: string): GateFinding {
    return { code, severity: GATE_SEVERITY(code), kind, where, message };
}

/** Gravity-fed upstream boundary — application-facing head form only (the `GravityUpstream` type in solver.ts). */
export interface SelectorGravityInput {
    head:      number;        // upstream reservoir head [m]
    elevation: number;        // node-0 elevation [m]
}

export interface DispatchInputs {
    pipes:     PipeSection[];
    pump:      PumpParams;          // used by 'pump-trip' and 'pump-valve'
    reservoir: ReservoirParams;     // used by 'pump-trip' only
    valve?:    SelectorValveInput;  // required for both valve scenarios
    gravity?:  SelectorGravityInput; // required for 'gravity-valve'
    /** Q10: user pump curve, 'pump-valve' only (ignored elsewhere). Points in SI (flow m³/s, head
     *  rise m); suction pressure in m of water, gauge. Given = the steady flow is derived. */
    pumpCurve?: { points: PumpCurvePoint[]; suctionPressure: number };
    /** Q14: air valves on the line (transient run only; the steady state ignores them).
     *  Absent or [] = today's run, bit-identical. */
    airValves?: AirValveBC[];
    /** Q19: QPRV at the end valve, 'gravity-valve' and 'pump-valve' only (transient run only);
     *  on 'pump-trip' dispatchSimulation throws. Absent = today's run, bit-identical. */
    qprv?: QprvInput;
}

/** Q19 ruling table (builder/inputs/Q19_surge_valves.md): nominal size [mm] →
 *  [fastest closing s, maximal closing s, default Kv]. */
export const SURGE_VALVE_TABLE: Readonly<Record<number, readonly [number, number, number]>> = {
    50: [10, 60, 50], 80: [15, 120, 100], 100: [20, 180, 150], 150: [30, 240, 300], 200: [30, 360, 600],
    250: [30, 480, 900], 300: [30, 600, 1500], 400: [30, 900, 3000], 500: [60, 900, 4000], 600: [90, 900, 5000],
    800: [120, 900, 6500], 1000: [180, 900, 8000],
};

/** O1 reading of the ruling's Kv: Q[m³/h] = Kv·√(P/10), P in m of water ⟹ Q[m³/s] = Kv/(3600·√10)·√P. */
export const KV_TO_CQ = 3600 * Math.sqrt(10);

/** Q19 QPRV input: size from the table, closing time within that size's [fastest, maximal];
 *  Kv [m³/h at 1 bar] absent = the table's default for the size. */
export interface QprvInput { size_mm: number; closingTime: number; Kv?: number;
                             runTime?: number }   // Q21 sizing study only: run length [s]; absent = 40·L/a

/** Q19: the solver-facing QPRV; throws on a size not in the table, a closing time outside its
 *  range, or a Kv that is not finite and > 0. */
export function toSolverQprv(q: QprvInput): QprvBC {
    const row = SURGE_VALVE_TABLE[q.size_mm];
    if (row === undefined) {
        throw new Error(`QPRV size ${q.size_mm} mm is not in the table (${Object.keys(SURGE_VALVE_TABLE).join(', ')} mm).`);
    }
    const [fastest, maximal, KvDefault] = row;
    if (!(q.closingTime >= fastest && q.closingTime <= maximal)) {
        throw new Error(`QPRV ${q.size_mm} mm: closing time ${q.closingTime} s must lie in [${fastest}, ${maximal}] s.`);
    }
    const Kv = q.Kv ?? KvDefault;
    if (!(Number.isFinite(Kv) && Kv > 0)) throw new Error(`QPRV ${q.size_mm} mm: Kv ${Kv} must be finite and > 0.`);
    return { Cq: Kv / KV_TO_CQ, closingTime: q.closingTime, ...(q.runTime !== undefined && { runTime: q.runTime }) };
}

/** Q10: the solver-facing curve, H_suct = suction pressure + pump elevation (ruling Q6-a). Only
 *  called after `FIND_PUMP_CURVE_INPUTS` found the points fit. */
function pumpCurveOf(inputs: DispatchInputs): PumpCurve | undefined {
    const pc = inputs.pumpCurve;
    if (!pc) return undefined;
    const fit = fitPumpCurve(pc.points ?? []);
    if (!fit.ok) return undefined;
    return { ...fit.curve, H_suct: pc.suctionPressure + inputs.pump.elevation };
}

/**
 * Q10 — B1/B11/B10/B5 for the pump curve inputs (plan §5), first-finding semantics like the rest of
 * `FIND_SCENARIO_INPUTS`. The suction floor is tested on the ENTERED pressure (review W1: the round
 * trip through H_suct − Z0 can land 1 ULP either side); the solver repeats it on H_suct − Z0.
 * The duty point runs only when its other inputs are sound — those faults are reported by their
 * own checks (B1/B6/B8), and a duty-point finding derived from them would blame the curve.
 * The coefficient rule is the solver's `FIND_PUMP_CURVE` (one gate, two layers, L147).
 * `notReached` hears B11/B10 when an early return means they never ran (S67: skipped, not pass).
 */
function FIND_PUMP_CURVE_INPUTS(inputs: DispatchInputs, v: SelectorValveInput,
                                notReached?: (code: GateCode, why: string) => void): GateFinding[] {
    const pc = inputs.pumpCurve!;
    const sp = pc.suctionPressure;
    if (typeof sp !== 'number' || !Number.isFinite(sp)) {
        const why = 'the suction pressure is not a finite number — see the finding above';
        notReached?.('B11', why); notReached?.('B10', why);
        return [GATE_FINDING('B1', 'contract-violation', 'Suction pressure',
            `Suction pressure is ${sp}. It must be a finite number (m of water, gauge).`)];
    }
    if (!(sp > VAPOR_PRESSURE_GAUGE_M)) {
        notReached?.('B10', 'the suction pressure is too low, so the curve was not checked');
        return [GATE_FINDING('B11', 'contract-violation', 'Suction pressure',
            `Suction pressure too low: ${sp} m is at or below vapour pressure (${VAPOR_PRESSURE_GAUGE_M} m).`)];
    }
    const fit = fitPumpCurve(pc.points ?? []);
    if ('reason' in fit) return [GATE_FINDING('B10', 'contract-violation', 'Pump curve', `Invalid pump curve: ${fit.reason}.`)];
    const curve = pumpCurveOf(inputs)!;
    const bad = FIND_PUMP_CURVE(curve);
    if (bad.length) return bad;
    const fault = pumpCurveFitFault(pc.points, fit.curve);
    if (fault) return [GATE_FINDING('B10', 'contract-violation', 'Pump curve', `Invalid pump curve: ${fault}.`)];
    const Z0 = inputs.pump?.elevation;
    const Cv0 = toSolverCv0(v.coefficient);
    const pipesOk = inputs.pipes.length > 0 && inputs.pipes.every(p =>
        [p.length, p.diameter, p.frictionFactor].every(Number.isFinite) && p.length > 0 && p.diameter > 0);
    if (!Number.isFinite(Z0) || FIND_VALVE_CV0(Cv0).length || !pipesOk) return [];
    return FIND_PUMP_DUTY_POINT(inputs.pipes, curve,
        { Cv0, law: v.law, H_down: resolveHDown(v, inputs.pipes), check_valve: v.check_valve }, Z0);
}

export function toSolverCv0(c: ValveCoefficient): number {
    return 'Cv0' in c ? c.Cv0 : c.Kv0 / KV0_TO_CV0;
}

/**
 * Build the solver-facing arguments for a scenario. Pure derivation: Kv0 to Cv0, the downstream
 * boundary through `resolveHDown`, the trip/halt neutralisation, the head-form guard — everything
 * that used to sit inside `dispatchSimulation`'s switch, moved here unchanged.
 *
 * Extracted at S65 (Row 3.11 Unit A) so `dispatchSimulation` and `dispatchSteadyState` cannot
 * derive these differently. Two dispatchers deriving `H_down` by two routes is the same
 * two-sources-of-truth failure `SPEC_S63.md` §2 exists to prevent, one layer up.
 */
export type ScenarioArgs =
    | { kind: 'pump-trip';     pipes: PipeSection[]; pump: PumpParams; reservoir: ReservoirParams }
    | { kind: 'pump-valve';    pipes: PipeSection[]; pump: PumpParams; valve: ValveParams }
    | { kind: 'gravity-valve'; pipes: PipeSection[]; upstream: { head: number; elevation: number };
                               valve: ValveParams };

/**
 * B1/B5 (+ B8/B4 by composition) — everything `buildScenarioArgs` refuses, as findings.
 *
 * It CALLS `FIND_DOWNSTREAM_BOUNDARY` rather than sitting beside it, because `buildScenarioArgs`
 * reaches `resolveHDown` only after its own `!v`/`!g` checks pass. Running the two independently
 * would report a boundary fault on a scenario that never got that far, and would change which
 * message a doubly-broken input shows — which §2.2 makes behaviour, not detail.
 *
 * FIRST-FINDING SEMANTICS, deliberately. Every branch returns as soon as one finding exists, so
 * `f[0]` is the throw `buildScenarioArgs` would have produced. These are sequential-dependency
 * checks — with no valve settings there is no coefficient to convert and no boundary to resolve —
 * so continuing would report faults derived from absent inputs.
 *
 * NOTE the head-form guard duplicates `ASSERT_GRAVITY_DRIVING_HEAD` in the solver, with different
 * wording, ON PURPOSE (L147): one gate at two layers, because a direct solver caller bypasses this
 * one entirely. Both are B5 evidence and the engine must not merge them into one message.
 */
export function FIND_SCENARIO_INPUTS(scenario: Scenario, inputs: DispatchInputs,
                                    notReached?: (code: GateCode, why: string) => void): GateFinding[] {
    if (scenario === 'pump-trip') return [];

    const v = inputs.valve;
    if (scenario === 'pump-valve') {
        // Q10: the curve checks come last; an earlier return means B11/B10 never ran (S67).
        const curveNotReached = (why: string) => {
            if (inputs.pumpCurve) { notReached?.('B11', why); notReached?.('B10', why); }
        };
        if (!v) {
            curveNotReached('there are no valve settings — see the finding above');
            return [GATE_FINDING('B1', 'contract-violation', 'Valve settings',
                'The pump-fed valve-closure scenario needs valve settings.')];
        }
        const boundary = FIND_DOWNSTREAM_BOUNDARY(v, inputs.pipes);
        if (boundary.length) curveNotReached('the downstream boundary could not be resolved — see the finding above');
        if (boundary.length || !inputs.pumpCurve) return boundary;
        return FIND_PUMP_CURVE_INPUTS(inputs, v, notReached);   // Q10
    }

    // gravity-valve
    const g = inputs.gravity;
    if (!v) return [GATE_FINDING('B1', 'contract-violation', 'Valve settings',
        'The gravity-fed valve-closure scenario needs valve settings.')];
    if (!g) return [GATE_FINDING('B1', 'contract-violation', 'Reservoir settings',
        'The gravity-fed valve-closure scenario needs reservoir settings.')];

    const boundary = FIND_DOWNSTREAM_BOUNDARY(v, inputs.pipes);
    if (boundary.length) return boundary;

    // Resolved ONCE, so the guard compares exactly the value the solver receives. Safe to call:
    // the boundary check above returned nothing, so `resolveHDown` cannot throw here.
    const H_down = resolveHDown(v, inputs.pipes);
    if (!(g.head > H_down)) {
        return [GATE_FINDING('B5', 'contract-violation',
            'Upstream reservoir head / downstream head at the valve',
            `Upstream reservoir head (${g.head} m) must be greater than the downstream ` +
            `head at the valve (${H_down} m` +
            (v.downstreamPressure !== undefined
                ? `, from a downstream pressure of ${v.downstreamPressure} m at elevation ` +
                  `${inputs.pipes[inputs.pipes.length - 1].endElevation} m`
                : '') +
            `) — the gravity-fed scenario needs a positive driving head.`
        )];
    }
    return [];
}

export function buildScenarioArgs(scenario: Scenario, inputs: DispatchInputs): ScenarioArgs {
    const f = FIND_SCENARIO_INPUTS(scenario, inputs);
    if (f.length) throw new Error(f[0].assertText ?? f[0].message);
    switch (scenario) {
        case 'pump-trip': {
            return { kind: 'pump-trip', pipes: inputs.pipes, pump: inputs.pump,
                     reservoir: inputs.reservoir };
        }
        case 'pump-valve': {
            const v = inputs.valve;
            if (!v) throw new Error('The pump-fed valve-closure scenario needs valve settings.');
            const valveParams: ValveParams = {
                Cv0: toSolverCv0(v.coefficient), law: v.law,
                H_down: resolveHDown(v, inputs.pipes), check_valve: v.check_valve
            };
            // Neutralize the UI's trip/halt inputs: selecting this scenario must never
            // superimpose a pump trip on the closure (defect fix, user-observed S58).
            // Q10: with a user curve, trip never is Infinity (the solver's curve contract, plan §5
            // P2/W2) and the curve rides on `pump`; without one, unchanged byte for byte.
            const curve = pumpCurveOf(inputs);
            const pumpNoTrip: PumpParams = curve
                ? { ...inputs.pump, tripTime: Infinity, haltTime: Infinity, curve }
                : { ...inputs.pump, tripTime: PUMP_TRIP_NEVER_S, haltTime: 2 * PUMP_TRIP_NEVER_S };
            return { kind: 'pump-valve', pipes: inputs.pipes, pump: pumpNoTrip, valve: valveParams };
        }
        case 'gravity-valve': {
            const v = inputs.valve;
            const g = inputs.gravity;
            if (!v) throw new Error('The gravity-fed valve-closure scenario needs valve settings.');
            if (!g) throw new Error('The gravity-fed valve-closure scenario needs reservoir settings.');
            // Resolved ONCE, so the guard compares exactly the value the solver receives.
            const H_down = resolveHDown(v, inputs.pipes);
            if (!(g.head > H_down)) {
                throw new Error(
                    `Upstream reservoir head (${g.head} m) must be greater than the downstream ` +
                    `head at the valve (${H_down} m` +
                    (v.downstreamPressure !== undefined
                        ? `, from a downstream pressure of ${v.downstreamPressure} m at elevation ` +
                          `${inputs.pipes[inputs.pipes.length - 1].endElevation} m`
                        : '') +
                    `) — the gravity-fed scenario needs a positive driving head.`
                );
            }
            const valveParams: ValveParams = {
                Cv0: toSolverCv0(v.coefficient), law: v.law,
                H_down, check_valve: v.check_valve
            };
            return { kind: 'gravity-valve', pipes: inputs.pipes,
                     upstream: { head: g.head, elevation: g.elevation }, valve: valveParams };
        }
        default: {
            const never: never = scenario;
            throw new Error(`Unknown scenario: ${never}`);
        }
    }
}

/**
 * Route the selected scenario to its solver entry point. Pure dispatch: builds solver-facing
 * params and CALLS the matching entry point — nothing else. `trace`, when provided, receives
 * the entry-point name immediately before the call (harness instrumentation demonstrating
 * which path actually fired — global L088; the UI never passes it).
 *
 * S65: `trace` is now also FORWARDED into the solver, so the same array receives the
 * `PREPARE_x` name from inside the entry point. Firing it only here would prove which label
 * this file printed, not which function ran — `SPEC_S63.md` §8.3(a).
 */
export function dispatchSimulation(
    scenario: Scenario,
    inputs:   DispatchInputs,
    trace?:   (entryPoint: string) => void
): SimulationResults {
    const a = buildScenarioArgs(scenario, inputs);
    switch (a.kind) {
        case 'pump-trip': {
            if (inputs.qprv !== undefined) {   // Q19: refused, never silently dropped
                throw new Error(`QPRV is for valve-closure scenarios only ('gravity-valve', 'pump-valve'), not '${scenario}'.`);
            }
            trace?.(runWaterHammerSimulation.name);   // label from the actual reference (audit S58 F7)
            return runWaterHammerSimulation(a.pipes, a.pump, a.reservoir, trace, inputs.airValves);
        }
        case 'pump-valve': {
            trace?.(runWaterHammerSimulationValve.name);
            return runWaterHammerSimulationValve(a.pipes, a.pump, a.valve, trace, inputs.airValves,
                inputs.qprv && toSolverQprv(inputs.qprv));   // Q19
        }
        case 'gravity-valve': {
            trace?.(runWaterHammerSimulationGravityValve.name);
            return runWaterHammerSimulationGravityValve(a.pipes, a.upstream, a.valve, trace, inputs.airValves,
                inputs.qprv && toSolverQprv(inputs.qprv));   // Q19
        }
        default: {
            const never: never = a;
            throw new Error(`Unknown scenario args: ${never}`);
        }
    }
}

/**
 * Route the selected scenario to its steady state, WITHOUT running the transient — the gate's
 * entry point (`SPEC_S63.md` §2.2 item 3, Row 3.11 Unit A, S65).
 *
 * Same `buildScenarioArgs`, same `PREPARE_x` the run itself enters. This dispatcher deliberately
 * does NOT fire a label of its own: the only name reaching `trace` is the one `PREPARE_x` fires
 * from inside itself, so a matching trace is evidence about the function that ran rather than
 * about what this file chose to print.
 *
 * `collect` (S67 D2) is forwarded to `PREPARE_x` and on into `meshNetwork`, where the one guard
 * that cannot be evaluated from raw inputs — the per-segment Reynolds contract, which needs the
 * meshed `Re` — reports instead of throwing. Omitted, every guard throws exactly as before. The
 * gate supplies it; the UI and the fixtures do not.
 */
export function dispatchSteadyState(
    scenario: Scenario,
    inputs:   DispatchInputs,
    trace?:   (entryPoint: string) => void,
    collect?: (f: GateFinding) => void
): SteadyStateResult {
    const a = buildScenarioArgs(scenario, inputs);
    switch (a.kind) {
        case 'pump-trip':     return PREPARE_pump(a.pipes, a.pump, a.reservoir, trace, collect);
        case 'pump-valve':    return PREPARE_valve(a.pipes, a.pump, a.valve, trace, collect);
        case 'gravity-valve': return PREPARE_gravityValve(a.pipes, a.upstream, a.valve, trace, collect);
        default: {
            const never: never = a;
            throw new Error(`Unknown scenario args: ${never}`);
        }
    }
}
