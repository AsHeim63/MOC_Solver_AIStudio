// ── report.tsx — Q24: engineering report, "Print / Save as PDF" (display only) ───────────────────────
// A print-ready page of what the results view already shows: line data, scenario, Unprotected System
// (max/min head, envelope chart), Protected System (envelope chart, parts list), notes. Printed with the
// browser's own print (Save as PDF); no new library. Fixed-size charts so the page fits A4 width.
import React from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Legend } from 'recharts';
import { PipeSection, SimulationResults } from './types';
import type { Scenario } from './scenario_dispatch';
import { AirValveStudy, shownOutletMm, MIN_GAUGE_HEAD_M, ADD_VALVE_HEAD_M } from './air_valves';
import { QprvStudy } from './surge_valves';
import { ProfileIcons, profileIcons } from './profile_icons';

const CHART_W = 640, CHART_H = 280;   // px; fits the A4 print width (210 mm − 2×12 mm = 703 px at 96 dpi)

const maxHead = (r: SimulationResults) => Math.max(...r.nodes.map(n => n.maxHead));
const minHead = (r: SimulationResults) => Math.min(...r.nodes.map(n => n.minHead));

function Envelope({ r, scenario, domain, airValves = [] }:
  { r: SimulationResults; scenario: Scenario; domain: [number, number] | [any, any]; airValves?: { x: number; nonSlam: boolean }[] }) {
  return (
    <LineChart width={CHART_W} height={CHART_H} data={r.nodes} margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
      <XAxis dataKey="x" tick={{ fontSize: 9 }}
        tickFormatter={(v) => Math.round(v).toString()}
        label={{ value: 'Distance (m)', position: 'insideBottom', offset: -5, fontSize: 10 }} />
      <YAxis domain={domain} tick={{ fontSize: 9 }} tickFormatter={(v) => Math.round(v).toString()}
        label={{ value: 'Head (m)', angle: -90, position: 'insideLeft', fontSize: 10 }} />
      <Legend verticalAlign="top" align="right" iconType="plainline" wrapperStyle={{ fontSize: '9px' }} />
      <Line name="Max Head" type="linear" dataKey="maxHead" stroke="#ef4444" strokeWidth={1.5} dot={false} isAnimationActive={false} />
      <Line name="Min Head" type="linear" dataKey="minHead" stroke="#3b82f6" strokeWidth={1.5} dot={false} isAnimationActive={false} />
      <Line name="Steady-State" type="linear" dataKey="steadyHead" stroke="#94a3b8" strokeWidth={1} dot={false} strokeDasharray="3 3" isAnimationActive={false} />
      <Line name="Pipeline" type="linear" dataKey="elevation" stroke="#059669" strokeWidth={2} dot={false} isAnimationActive={false} />
      {r.nodes.length > 1 && (
        <ProfileIcons pts={r.nodes.map(n => ({ x: n.x, z: n.elevation }))}
          icons={profileIcons(scenario, r.nodes[r.nodes.length - 1].x, airValves)} />
      )}
    </LineChart>
  );
}

const H2 = ({ children }: { children: React.ReactNode }) =>
  <h2 className="text-sm font-bold uppercase tracking-wider text-slate-700 border-b border-slate-300 pb-1 mb-2 mt-6">{children}</h2>;
const MaxMin = ({ r }: { r: SimulationResults }) => (
  <p className="text-xs mb-2">Max Head <b>{maxHead(r).toFixed(2)} m</b> &nbsp;·&nbsp; Min Head <b>{minHead(r).toFixed(2)} m</b></p>
);

export interface ReportProps {
  pipes: PipeSection[];
  scenario: Scenario;
  scenarioName: string;                 // as the Scenario control reads, e.g. "Valve-Operation, Source: Reservoir"
  scenarioData: [string, string][];     // the scenario's inputs as entered: [label, value with unit]
  unprotected: SimulationResults;
  avStudy: AirValveStudy | null;
  qpStudy: QprvStudy | null;
  domain: [number, number] | [any, any];   // the screen's (Unprotected) head-axis scale
  onClose: () => void;
}

