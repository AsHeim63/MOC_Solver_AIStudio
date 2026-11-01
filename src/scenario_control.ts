// ── scenario_control.ts — the Scenario control's one mapping (Row 3.11 Unit C, D-7) ────────────
//
// Ruling R1 (DECISIONS.md 2026-09-06/08): the input screen draws a two-way radio,
// `Pump-Operation` / `Valve-Operation`, and on `Valve-Operation` one sub-choice,
// `Source: Pump / Reservoir`. The engine has three scenarios. This file is the ONLY place the
// control's state becomes a `Scenario` — a total function with an exhaustive switch, so a new
// operation or source cannot compile until it is mapped (MOCKUP_NOTES_S65.md §3.5 seam).
//
//   Pump-Operation                       -> pump-trip
//   Valve-Operation + Source: Pump       -> pump-valve
//   Valve-Operation + Source: Reservoir  -> gravity-valve
//
// Kept out of `App.tsx` so the harness (`scenario_control_S70.ts`) can drive each control state
// into `dispatchSimulation` and record which entry point ran.

import { Scenario } from './scenario_dispatch';
import { ValveModel, VALVE_BUTTERFLY_A, VALVE_GATE_B, VALVE_RHO_DEFAULT } from './solver';

export type Operation   = 'pump-operation' | 'valve-operation';
export type ValveSource = 'pump' | 'reservoir';

// Q36: the valve-type control — ONE list over the solver's valve types and closure modes. A type and a
// non-position mode are never combined (gravity_fed_valve_spec.md §3.4), so one list cannot pick a
// refused pair. 'generic' sends no field at all: today's run, bit-identical.
export type ValveType = 'generic' | 'butterfly' | 'gate' | 'globe-linear' | 'linear-resistance' | 'linear-flow';
export const VALVE_TYPES: [ValveType, string][] = [
    ['generic', 'Default'], ['butterfly', 'Butterfly'], ['gate', 'Gate'],
    ['globe-linear', 'Globe (linear)'], ['linear-resistance', 'Linear resistance'], ['linear-flow', 'Linear flow'],
];
export const VALVE_TYPE_PARAMS = { a: VALVE_BUTTERFLY_A.def, b: VALVE_GATE_B.def, rho: VALVE_RHO_DEFAULT };

export function valveModelFromControl(type: ValveType, p: { a: number; b: number; rho: number }): ValveModel {
    switch (type) {
        case 'generic':           return {};
        case 'butterfly':         return { preset: 'butterfly', a: p.a };
        case 'gate':              return { preset: 'gate', b: p.b };
        case 'globe-linear':      return { preset: 'globe-linear' };
        case 'linear-resistance': return { mode: 'linear-resistance', rho: p.rho };
        case 'linear-flow':       return { mode: 'linear-flow' };
    }
}

/** The source sub-choice is read only on `Valve-Operation`; on `Pump-Operation` it is ignored. */
export function scenarioFromControl(operation: Operation, source: ValveSource): Scenario {
    switch (operation) {
        case 'pump-operation':
            return 'pump-trip';
        case 'valve-operation':
            switch (source) {
                case 'pump':      return 'pump-valve';
                case 'reservoir': return 'gravity-valve';
                default: {
                    const never: never = source;
                    throw new Error(`Unknown valve source: ${never}`);
                }
            }
        default: {
            const never: never = operation;
            throw new Error(`Unknown operation: ${never}`);
        }
    }
}
