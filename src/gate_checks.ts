// ── gate_checks.ts — the steady-state gate's checks engine (Row 3.11 Unit B) ────────────────────
//
// WHAT THIS IS. A headless evaluator: given a scenario and its raw inputs, it returns EVERY check in
// `SPEC_S63.md` §4 — blocking B1–B9 and advisory A1–A5 — each with a verdict, a location and a
// message. **It returns verdicts; it never throws.** Unit C renders this; it computes nothing of
// its own.
//
// UI LAYER, NO PHYSICS (`SESSION-PLAN` D4). Every bound this file applies is imported or read off a
// solver artifact. It derives exactly one number of its own — A1's advisory floor — and that one is
// an observation boundary rather than a physical bound; see A1 below for why, and for its
// provenance. Everything else routes through the solver's own `FIND_` functions, which are the same
// predicates the `ASSERT_` guards throw on, so a check can never disagree with the guard behind it.
//
// TWO PHASES (D3), because a broken input has no steady state:
//   1. INPUT PHASE  — B1, B4, B5, B6, B8, B9 from raw inputs alone.
//   2. If anything blocks, STOP. A pipe list with a zero diameter cannot be meshed, and the empty
//      list dies with a raw TypeError (BACKLOG case E1). Nothing downstream would be trustworthy.
//   3. STATE PHASE  — `dispatchSteadyState` with a collector, then B2, B3, B7 and A1–A5.
// Ordering is behaviour, not detail (§2.2): it fixes what a doubly-broken input reports.
//
// WORDING IS GOVERNED, NOT FREE. §4.1 splits blocking checks into contract violations (B1, B4, B5,
// B6, B8, B9 — the inputs cannot describe any system) and tool-limit states (B2, B3, B7 — the
// inputs describe a real system this tool cannot simulate). §4.3 and L150 forbid phrasing a
// tool-limit state as invalid input. `gate_wording_S67.ts` asserts that programmatically (§8.4).
//
// Run nothing here directly — this is a library. Its harness is `gate_capability_S67.ts`.

import {
    SteadyStateResult, PipeSection, GateFinding, GateCode, GateKind, GateSeverity,
    GATE_SEVERITY, VAPOR_HEAD_AT, COMPUTE_TRAVEL_TIME,
    FIND_VALVE_CV0, FIND_GRAVITY_DRIVING_HEAD, FIND_INIT_ADMISSIBLE,
} from './solver';
import {
    Scenario, DispatchInputs, SelectorValveInput, dispatchSteadyState,
    toSolverCv0, resolveHDown, FIND_SCENARIO_INPUTS,
} from './scenario_dispatch';
import { fitPumpCurve } from './pump_curve';

// ════════════════════════════════════════════════════════════════════════════════════════════════
// The report shape
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * `not-evaluated` is NOT a third severity tier — CKPT_B2_AMENDMENT_BRIEF §2 forbids one and this
 * does not add one. Severity stays exactly {blocking, advisory}; verdict is an orthogonal axis
 * saying whether the check ran. A check is `not-evaluated` when it does not apply to the scenario
 * (B5 on a pump trip) or when the input phase blocked before the state phase could run.
 */
export type GateVerdict = 'pass' | 'fail' | 'not-evaluated';

export interface GateCheck {
    code:     GateCode;
    severity: GateSeverity;
    verdict:  GateVerdict;
    /** Empty unless `verdict === 'fail'`. */
    findings: GateFinding[];
    /** Why a check did not run. Present only on `not-evaluated`. */
    skipped?: string;
}

export interface GateReport {
    /** All eighteen, always, in B1…B11 then A1…A7 order — §4 requires the checks to be LISTED. */
    checks: GateCheck[];
    blocking: GateFinding[];
    advisory: GateFinding[];
    /** §4.1: any failed blocking check disables the primary action. */
    runAnalysisAvailable: boolean;
    /**
     * Did the INPUT phase block? (Row 3.11 Unit C, D-2 — additive, S68.)
     *
     * The two-screen gate (`MOCKUP_NOTES_S65.md` §7) needs exactly this and nothing more. When it
     * is true the state phase never ran, so every finding in this report is an input-phase one and
     * belongs on screen 1; when it is false the input phase produced nothing, so every finding is a
     * state-phase one and belongs on screen 2. The partition is a property of the RUN, not of the
     * individual finding, and a consumer that re-derived it from `blocking` would be guessing.
     *
     * Deliberately NOT a per-check `phase` field. That was planned and dropped: §7.3 moves a
     * *condition* between gates by scenario (a negative pump flow becomes an input-phase fault
     * while the same value stays state-phase on the gravity path), so a per-check label would be
     * true of the check in one scenario and false in another, and B1 already raises findings in
     * both phases. One honest boolean beats a field that is right most of the time.
     */
    inputBlocked: boolean;
    /**
     * Did the per-segment Reynolds contract guard report? (Row 3.11 Unit C, D-2 — additive, S68.)
     *
     * When it did, `meshNetwork` continued past the finding and `steady.layout.miab` carries
     * coefficients frozen at an out-of-contract `Re` — evidence of the fault, not a usable mesh
     * (`RESULTS_S67.md` §8a). The screen keeps its numeric readouts here and shows a non-turbulent
     * warning beside them (Assaf's ruling, `builder/ANSWERS.md` 2026-10-02 Q2, which replaced the
     * earlier suppression); B7 comes from a different call on a perfectly sound mesh.
     *
     * Already tracked internally to bound A1 (L169 — the advisory reads the guard's own verdict
     * rather than re-deriving a floor). This exposes the flag it was already computing; it does not
     * introduce a second determination of it.
     */
    reContractBlocked: boolean;
    /** Present only when the state phase ran and `dispatchSteadyState` returned. */
    steady?: SteadyStateResult;
    /**
     * Set when the state phase threw despite the collector. Not expected: the input phase is meant
     * to stop everything that throws. If this is ever populated, a throw path is unaccounted for —
     * that is a defect in this engine's coverage, not a user error, and it is surfaced rather than
     * swallowed.
     */
    stateError?: string;
}