export function Report({ pipes, scenario, scenarioName, scenarioData, unprotected, avStudy, qpStudy, domain, onClose }: ReportProps) {
  // The button means "print now": open the browser's print once the page has drawn.
  React.useEffect(() => { const t = setTimeout(() => window.print(), 400); return () => clearTimeout(t); }, []);
  const total = pipes.reduce((s, p) => s + p.length, 0);
  const td = 'py-0.5 pr-3';
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
        <p className="mb-1">{pipes.length} pipe section{pipes.length === 1 ? '' : 's'}, total length {total} m.</p>
        <table className="w-full text-left">
          <thead className="text-slate-500 text-[10px] uppercase">
            <tr><th className={td}>Pipe</th><th className={td}>Length (m)</th><th className={td}>Diameter (m)</th>
              <th className={td}>Wave speed (m/s)</th><th className={td}>Friction factor</th><th className={td}>End elevation (m)</th></tr>
          </thead>
          <tbody>
            {pipes.map((p, i) => (
              <tr key={p.id + i} className="border-t border-slate-200">
                <td className={td}>{i + 1}</td><td className={td}>{p.length}</td><td className={td}>{p.diameter}</td>
                <td className={td}>{p.waveSpeed}</td><td className={td}>{p.frictionFactor}</td><td className={td}>{p.endElevation}</td>
              </tr>
            ))}
          </tbody>
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
          <MaxMin r={unprotected} />
          <Envelope r={unprotected} scenario={scenario} domain={domain} />
        </section>

        <section data-q24="protected" className="break-inside-avoid">
          <H2>Protected System</H2>
          {!avStudy && !qpStudy && <p>No protection sized: run "Size air valves" or "Size QPRV" on the results screen first.</p>}
          {avStudy && (<>
            <h3 className="font-bold mb-1">Air valves</h3>
            <MaxMin r={avStudy.stage2} />
            <Envelope r={avStudy.stage2} scenario={scenario} domain={domain} airValves={avStudy.valves} />
            <h3 className="font-bold mt-2 mb-1">Parts list</h3>
            {avStudy.valves.length === 0 ? (
              <p>No air valves needed.</p>
            ) : (
              <table className="w-full text-left">
                <thead className="text-slate-500 text-[10px] uppercase">
                  <tr><th className={td}>Type</th><th className={td}>Location (m)</th><th className={td}>Size (mm)</th>
                    <th className={td}>Inlet / outlet (mm)</th><th className={td}>Non-Slam</th></tr>
                </thead>
                <tbody>
                  {avStudy.valves.map(v => (
                    <tr key={v.x} className="border-t border-slate-200">
                      <td className={td}>{v.nonSlam ? 'Non-Slam air valve' : 'Air valve'}</td>
                      <td className={td}>{v.x.toFixed(0)}</td><td className={td}>{v.inlet_mm}</td>
                      <td className={td}>{v.inlet_mm} / {shownOutletMm(v)}</td><td className={td}>{v.nonSlam ? 'Yes' : 'No'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>)}
          {qpStudy && (<>
            <h3 className="font-bold mt-3 mb-1">QPRV</h3>
            <MaxMin r={qpStudy.stage2} />
            <Envelope r={qpStudy.stage2} scenario={scenario} domain={domain} />
            <p className="mt-1">Parts list: one QPRV, size {qpStudy.qprv.size_mm} mm, Kv {qpStudy.qprv.Kv}, closing time {qpStudy.qprv.closingTime} s.</p>
          </>)}
        </section>

        <section className="break-inside-avoid">
          <H2>Notes</H2>
          <ul className="list-disc pl-5 space-y-0.5">
            <li>Method of Characteristics (MOC) transient solver; heads are piezometric (m), pressures gauge.</li>
            <li>Line and scenario data are the inputs as entered on screen when this report was opened.</li>
            <li>Both envelope charts use the Unprotected System head scale.</li>
            {avStudy && <li>Air-valve targets: {MIN_GAUGE_HEAD_M} m at a valve, {ADD_VALVE_HEAD_M} m on the line (gauge).</li>}
            {avStudy && avStudy.unresolved.length > 0 &&
              <li>Target not met at x = {avStudy.unresolved.map(x => x.toFixed(0)).join(', ')} m.</li>}
            {qpStudy && !qpStudy.tried.some(t => t.returns) && <li>QPRV: no table size holds the head at the closing pressure.</li>}
          </ul>
        </section>
      </div>
    </div>
  );
}
