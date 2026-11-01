// ── report.tsx — Q24: engineering report, "Print / Save as PDF" (display only) ───────────────────────
// A print-ready page of what the results view already shows: line data, scenario, Unprotected System
// (max/min head, envelope chart), Protected System (envelope chart, parts list), notes. Printed with the
// browser's own print (Save as PDF); no new library. Fixed-size charts so the page fits A4 width.
import React from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Legend } from 'recharts';
import { PipeSection, SimulationResults } from './types';
import type { Scenario } from './scenario_dispatch';
import { AirValve, AirValveStudy, shownOutletMm, MIN_GAUGE_HEAD_M, ADD_VALVE_HEAD_M } from './air_valves';
import { QprvStudy, SavStudy } from './surge_valves';
import { ProfileIcons, profileIcons } from './profile_icons';
import { holdFilter } from './hold_filter';   // Q31: max/min ignore events shorter than 0.2 s
import { Axis, Qty, fmt, fmtMm, fromCalc, show6, nodesInLength } from './units';   // Q27: shown in the chosen units

type U = Record<Qty, string>;

const CHART_W = 640, CHART_H = 280;   // px; fits the A4 print width (210 mm − 2×12 mm = 703 px at 96 dpi)

const maxHead = (r: SimulationResults) => Math.max(...holdFilter(r).nodes.map(n => n.maxHead));
const minHead = (r: SimulationResults) => Math.min(...holdFilter(r).nodes.map(n => n.minHead));

function Envelope({ r, scenario, axis, airValves = [], devices = [], u }:
  { r: SimulationResults; scenario: Scenario; axis: Axis | null; airValves?: { x: number; nonSlam: boolean }[];
    devices?: SurgeDevice[]; u: U }) {
  // Q27: plotted in the length unit (the axis arrives already in it).
  const L = (v: number) => fromCalc('length', u.length, v);
  const nodes = nodesInLength(holdFilter(r).nodes, u.length);
  return (
    <LineChart width={CHART_W} height={CHART_H} data={nodes} margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
      <XAxis dataKey="x" tick={{ fontSize: 9 }}
        tickFormatter={(v) => Math.round(v).toString()}
        label={{ value: `Distance (${u.length})`, position: 'insideBottom', offset: -5, fontSize: 10 }} />
      <YAxis domain={axis?.domain ?? ['auto', 'auto']} ticks={axis?.ticks} tick={{ fontSize: 9 }} tickFormatter={axis ? axis.tick : (v) => Math.round(v).toString()}
        label={{ value: `Head (${u.length})`, angle: -90, position: 'insideLeft', fontSize: 10 }} />
      <Legend verticalAlign="top" align="right" iconType="plainline" wrapperStyle={{ fontSize: '9px' }} />
      <Line name="Max Head" type="linear" dataKey="maxHead" stroke="#ef4444" strokeWidth={1.5} dot={false} isAnimationActive={false} />
      <Line name="Min Head" type="linear" dataKey="minHead" stroke="#3b82f6" strokeWidth={1.5} dot={false} isAnimationActive={false} />
      <Line name="Steady-State" type="linear" dataKey="steadyHead" stroke="#94a3b8" strokeWidth={1} dot={false} strokeDasharray="3 3" isAnimationActive={false} />
      <Line name="Pipeline" type="linear" dataKey="elevation" stroke="#059669" strokeWidth={2} dot={false} isAnimationActive={false} />
      {nodes.length > 1 && (
        <ProfileIcons pts={nodes.map(n => ({ x: n.x, z: n.elevation }))}
          icons={profileIcons(scenario, nodes[nodes.length - 1].x, airValves.map(v => ({ ...v, x: L(v.x) })),
                              devices.map(d => ({ kind: d.kind, x: L(d.x) })), (nodes[1].x - nodes[0].x) / 2)} />
      )}
    </LineChart>
  );
}

const H2 = ({ children }: { children: React.ReactNode }) =>
  <h2 className="text-sm font-bold uppercase tracking-wider text-slate-700 border-b border-slate-300 pb-1 mb-2 mt-6">{children}</h2>;
const MaxMin = ({ r, u }: { r: SimulationResults; u: U }) => (
  <p className="text-xs mb-2">Max Head <b>{fmt('length', u.length, maxHead(r))} {u.length}</b> &nbsp;·&nbsp; Min Head <b>{fmt('length', u.length, minHead(r))} {u.length}</b></p>
);

