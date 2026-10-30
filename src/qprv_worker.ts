// ── qprv_worker.ts — Q29: the QPRV study off the main thread, so the screen does not freeze ──────────
// Message in: { scenario, inputs }. Message out: { study } or { error }.

import { sizeQprv } from './surge_valves';
import { DispatchInputs, Scenario } from './scenario_dispatch';

self.onmessage = (e: MessageEvent<{ scenario: Scenario; inputs: DispatchInputs }>) => {
    try {
        self.postMessage({ study: sizeQprv(e.data.scenario, e.data.inputs) });
    } catch (error) {
        self.postMessage({ error: error instanceof Error ? error.message : String(error) });
    }
};