const BLOCKING_ORDER: GateCode[] = ['B1','B2','B3','B4','B5','B6','B7','B8','B9','B10','B11'];
const ADVISORY_ORDER: GateCode[] = ['A1','A2','A3','A4','A5','A6','A7'];

/** One place builds a finding, so `severity` is never passed by hand (D5). */
function finding(code: GateCode, kind: GateKind, where: string, message: string): GateFinding {
    return { code, severity: GATE_SEVERITY(code), kind, where, message };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// A1's advisory floor — the ONE bound this file introduces
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// `SPEC_S63.md` §4.3 leaves A1 as "the advisory band as a factor above [the blocking threshold] —
// both provisional", and names no factor. Session 64 then measured the range and §5.1 WITHDREW the
// Reynolds-based framing that would have supplied one: the low-velocity peak turned out to be a
// flow-independent floor of ≈ H_down/3, so the "29× at Re = 4000" ratio was an artifact of a
// shrinking denominator, not evidence about Re. That document's own conclusion is explicit:
// "Velocity governs the excursion magnitude; Re governs the non-finite failure. They are different
// mechanisms and should not be described as one."
//
// So the advisory band is stated in VELOCITY, and it is set at the boundary of what was actually
// MEASURED rather than at an invented multiple of the blocking bound. RESULTS_S64 §5, swept at two
// diameters, peak vs the Joukowsky bound:
//
//        V = 0.05 -> 6.51x    V = 0.1 -> 3.32x    V = 0.2 -> 1.78x    V = 0.3 -> 1.32x
//        V = 0.5  -> 1.04x    V = 1.0 -> 1.01x    V = 2.0 -> 1.01x    V = 3.0 -> 1.02x
//
// 0.5 m/s is the slowest velocity at which agreement was demonstrated (within 5%, both diameters).
// Below it the excursion is measurably inflated while the run still completes and still passes B3.
// A1 therefore fires between B3's contract floor and this line: the run is allowed, and the user is
// told the tool has not been shown to be accurate there.
//
// PROVISIONAL, and honest about which kind of number it is: this is an OBSERVATION boundary — the
// edge of the measured evidence — not a physical threshold. The band between 0.3 and 0.5 m/s is
// unmeasured, and narrowing it means running the §5 sweep at more velocities, not re-reasoning.
const A1_VERIFIED_VELOCITY_MIN = 0.5;   // m/s — RESULTS_S64 §5, lowest V with measured agreement

/** A2's ceiling — `SPEC_S63.md` §4.2, given directly by the spec. */
export const A2_VELOCITY_MAX = 3.0;     // m/s (exported for the Q27 display text)

/** A3's proximity band — `SPEC_S63.md` §4.2, given directly by the spec. */
const A3_VAPOUR_MARGIN_M = 2.0;         // m

// ════════════════════════════════════════════════════════════════════════════════════════════════
// evaluateGate
// ════════════════════════════════════════════════════════════════════════════════════════════════

export function evaluateGate(scenario: Scenario, inputs: DispatchInputs): GateReport {
    const acc = new Map<GateCode, GateFinding[]>();
    const skipped = new Map<GateCode, string>();
    const add = (f: GateFinding) => {
        const list = acc.get(f.code);
        if (list) list.push(f); else acc.set(f.code, [f]);
    };
    const skip = (code: GateCode, why: string) => skipped.set(code, why);

    const isValve   = scenario === 'pump-valve' || scenario === 'gravity-valve';
    const isGravity = scenario === 'gravity-valve';
    const v = inputs.valve;
    // Q10: the user pump curve exists on the pump-fed valve path only (ignored elsewhere).
    const curveIn = scenario === 'pump-valve' ? inputs.pumpCurve : undefined;

    // ── INPUT PHASE ─────────────────────────────────────────────────────────────────────────────

    // Everything `buildScenarioArgs` and `resolveHDown` refuse, as findings rather than throws.
    // First-finding semantics is theirs, and it is deliberate: with no valve settings there is no
    // coefficient to convert and no boundary to resolve, so continuing would report faults derived
    // from absent inputs. Its findings carry codes B1 / B8 / B4 / B5 already, so they route by code.
    // Q10: it also reports B11/B10 as skipped when an earlier return means they never ran (S67).
    for (const f of FIND_SCENARIO_INPUTS(scenario, inputs, skip)) add(f);

    // Q10: B10/B11 arrive from FIND_SCENARIO_INPUTS above. A6 is the hump refit note (Q6-c).
    if (curveIn) {
        const fit = fitPumpCurve(curveIn.points ?? []);
        if (!fit.ok) skip('A6', 'the pump curve could not be fitted — see the finding above');
        else if (fit.humpRemoved) add(finding('A6', 'tool-limit', 'Pump curve',
            'Pump curve hump removed: the entered points rise with flow; the closest curve without a ' +
            'hump is used.'));
    } else {
        for (const c of ['B10','B11','A6','A7'] as GateCode[]) skip(c, 'no pump curve was entered');
    }

    checkB8(inputs.pipes, add);
    checkB1(scenario, inputs, add);
    checkB4(v, acc.has('B4'), add);

    if (isValve && v) {
        for (const f of FIND_VALVE_CV0(toSolverCv0(v.coefficient))) add(f);
        checkB9(v, add);
    } else {
        skip('B6', `${scenario} has no valve`);
        skip('B9', `${scenario} has no closure law`);
    }
    // B4's only input is the valve's downstream pressure, so on a pump trip it has nothing to read.
    // Skipped explicitly rather than left to report a bare `pass` — a check that never ran must not
    // look like one that ran and was satisfied (action audit, S67).
    if (!isValve || !v || v.downstreamPressure === undefined) {
        skip('B4', isValve ? 'no downstream pressure was entered' : `${scenario} has no valve`);
    }

    // B5's two sources are BOTH reported and are NOT merged (L147). The dispatch-layer guard and
    // `ASSERT_GRAVITY_DRIVING_HEAD` word the same rejection differently on purpose, because a direct
    // solver caller bypasses the first one entirely. One gate at two layers, two pieces of evidence.
    // The dispatch-layer B5 already arrived above via FIND_SCENARIO_INPUTS; this adds the solver's.
    if (!isGravity) {
        skip('B5', `${scenario} has no gravity reservoir`);
    } else if (!inputs.gravity || !v) {
        skip('B5', 'the reservoir or valve settings are missing, so there is no pair to compare');
    } else {
        const H_down = tryResolveHDown(v, inputs.pipes);
        if (H_down === undefined) {
            // The boundary could not be resolved, so B5 has nothing to compare against. It did NOT
            // run — corrected S67 after the action audit, where swallowing this reported B5 as a
            // clean `pass` on an input B5 had never seen. `FIND_DOWNSTREAM_BOUNDARY` has already
            // reported WHY the boundary failed, so nothing is lost but the false verdict.
            skip('B5', 'the downstream boundary could not be resolved — see the finding above');
        } else {
            for (const f of FIND_GRAVITY_DRIVING_HEAD(inputs.gravity.head, H_down)) add(f);

            // The gravity path's inline node-0 vapour guard (`PREPARE_gravityValve`) still THROWS
            // even with a collector supplied — it is not one of the six extracted sites. D2's throw
            // inventory says it is "computable from inputs", and this is that computation: for the
            // head form H_res_up IS the entered head, so the guard's condition can be evaluated
            // here, in the input phase, before anything reaches it. Without this the guard's raw
            // developer-facing string lands in `stateError`, a §4.3-governed surface.
            if (!(inputs.gravity.head > VAPOR_HEAD_AT(inputs.gravity.elevation))) {
                add(finding('B7', 'tool-limit', 'Upstream reservoir head / reservoir elevation',
                    `The reservoir head (${inputs.gravity.head} m) is at or below the vapour line ` +
                    `for its own elevation (${inputs.gravity.elevation} m, vapour at ` +
                    `${VAPOR_HEAD_AT(inputs.gravity.elevation).toPrecision(6)} m), so the column ` +
                    `cannot be held at the source itself. This program models a full pipe only and ` +
                    `cannot compute a transient from that starting condition.`));
            }
        }
    }

    const inputBlocked = BLOCKING_ORDER.some(c => (acc.get(c)?.length ?? 0) > 0);

    // ── STATE PHASE ─────────────────────────────────────────────────────────────────────────────

    let steady: SteadyStateResult | undefined;
    let stateError: string | undefined;
    /** Set by the mesh collector when the Reynolds contract guard reports. Bounds A1 below. */
    let reContractBlocked = false;
    /** The state-phase checks, skipped with one reason when there is no steady state to check. */
    const skipStateChecks = (why: string) => {
        for (const c of ['B2','B3','B7','A1','A2','A3','A4','A5','A7'] as GateCode[]) {
            if (!acc.has(c) && !skipped.has(c)) skip(c, why);
        }
    };

    if (inputBlocked) {
        const why = 'an input-phase check blocks — no steady state was computed';
        skipStateChecks(why);
    } else {
        try {
            // The collector is what turns the ONE guard that fires mid-mesh into a report: supplied,
            // `ASSERT_MIAB_RE_CONTRACT` reports; absent, it throws, which is every other caller.
            // Its findings are already coded per arm (B1 / B2 / B3), so they route by code too.
            //
            // The flag is set HERE rather than inferred from the accumulated findings, because only
            // this callback knows a finding came from the Reynolds guard: B1 in particular has five
            // other sources, and recognising the guard's own by the shape of its `where` string
            // would be exactly the parse-the-prose coupling D1 rejects.
            steady = dispatchSteadyState(scenario, inputs, undefined, f => {
                reContractBlocked = true;
                add(f);
            });
        } catch (e) {
            stateError = (e as Error).message;
        }

        if (steady) {
            // B7 (below vapour) and B1 (non-positive C_gas — a degenerate geometry or a non-numeric
            // input) both come out of this one call, already coded. Routing by code keeps the single
            // loop's vapour-before-C_gas per-node order intact, which `f[0]` fidelity depends on.
            // §4.4: B7's wording differs by scenario. §5's "runs partly full and keeps delivering"
            // reasoning assumes a source reservoir at a known elevation and has no analogue for a
            // pump-fed main, so the scenario class is passed rather than defaulted.
            for (const f of FIND_INIT_ADMISSIBLE(steady.init.prevState, steady.init.totalNodes,
                                                 isGravity ? 'gravity' : 'pump')) add(f);
            // A1 must not contradict the Reynolds guard's own verdict — see checkAdvisories.
            checkAdvisories(steady, inputs, v, add, reContractBlocked);
            // Q10: A7 — duty point outside the entered flow range (Q6-e; both sides, builder's pick).
            if (curveIn) {
                const Qs = curveIn.points.map(p => p.Q), Q0 = steady.pump.initialFlow;
                if (Q0 < Math.min(...Qs) || Q0 > Math.max(...Qs)) add(finding('A7', 'tool-limit',
                    'Pump curve', `Duty point outside pump curve: Q0 = ${Q0} m3/s is outside the entered flows.`));
            }
        } else {
            const why = stateError
                ? 'the steady-state calculation could not complete'
                : 'no steady state was returned';
            skipStateChecks(why);
        }
    }

    // ── ASSEMBLE ────────────────────────────────────────────────────────────────────────────────

    const checks: GateCheck[] = [...BLOCKING_ORDER, ...ADVISORY_ORDER].map(code => {
        const findings = acc.get(code) ?? [];
        const why = skipped.get(code);
        return findings.length > 0
            ? { code, severity: GATE_SEVERITY(code), verdict: 'fail' as const, findings }
            : why !== undefined
                ? { code, severity: GATE_SEVERITY(code), verdict: 'not-evaluated' as const,
                    findings: [], skipped: why }
                : { code, severity: GATE_SEVERITY(code), verdict: 'pass' as const, findings: [] };
    });

    const blocking = checks.filter(c => c.severity === 'blocking').flatMap(c => c.findings);
    const advisory = checks.filter(c => c.severity === 'advisory').flatMap(c => c.findings);

    return {
        checks, blocking, advisory,
        runAnalysisAvailable: blocking.length === 0 && stateError === undefined,
        inputBlocked, reContractBlocked,
        steady, stateError,
    };
}

/** `resolveHDown` still throws; the boundary findings above already reported why. */
function tryResolveHDown(v: SelectorValveInput, pipes: PipeSection[]): number | undefined {
    try { return resolveHDown(v, pipes); } catch { return undefined; }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// The original implementations — no guard existed to extract (D7)
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// B1, B4, B8, B9 and A1–A5 have no solver-side predicate behind them, so their wording is NEW and
// carries a risk the extractions do not: it can drift from §4.1's class split and §4.3's ban. All
// of them below are CONTRACT VIOLATIONS or ADVISORIES — neither class is restricted by §4.3, which
// binds tool-limit wording only. Every blocking message here therefore names the offending input,
// which is what §4.2 of the CKPT B.2 brief requires of a contract violation.

/**
 * B8 — pipe list empty, or any pipe with zero/negative length or diameter (§4.1, verbatim).
 *
 * SPLIT WITH B1, so one bad pipe is not reported twice: B8 owns zero-or-negative on length and
 * diameter; B1 owns non-finite on every numeric field including those two. The conditions are
 * disjoint — `NaN` is neither `<= 0` nor `> 0`, and is caught only by B1's `Number.isFinite` test.
 */
function checkB8(pipes: PipeSection[] | undefined, add: (f: GateFinding) => void): void {
    if (!pipes || pipes.length === 0) {
        add(finding('B8', 'contract-violation', 'Pipe list',
            'The pipe list is empty. A pipeline needs at least one reach before anything about it ' +
            'can be computed.'));
        return;
    }
    pipes.forEach((p, i) => {
        const name = `Pipe ${i + 1} of ${pipes.length} ("${p.id}")`;
        if (Number.isFinite(p.length) && p.length <= 0) {
            add(finding('B8', 'contract-violation', `${name} — length`,
                `Length is ${p.length} m. A reach must have a positive length.`));
        }
        if (Number.isFinite(p.diameter) && p.diameter <= 0) {
            add(finding('B8', 'contract-violation', `${name} — internal diameter`,
                `Internal diameter is ${p.diameter} m. A reach must have a positive diameter: the ` +
                `cross-sectional area is computed from it, and everything downstream divides by ` +
                `that area.`));
        }
    });
}

/**
 * B1 — any required input empty, non-numeric, or not finite (§4.1), naming which field (§4.2).
 *
 * Swept field by field rather than tested at the point of use, because "not finite" has to be
 * caught BEFORE the value is consumed: a NaN diameter reaches the mesher and is refused there as a
 * Reynolds-number fault, and a NaN head reaches the admissibility check and is refused as a
 * vapour-pressure fault. Both are the right refusal for the wrong reason — the pattern row 3.12
 * exists to eliminate. Naming the field here is the whole point of the check.
 *
 * Missing valve/reservoir settings and a mis-specified downstream boundary are also B1 and arrive
 * from `FIND_SCENARIO_INPUTS`; they are not repeated here.
 */
function checkB1(scenario: Scenario, inputs: DispatchInputs, add: (f: GateFinding) => void): void {
    const bad = (where: string, label: string, value: unknown) => {
        add(finding('B1', 'contract-violation', where,
            `${label} is ${describe(value)}. It must be a finite number — an empty, non-numeric or ` +
            `unbounded entry cannot be computed with, and reaches the solver as a value that is ` +
            `refused much further downstream, under the wrong description.`));
    };
    const req = (where: string, label: string, value: unknown) => {
        if (typeof value !== 'number' || !Number.isFinite(value)) bad(where, label, value);
    };

    (inputs.pipes ?? []).forEach((p, i) => {
        const name = `Pipe ${i + 1} ("${p.id}")`;
        req(`${name} — length`,           'Length',            p.length);
        req(`${name} — internal diameter`,'Internal diameter', p.diameter);
        req(`${name} — wave speed`,       'Wave speed',        p.waveSpeed);
        req(`${name} — friction factor`,  'Friction factor',   p.frictionFactor);
        req(`${name} — end elevation`,    'End elevation',     p.endElevation);
    });

    // The gravity path DERIVES its flow, so `pump.initialFlow` is only a required entry on the two
    // pump-fed scenarios; on gravity it is a carrier field the solver overwrites (§1.4 note 2).
    // Q10 (plan §4, F6): with a user curve the pump-fed valve flow is DERIVED too, so "Starting
    // flow" and its sign test apply to pump trip, and to pump-valve only without a curve.
    const flowEntered = scenario === 'pump-trip' || (scenario === 'pump-valve' && !inputs.pumpCurve);
    if (scenario !== 'gravity-valve') {
        if (flowEntered) req('Starting flow', 'Starting flow', inputs.pump?.initialFlow);
        req('Pump elevation',   'Pump elevation',       inputs.pump?.elevation);

        // ── The sign test (Row 3.11 Unit C, D-3 — S68) ──────────────────────────────────────────
        //
        // A NEGATIVE starting flow is caught here, in the INPUT phase, on the two scenarios where
        // the user types it. `MOCKUP_NOTES_S65.md` §7.3: without this the user enters it on screen
        // 1, is allowed through, and is refused on screen 2 for a field that lives on screen 1.
        //
        // WHY THIS ONE MOVES AND ZERO FLOW DOES NOT — §4.1's own split decides it, not preference.
        // A negative flow is **B1, a contract violation**: the number cannot describe the system
        // these entry points initialise, and §4.1's B1 row was widened to say so (amended S67,
        // `DECISIONS.md` 2026-08-31). A contract violation is by definition evaluable from the raw
        // inputs, which is this phase. Zero flow is **B2, a tool-limit state** — a real system this
        // program cannot simulate — and a state is only knowable once the state is computed. So B2
        // stays at gate 2, and §7.3's suggestion that it "deserves the same treatment" is answered
        // by the spec's classification rather than overridden by it.
        //
        // GRAVITY IS DELIBERATELY EXCLUDED. There the flow is DERIVED from the head triangle, so
        // there is no field to test and nothing to report next to; it can only be caught once Q0
        // exists, which is gate 2. Hence the `scenario !== 'gravity-valve'` guard this sits inside.
        //
        // `ASSERT_MIAB_RE_CONTRACT` IS NOT WEAKENED and is not touched. It remains the backstop for
        // the derived path and for every direct solver caller, which bypass this file entirely. On
        // a pump scenario the two now agree about the same input, which is the point: one gate at
        // two layers, the way B5 already works (L147). The failing condition is the SIGN, not the
        // magnitude — the guard refuses -1.27e6 exactly as it refuses -1, because the unsteady
        // friction coefficient takes a fractional power of `Re`.
        // ORDERING, checked (action audit S68): this finding can now be B1's positionally-first on
        // an input broken two ways at once, where before S68 the flow raised no input-phase finding
        // at all. That is safe here and would not be inside a `FIND_` function: `f[0]` fidelity
        // matters because `ASSERT_` wrappers throw `f[0]`, and nothing wraps `checkB1` — its output
        // lands in `GateCheck.findings`, which keeps every finding and is rendered in full. The
        // `Number.isFinite` test also keeps this disjoint from `req()` above, so a NaN flow is
        // reported once, as non-finite, and never twice.
        const Q0 = inputs.pump?.initialFlow;
        if (flowEntered && typeof Q0 === 'number' && Number.isFinite(Q0) && Q0 < 0) {
            add(finding('B1', 'contract-violation', 'Starting flow',
                `Starting flow is ${Q0} m3/s. This scenario initialises forward flow only, so a ` +
                `negative value cannot describe the system being set up. Enter the flow as a ` +
                `positive rate; the direction is fixed by the layout, not by the sign. Any ` +
                `negative value is refused, however small.`));
        }
    }
    if (scenario === 'pump-trip') {
        req('Reservoir head',   'Reservoir head',       inputs.reservoir?.head);
        req('Pump trip time',   'Pump trip time',       inputs.pump?.tripTime);
        req('Pump halt time',   'Pump halt time',       inputs.pump?.haltTime);
    }

    const v = inputs.valve;
    if (v && (scenario === 'pump-valve' || scenario === 'gravity-valve')) {
        const c = v.coefficient as Partial<{ Kv0: number; Cv0: number }> | undefined;
        if (c && 'Kv0' in c) req('Valve coefficient (Kv)', 'Valve flow coefficient Kv', c.Kv0);
        else if (c && 'Cv0' in c) req('Valve coefficient (Cv)', 'Valve flow coefficient Cv', c.Cv0);
        else add(finding('B1', 'contract-violation', 'Valve coefficient',
            'No valve flow coefficient was given. Enter the valve\'s fully-open Kv.'));

        // SWITCH ON THE DISCRIMINANT, never `law: any` — corrected S67 after the physics audit.
        // `ClosureLaw`'s `custom` arm has NO `t0` and NO `T_close` (solver.ts `ClosureLaw`), and
        // `evalTau` fully supports it. Under an `any` cast the narrowing is lost, so the two `req`
        // calls below ran unconditionally and emitted two B1 blocking findings for a perfectly
        // valid custom closure — the gate refusing a working system, which is the exact failure
        // §4.1 and L150 exist to prevent. A `switch` forces every arm to be handled, so a future
        // arm cannot slip through the same way.
        const law = v.law;
        if (!law) add(finding('B1', 'contract-violation', 'Valve closure law',
            'No closure law was given. The run needs to know how the valve closes.'));
        else switch (law.law) {
            case 'linear':
                req('Closure start time', 'Closure start time', law.t0);
                req('Closing time',       'Closing time',       law.T_close);
                break;
            case 'parabolic':
                req('Closure start time', 'Closure start time', law.t0);
                req('Closing time',       'Closing time',       law.T_close);
                req('Closure exponent',   'Closure exponent',   law.n);
                break;
            case 'custom': {
                if (!Array.isArray(law.points) || law.points.length === 0) {
                    add(finding('B1', 'contract-violation', 'Closure curve',
                        'The custom closure curve has no points. It needs at least one time and ' +
                        'opening pair before the valve\'s motion is defined.'));
                    break;
                }
                law.points.forEach((pt, k) => {
                    req(`Closure curve point ${k + 1} — time`,    'Time',    pt?.t);
                    req(`Closure curve point ${k + 1} — opening`, 'Opening', pt?.tau);
                });
                break;
            }
            default: {
                const never: never = law;
                add(finding('B1', 'contract-violation', 'Valve closure law',
                    `Unrecognised closure law: ${JSON.stringify(never)}.`));
            }
        }

        if (v.H_down !== undefined)            req('Downstream head at the valve',     'Downstream head at the valve',     v.H_down);
        if (v.downstreamPressure !== undefined) req('Downstream pressure at the valve', 'Downstream pressure at the valve', v.downstreamPressure);
    }

    if (scenario === 'gravity-valve' && inputs.gravity) {
        req('Upstream reservoir head',      'Upstream reservoir head',      inputs.gravity.head);
        req('Upstream reservoir elevation', 'Upstream reservoir elevation', inputs.gravity.elevation);
    }
}

/**
 * B4 — any entered pressure is negative, naming the input and that pressure is measured AT the
 * valve (§4.1/§4.2 both require that second clause; it is the S60 defect the wording exists to
 * prevent recurring).
 *
 * `downstreamPressure` is the only pressure a user enters — every other boundary in this program is
 * a datum-referenced head. `H_down` is deliberately NOT checked here: it is head, not pressure, and
 * a negative head is legitimate on a route below datum.
 *
 * `alreadyReported` suppresses the duplicate when the dispatch layer has already returned a B4 for
 * this same field. That guard's threshold is the vapour floor (−9.8 m), which is LOOSER than "is
 * negative", so any input it catches this check would catch too. Its message says more — it explains
 * the vapour line — so it wins, and this one stands down rather than saying the same thing twice.
 */
function checkB4(v: SelectorValveInput | undefined, alreadyReported: boolean,
                 add: (f: GateFinding) => void): void {
    if (alreadyReported || !v || v.downstreamPressure === undefined) return;
    if (Number.isFinite(v.downstreamPressure) && v.downstreamPressure < 0) {
        add(finding('B4', 'contract-violation', 'Downstream pressure at the valve',
            `Downstream pressure at the valve is ${v.downstreamPressure} m of water, which is ` +
            `negative. This figure is a gauge pressure measured AT the valve, not a head above ` +
            `datum — the valve's own elevation is added to it automatically. Discharge to open air ` +
            `is 0.`));
    }
}

/**
 * B9 — closure law invalid: closing time ≤ 0, start time < 0 (§4.1, verbatim), naming which
 * parameter (§4.2).
 *
 * THIS IS THE FIRST VALIDATION THIS PROGRAM HAS EVER APPLIED TO A CLOSURE LAW. `evalTau` performs
 * none, and DOMAIN-CONSTRAINTS §14 records `T_close = -1` running to completion as a known, unfixed
 * gap. So unlike B5/B6/B7 there is no guard to mirror and no prior wording to inherit — and note
 * what this check does NOT do: it does not close the solver-side gap. A direct solver caller still
 * gets a completed run from a negative closing time. Only the gate refuses it.
 */
function checkB9(v: SelectorValveInput, add: (f: GateFinding) => void): void {
    const law = v.law;
    if (!law) return;                                   // absence is B1's, reported there
    // `custom` carries neither parameter — its motion is the point list, and §4.1's B9 row names
    // "closing time <= 0, start time < 0" only. Narrowing here rather than casting to `any` is what
    // keeps this check from inventing two missing fields on an arm that never had them.
    if (law.law === 'custom') return;
    if (Number.isFinite(law.T_close) && law.T_close <= 0) {
        add(finding('B9', 'contract-violation', 'Closing time',
            `Closing time is ${law.T_close} s. It must be greater than zero: the closure law ` +
            `divides by it, and a valve that closes in no time at all is not a closure this ` +
            `program can represent.`));
    }
    if (Number.isFinite(law.t0) && law.t0 < 0) {
        add(finding('B9', 'contract-violation', 'Closure start time',
            `Closure start time is ${law.t0} s. It cannot be negative — the run starts at t = 0, ` +
            `so a closure beginning before then has already partly happened at the moment the ` +
            `steady state is taken.`));
    }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Advisories — shown, and `Run Analysis` stays available (§4.2)
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// §4.2 requires advisory items to carry the SAME location detail as blocking ones, which is why
// each names its reach or node rather than saying "somewhere on the line".

function checkAdvisories(steady: SteadyStateResult, inputs: DispatchInputs,
                         v: SelectorValveInput | undefined,
                         add: (f: GateFinding) => void,
                         /** True when B3 (or B1/B2 from the same guard) already blocked a reach. */
                         reContractBlocked: boolean): void {
    const { layout, net } = steady;
    const Q = net.pump.initialFlow;
    const pipeIds = net.pipes.map(p => p.id);

    // ── A1 / A2 — velocity, per reach ───────────────────────────────────────────────────────────
    // Same caveat the B3 guard carries (SECTION 9.9 SCOPE LIMIT): on a BRANCHED network per-branch
    // flow is not resolved until GGA runs, so every reach here inherits the trunk's flow. On a
    // series main — what this program validates — that is exact.
    layout.pipeParams.forEach((p, i) => {
        const V = Q / p.A;
        const where = `Pipe ${i + 1} ("${pipeIds[i] ?? i}", diameter ${p.D} m)`;
        // A1 IS BOUNDED BELOW BY B3 — corrected S67 after the physics audit. §4.1 defines A1 as the
        // band "just above the friction model's valid limit", and an advisory saying "the run is
        // allowed and will complete" must never be emitted beside a blocking finding that refuses
        // that same run. Unbounded, it did exactly that: on a below-contract flow it fired
        // alongside B3 with `Run Analysis available = false` printed on the same line. `reContract-
        // Blocked` is the guard's OWN verdict, not a re-derived floor — the bound stays solver-side.
        if (!reContractBlocked && Number.isFinite(V) && V > 0 && V < A1_VERIFIED_VELOCITY_MIN) {
            add(finding('A1', 'tool-limit', where,
                `Flow velocity in this reach is ${V.toPrecision(3)} m/s. The run is allowed and ` +
                `will complete, but this is below ${A1_VERIFIED_VELOCITY_MIN} m/s — the slowest ` +
                `velocity at which this program's surge peak has been measured against the ` +
                `Joukowsky bound and agreed with it. Below that line the measured peak ran high, ` +
                `and increasingly so as the flow drops. Treat the peak as an upper bound rather ` +
                `than a prediction.`));
        }
        if (Number.isFinite(V) && V > A2_VELOCITY_MAX) {
            add(finding('A2', 'tool-limit', where,
                `Flow velocity in this reach is ${V.toPrecision(3)} m/s, above the ` +
                `${A2_VELOCITY_MAX} m/s that is normal practice for a transmission main. The ` +
                `computation is unaffected; the surge this generates scales with velocity, so ` +
                `confirm the velocity itself is intended.`));
        }
    });

    // ── A3 — pressure line within 2 m of the vapour line, WITHOUT crossing it ────────────────────
    // Crossing is B7's, and the two must not both fire on the same node: the band is closed below
    // at zero for exactly that reason. Reads the vapour floor from the solver (VAPOR_HEAD_AT) so
    // this advisory and B7 can never disagree about where the line is.
    const st = steady.init.prevState;
    for (let n = 0; n < steady.init.totalNodes; n++) {
        const margin = st.H[n] - VAPOR_HEAD_AT(st.Z[n]);
        if (Number.isFinite(margin) && margin >= 0 && margin < A3_VAPOUR_MARGIN_M) {
            add(finding('A3', 'tool-limit', `Node ${n} (elevation ${st.Z[n]} m)`,
                `The starting pressure line sits ${margin.toPrecision(3)} m above the vapour line ` +
                `here — it has not crossed it, so the run proceeds. A margin this thin means a ` +
                `small change in the downstream boundary or the elevation profile would push this ` +
                `point below vapour, where this program cannot compute a transient at all.`));
        }
    }

    // ── A4 — a reach shorter than one calculation step ──────────────────────────────────────────
    // READS THE MESHER'S OWN VERDICT — corrected S67 after the physics audit. The first version
    // re-derived the criterion as `length < waveSpeed * baseDt` from the INPUT wave speed, which is
    // both the one bound in this file that was re-derived rather than read, and wrong at the edge:
    // `meshNetwork` computes N = max(1, round(L/(a*baseDt))), so a reach with 1 <= L/step < 1.5
    // ALSO meshes to a single element and the arithmetic test missed it. `N === 1` is the authority.
    //
    // The consequence named below is the real one, and the first version understated it. DC-2 forces
    // Courant = 1 by adjusting celerity: a_adj = dx/baseDt with dx = L/N. On the seeded 5 m reach
    // (a = 1000 m/s, baseDt = 0.03 s) that reach runs at 166.7 m/s, not 1000 — a six-fold celerity
    // distortion that shifts reflection timing and that reach's Joukowsky contribution. Courant is
    // still exactly 1, so this is NOT a DC-2 violation; but A4 is the advisory whose job is to warn
    // about it, and saying only "no interior points" left the larger effect unmentioned.
    const inputPipes = inputs.pipes ?? [];
    layout.pipeParams.forEach((p, i) => {
        if (p.N !== 1) return;
        const input = inputPipes[i];
        const aIn   = input?.waveSpeed;
        const ratio = Number.isFinite(aIn) && aIn! > 0 ? p.a / aIn! : undefined;
        add(finding('A4', 'tool-limit', `Pipe ${i + 1} ("${pipeIds[i] ?? i}")`,
            `This reach meshes to a single calculation element ${p.dx.toPrecision(4)} m long, so it ` +
            `has no interior points and nothing that happens inside it is resolved. ` +
            (ratio !== undefined && ratio < 0.95
                ? `The wave speed in this reach is also adjusted to ${p.a.toPrecision(4)} m/s from ` +
                  `the ${aIn} m/s entered — the calculation keeps one element per time step, so a ` +
                  `short reach is represented as a slower one. Reflections from it arrive late by ` +
                  `about the same factor. `
                : ``) +
            `The step length is set by the pump-attached reach and applies to the whole line.`));
    });

    // ── A5 — closure faster than one wave round-trip ─────────────────────────────────────────────
    // Uses the travel time EXTRACTED from `runCore` (COMPUTE_TRAVEL_TIME), not a second derivation:
    // re-deriving `sum(L/a)` here would put two definitions of one quantity in two files, which is
    // the failure §2 exists to prevent, one layer down.
    const law: any = v?.law;
    if (law && Number.isFinite(law.T_close)) {
        const travelTime = COMPUTE_TRAVEL_TIME(layout, inputPipes.length ? inputPipes : undefined);
        const roundTrip  = 2 * travelTime;
        if (Number.isFinite(roundTrip) && law.T_close < roundTrip) {
            add(finding('A5', 'tool-limit', 'Closing time',
                `The valve closes in ${law.T_close} s, which is less than one wave round-trip of ` +
                `${roundTrip.toPrecision(4)} s (down the line and back). No reflection from the ` +
                `upstream end can reach the valve before it is shut, so the surge will be the full ` +
                `Joukowsky rise — the maximum this line can produce, by definition. That is a real ` +
                `result, not an error: closing more slowly than this is the usual way to reduce it.`));
        }
    }
}

/** Describes a rejected value in the terms a user would recognise, not as `undefined`. */
function describe(value: unknown): string {
    if (value === undefined || value === null) return 'empty';
    if (typeof value !== 'number')             return `not a number (${String(value)})`;
    if (Number.isNaN(value))                   return 'not a number';
    return `${value}`;                          // ±Infinity
}