// ── Q23: solution sets ──────────────────────────────────────────────────────────────────────────────────
// ANSWERS 2026-10-29 (all device rows): each solution set (air valves + SAV now, air valves + surge tank
// later) is one unit: its devices, its envelope and its parts list. Display only.
export interface SurgeDevice {
  kind: 'sav' | 'qprv';
  x: number;                 // [m]: SAV at the pump-outlet node, QPRV at the end-valve node (O2)
  size_mm: number; Kv: number; closingTime: number;
  sets: [string, number][];  // [label, gauge pressure at the node [m]]
}
export interface SolutionSet {
  name: string;
  result: SimulationResults;                        // the run with this set's devices
  airValves: AirValve[];
  devices: SurgeDevice[];
}

/** The sets sized so far. The SAV runs carry the air valves placed by the previous run (the App drops the
 *  SAV study whenever the air valves change). The QPRV study runs without air valves (Q21). */
export function solutionSets(sv: SavStudy | null, qp: QprvStudy | null, airValves: AirValve[]): SolutionSet[] {
  const out: SolutionSet[] = [];
  if (sv) {
    const { size_mm, Kv, closingTime } = sv.sav;
    out.push({ name: 'Air valves + SAV', result: sv.stage2, airValves,
      devices: [{ kind: 'sav', x: sv.stage2.nodes[0].x, size_mm, Kv, closingTime, sets: [['low', sv.lowSet], ['high', sv.highSet]] }] });
  }
  if (qp) {
    const end = qp.stage2.nodes[qp.stage2.nodes.length - 1], H_open = qp.stage2.qprv?.H_open;
    out.push({ name: 'QPRV', result: qp.stage2, airValves: [],
      devices: [{ kind: 'qprv', x: end.x, ...qp.qprv, sets: H_open === undefined ? []
        : [['set', H_open - end.elevation], ['reference', H_open - QPRV_SET_ABOVE_REF_M - end.elevation]] }] });
  }
  return out;
}

// The solver opens the QPRV above reference + 7 m (solver.ts QPRV_THRESHOLD_M, ruling 2026-10-28; Q19), so
// reference = H_open − 7 m. solver.ts does not export it and stays unchanged in a display row (LOOK-AT Q23).
const QPRV_SET_ABOVE_REF_M = 7.0;

const NAME = { sav: 'SAV (surge anticipating valve)', qprv: 'QPRV (quick pressure relief valve)' };

/** One table per set: air valves and surge valves, the columns of both (— where a column does not apply). */
export function PartsList({ set, u }: { set: SolutionSet; u: U }) {
  const td = 'py-1 pr-3';
  const mm = (v: number) => fmtMm(u.diameter, v);
  return (
    <table className="w-full text-left">
      <thead className="text-slate-500 text-[10px] uppercase">
        <tr><th className={td}>Type</th><th className={td}>Location ({u.length})</th><th className={td}>Size ({u.diameter})</th>
          <th className={td}>Inlet / outlet ({u.diameter})</th><th className={td}>Non-Slam</th><th className={td}>{u.valve}</th>
          <th className={td}>Set / reference pressure ({u.pressure})</th><th className={td}>Closing time (s)</th></tr>
      </thead>
      <tbody>
        {set.airValves.map(v => (
          <tr key={'av' + v.x} className="border-t border-slate-200">
            <td className={td}>{v.nonSlam ? 'Non-Slam air valve' : 'Air valve'}</td>
            <td className={td}>{fmt('length', u.length, v.x, 0)}</td><td className={td}>{mm(v.inlet_mm)}</td>
            <td className={td}>{mm(v.inlet_mm)} / {mm(shownOutletMm(v))}</td><td className={td}>{v.nonSlam ? 'Yes' : 'No'}</td>
            <td className={td}>—</td><td className={td}>—</td><td className={td}>—</td>
          </tr>
        ))}
        {set.devices.map(d => (
          <tr key={d.kind} className="border-t border-slate-200">
            <td className={td}>{NAME[d.kind]}</td>
            <td className={td}>{fmt('length', u.length, d.x, 0)}</td><td className={td}>{mm(d.size_mm)}</td>
            <td className={td}>—</td><td className={td}>—</td><td className={td}>{fmt('valve', u.valve, d.Kv)}</td>
            <td className={td}>{d.sets.map(([k, p]) => `${k} ${fmt('pressure', u.pressure, p)}`).join(' / ') || '—'}</td>
            <td className={td}>{Math.round(d.closingTime * 10) / 10}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A set as one unit [data-q23-set]: max/min head, envelope chart with its icons, parts list. */
export function SetView({ set, scenario, axis, u }: { set: SolutionSet; scenario: Scenario; axis: Axis | null; u: U }) {
  return (
    <div data-q23-set={set.name} className="break-inside-avoid">
      <h4 className="font-bold mt-3 mb-1">{set.name}</h4>
      <MaxMin r={set.result} u={u} />
      <div className="overflow-x-auto">
        <Envelope r={set.result} scenario={scenario} axis={axis} airValves={set.airValves} devices={set.devices} u={u} />
      </div>
      <h5 className="font-bold mt-2 mb-1 text-xs">Parts list</h5>
      <PartsList set={set} u={u} />
    </div>
  );
}

export interface ReportProps {
  pipes: PipeSection[];
  scenario: Scenario;
  scenarioName: string;                 // as the Scenario control reads, e.g. "Valve-Operation, Source: Reservoir"
  scenarioData: [string, string][];     // the scenario's inputs as entered: [label, value with unit]
  unprotected: SimulationResults;
  avStudy: AirValveStudy | null;
  qpStudy: QprvStudy | null;
  svStudy: SavStudy | null;              // Q23
  pkg: { av: boolean; qprv: boolean; sav: boolean };   // Q23: devices ticked in the preferences' device package
  axis: Axis | null;                     // the screen's (Unprotected) head-axis scale, in the length unit
  u: U;                                    // Q27: the unit of each quantity (units.ts unitsOf)
  onClose: () => void;
}

export function Report({ pipes, scenario, scenarioName, scenarioData, unprotected, avStudy, qpStudy, svStudy, pkg, axis, u, onClose }: ReportProps) {
  // The button means "print now": open the browser's print once the page has drawn.
  React.useEffect(() => { const t = setTimeout(() => window.print(), 400); return () => clearTimeout(t); }, []);
  const total = pipes.reduce((s, p) => s + p.length, 0);
  const td = 'py-0.5 pr-3';
  const sh = (qty: Qty, v: number) => show6(fromCalc(qty, u[qty], v));   // line data: 6 significant digits, as the inputs
  const inUnit = (mm: number) => fmtMm(u.diameter, mm);
  const envProps = { scenario, axis, u };
  const sets = solutionSets(svStudy, qpStudy, avStudy?.valves ?? []);   // Q23
  // Q23: the air valves are listed once: in the set that carries them, if one is sized.
  const avInSet = sets.find(s => s.airValves.length > 0);
  const runs = [pkg.av && 'Size air valves', pkg.sav && scenario === 'pump-trip' && 'Size SAV',
                pkg.qprv && scenario !== 'pump-trip' && 'Size QPRV'].filter((t): t is string => !!t).map(t => `"${t}"`);
  return (
    <div className="min-h-screen bg-white text-slate-900 font-sans">
      <div className="print:hidden flex justify-end gap-2 max-w-[720px] mx-auto px-4 pt-4">
        <button onClick={() => window.print()} className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 text-white">Print</button>
        <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-300 text-slate-700">Back to results</button>
      </div>
      <div data-q24="report" className="max-w-[720px] mx-auto px-4 pb-8 text-xs">
        <h1 className="text-xl font-black mt-4">Water Hammer Analysis — Engineering Report</h1>
        <p className="text-slate-500">HydroGuard · MOC solver · {new Date().toLocaleDateString()}</p>

        <H2>Line Data</H2>
        <p className="mb-1">{pipes.length} pipe section{pipes.length === 1 ? '' : 's'}, total length {fmt('length', u.length, total, 0)} {u.length}.</p>
        <table className="w-full text-left">
          <thead className="text-slate-500 text-[10px] uppercase">
            <tr><th className={td}>Pipe</th><th className={td}>Length ({u.length})</th><th className={td}>Diameter ({u.diameter})</th>
              <th className={td}>Wave speed ({u.velocity})</th><th className={td}>Friction factor</th><th className={td}>End elevation ({u.length})</th></tr>
          </thead>
          <tbody>
            {pipes.map((p, i) => (
              <tr key={p.id + i} className="border-t border-slate-200">
                <td className={td}>{i + 1}</td><td className={td}>{sh('length', p.length)}</td><td className={td}>{sh('diameter', p.diameter)}</td>
                <td className={td}>{sh('velocity', p.waveSpeed)}</td><td className={td}>{p.frictionFactor}</td><td className={td}>{sh('length', p.endElevation)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-slate-300 font-semibold"><td className={td}>Total</td><td className={td}>{sh('length', total)}</td></tr>
          </tfoot>
        </table>

        <H2>Scenario</H2>
        <p className="mb-1 font-semibold">{scenarioName}</p>
        <table className="text-left">
          <tbody>
            {scenarioData.map(([k, v]) => <tr key={k}><td className={td + ' text-slate-500'}>{k}</td><td className={td}>{v}</td></tr>)}
          </tbody>
        </table>

        <section data-q24="unprotected" className="break-inside-avoid">
          <H2>Unprotected System</H2>
          <MaxMin r={unprotected} u={u} />
          <Envelope r={unprotected} {...envProps} />
        </section>

        <section data-q24="protected" className="break-inside-avoid">
          <H2>Protected System</H2>
          {!avStudy && sets.length === 0 && <p>No protection sized: {runs.length === 0
            ? 'no device is ticked in the preferences\' device package.'
            : `run ${runs.length > 1 ? runs.slice(0, -1).join(', ') + ' or ' + runs[runs.length - 1] : runs[0]} on the results screen first.`}</p>}
          {avStudy && (<>
            <h3 className="font-bold mb-1">Air valves</h3>
            <MaxMin r={avStudy.stage2} u={u} />
            <Envelope r={avStudy.stage2} {...envProps} airValves={avStudy.valves} />
            <h3 className="font-bold mt-2 mb-1">Parts list</h3>
            {avInSet ? <p>Listed in the "{avInSet.name}" parts list below.</p> : avStudy.valves.length === 0 ? (avStudy.unresolved.length === 0 &&
              <p>No air valves needed.</p>
            ) : (
              <table className="w-full text-left">
                <thead className="text-slate-500 text-[10px] uppercase">
                  <tr><th className={td}>Type</th><th className={td}>Location ({u.length})</th><th className={td}>Size ({u.diameter})</th>
                    <th className={td}>Inlet / outlet ({u.diameter})</th><th className={td}>Non-Slam</th></tr>
                </thead>
                <tbody>
                  {avStudy.valves.map(v => (
                    <tr key={v.x} className="border-t border-slate-200">
                      <td className={td}>{v.nonSlam ? 'Non-Slam air valve' : 'Air valve'}</td>
                      <td className={td}>{fmt('length', u.length, v.x, 0)}</td><td className={td}>{inUnit(v.inlet_mm)}</td>
                      <td className={td}>{inUnit(v.inlet_mm)} / {inUnit(shownOutletMm(v))}</td><td className={td}>{v.nonSlam ? 'Yes' : 'No'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>)}
          {sets.map(s => <React.Fragment key={s.name}><SetView set={s} {...envProps} /></React.Fragment>)}
        </section>

        <section className="break-inside-avoid">
          <H2>Notes</H2>
          <ul className="list-disc pl-5 space-y-0.5">
            <li>Method of Characteristics (MOC) transient solver; heads are piezometric ({u.length}), pressures gauge ({u.pressure}).</li>
            <li>Line and scenario data are the inputs of the run shown (the report is offered only while the inputs on screen still match that run).</li>
            <li>Both envelope charts use the Unprotected System head scale.</li>
            {avStudy && <li>Air-valve targets: {fmt('pressure', u.pressure, MIN_GAUGE_HEAD_M)} {u.pressure} at a valve, {fmt('pressure', u.pressure, ADD_VALVE_HEAD_M)} {u.pressure} on the line (gauge).</li>}
            {avStudy && avStudy.unresolved.length > 0 &&
              <li>Target not met at x = {avStudy.unresolved.map(x => fmt('length', u.length, x, 0)).join(', ')} {u.length}.</li>}
            {qpStudy?.notes.map(n => <li key={n}>{n}.</li>)}
          </ul>
        </section>
      </div>
    </div>
  );
}
