/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo } from 'react';
import {
  Activity,
  Plus,
  Trash2,
  Play,
  Pause,
  Square,
  SkipBack,
  SkipForward,
  Settings2,
  Waves,
  Info,
  ArrowRight,
  Droplets,
  Zap,
  TrendingUp,
  TrendingDown,
  Clock,
  Gauge,
  FileUp,
  PanelLeftClose,
  PanelLeftOpen,
  LayoutDashboard,
  ZoomIn,
  ZoomOut
} from 'lucide-react';
import Papa from 'papaparse';
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  Legend, 
  ResponsiveContainer,
  AreaChart,
  Area
} from 'recharts';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from './lib/utils';
import { PipeSection, PumpParams, ReservoirParams, SimulationResults } from './types';
import { runWaterHammerSimulation } from './solver';
import { dispatchSimulation, Scenario, DispatchInputs } from './scenario_dispatch';
import { sizeAirValves, AirValveStudy, shownOutletMm, MIN_GAUGE_HEAD_M, ADD_VALVE_HEAD_M } from './air_valves';
import { holdFilter, heldPockets } from './hold_filter';   // Q31
import { QprvStudy, peakAll, sizeSav, SavStudy, SAV_NOTE_EAS } from './surge_valves';
import { scenarioFromControl, Operation, ValveSource } from './scenario_control';
import { ProfileIcons, profileIcons } from './profile_icons';   // Q17
import { Report, SetView, solutionSets } from './report';   // Q24, Q23
import { projectText, parseProject } from './project_file';   // Q25
import { Qty, UnitChoice, UnitSystem, CHOICES, DEFAULT_UNITS, validChoice, unitsOf, toCalc, fromCalc, show6, isHeadUnit, fmt, fmtMm, nodesInLength, niceAxis, valveBasis } from './units';   // Q26, Q27
// ── Row 3.11 Unit C, D-5b ──────────────────────────────────────────────────────────────────────
// The gate engine, wired for the first time. It has been in this project since 2026-08-31 and has
// never executed: nothing imported it. Nothing is GATED by it yet either — the run below proceeds
// whatever the report says. Disabling the run, the modal and the gate screen are D-5c and D-6.
import { evaluateGate, GateReport } from './gate_checks';
import { buildProfileView, summariseProfile, ProfileView } from './gate_view';
// ── D-5c: Screen 2 reads its chart, tooltip and verdict classes from here — never re-derived ──
import {
  buildGateChartData, tooltipFields, summaryMode,
  runAnalysisState, GateChartPoint, numberCaveats,
  gateMessage, acknowledgeReturnTo, modalAutoDismiss, GATE_PASS_LINE, GATE_FAIL_TITLE, A3_NOTE,
} from './gate_screen';

/** Q26: one numeric input box in the chosen unit. `value` is the calc-unit (SI) text; the box shows it converted
 *  (6 significant digits), keeps the typed text while focused, and hands back the typed value converted to SI.
 *  Rendering never writes back, so switching units never moves a stored value. No `qty` = no conversion. */
function UnitInput({ qty, unit = '', value, onValue, className, step, min }: {
  qty?: Qty; unit?: string; value: string; onValue: (si: string) => void; className: string; step?: string; min?: string;
}) {
  const [text, setText] = useState<string | null>(null);
  const conv = (t: string, f: (v: number) => number | string) =>
    t.trim() === '' || !Number.isFinite(Number(t)) ? t : String(f(Number(t)));
  const shown = text ?? (qty ? conv(value, v => show6(fromCalc(qty, unit, v))) : value);
  return (
    <input type="number" step={step} min={min} value={shown} className={className}
      onFocus={() => setText(shown)} onBlur={() => setText(null)}
      onChange={e => { setText(e.target.value); onValue(qty ? conv(e.target.value, v => toCalc(qty, unit, v)) : e.target.value); }} />
  );
}

/** Screen 2 tooltip: the seven SPEC_S63.md §3.2 fields. Head and pressure come from one object. */
function GateTooltip({ active, payload, caveats, u }: { active?: boolean; payload?: any[]; caveats?: string[]; u: Record<Qty, string> }) {
  if (!active || !payload || payload.length === 0) return null;
  const t = tooltipFields(payload[0].payload as GateChartPoint);
  const hp = t.headAndPressure;
  return (
    <div className="bg-white rounded-xl shadow-lg border border-slate-200 p-3 text-[11px] font-mono min-w-[18rem]">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <span>DISTANCE {fmt('length', u.length, t.distance, 1)} {u.length}</span>
        <span>TOTAL HEAD {fmt('length', u.length, hp.head)} {u.length}</span>
        <span>ELEVATION {fmt('length', u.length, t.elevation)} {u.length}</span>
        <span>PRESSURE {fmt('pressure', u.pressure, hp.pressureM)} {u.pressure}</span>
        {t.flow.map(f => (
          <React.Fragment key={f.pipeId}>
            <span>FLOW {fmt('flow', u.flow, f.m3s)} {u.flow}{t.flow.length > 1 ? ` [${f.pipeId}]` : ''}</span>
            <span>VELOCITY {fmt('velocity', u.velocity, f.velocity)} {u.velocity}</span>
          </React.Fragment>
        ))}
      </div>
      {caveats?.map(c => (
        <div key={c} className="mt-1 font-sans font-bold text-amber-700 max-w-[18rem] whitespace-normal">{c}</div>
      ))}
    </div>
  );
}

/**
 * D-6: the gate's verdict as the user reads it — header, Screen 2's rail and the modal all render
 * this one view of `gateMessage` (ANSWERS 2026-10-03 Q2, 2026-10-04 Q3). No codes, no check list,
 * no log. Notes are plain text: no fail styling, they never read as a problem.
 */
function GateMessageView({ report, system }: { report: GateReport; system: UnitSystem }) {
  const m = gateMessage(report, system);
  return (
    <div data-gate-message={m.passed ? 'pass' : 'fail'} className="space-y-0.5">
      {m.passed ? (
        <p className="font-bold text-emerald-700">{GATE_PASS_LINE}</p>
      ) : (
        <>
          <p className="font-bold text-red-600">{GATE_FAIL_TITLE}</p>
          {m.problems.map(p => <p key={p} data-gate-problem className="text-red-600">{p}</p>)}
        </>
      )}
      {m.notes.filter(n => n !== A3_NOTE).map(n => <p key={n} data-gate-note className="text-slate-600">{n}</p>)}
    </div>
  );
}

// THERE IS NO DEFAULT PIPELINE PROFILE. The profile is the user's data — it arrives from a CSV or
// is typed into the table, and this program has no business inventing one (user, 2026-09-12).
//
// The seeded 1000 m / 0.5 m / 20 m reach that used to sit here was a fabricated system, and it was
// load-bearing in a way that is easy to miss: it gave every scenario a plausible-looking starting
// state, so the app always opened on something that ran. With no profile the gate reports B8 — "the
// pipe list is empty" — which is correct, is exactly what row 3.11 exists to say, and is a better
// first screen than a pipeline the user never described.
const DEFAULT_PIPES: PipeSection[] = [];

const DEFAULT_PUMP: PumpParams = {
  initialHead: 100,
  initialFlow: 0.5,
  tripTime: 2,
  haltTime: 5,
  elevation: 10,
};

// ── Boundary conditions (Row 3.11 Unit C, D-4 — S68) ────────────────────────
//
// ONE CONVENTION AT BOTH ENDS, IN EVERY SCENARIO: a gauge PRESSURE at the point,
// in metres of water column. The datum-referenced head the solver wants is derived
// here, in the input layer, as `Head = Pressure + Elevation of that point` — the
// rule `resolveHDown` already applied downstream, now applied everywhere
// (DECISIONS.md 2026-09-08, ruling R2).
//
// This replaces `DEFAULT_RESERVOIR`, a WATER-SURFACE ELEVATION, which made the app
// ask for the same downstream tank two different ways depending on the run: 30 on a
// pump trip, 10 on a valve run, for one tank on a pipe end at 20 m. That mix is what
// the 2026-08-20 instruction ordered removed.
//
// UNSUPPLIED MEANS ZERO GAUGE — atmospheric, NOT absolute (ratified 2026-08-20).
// Zero absolute is a full vacuum ~10.2 m lower, sits below vapour pressure, and
// would be refused by the initial-condition guard. That rule governs a boundary the
// FILE does not supply, and the CSV import below honours it: an absent column-I value
// parses to 0.
//
// The SEEDED demo state the app opens with follows the same rule, and both ends are
// atmospheric. A reservoir open to the air IS 0 gauge at its surface; the driving head
// of a gravity main comes from its TOPOGRAPHY, not from a pressure at the source.
//
//   outlet  the valve scenarios already opened at 0, discharge to open air. Kept. A pump
//           trip opened at a reservoir head of 30 m over a last node at 20 m, i.e. 10 m
//           gauge — so its default DOES change, from a 10 m tank to open air, and its
//           opening result changes with it. One field cannot carry two old defaults, and
//           0 gauge is the ratified one.
//   inlet   0, like the outlet.
//
// Node 0's ELEVATION is not here, and no number is invented for it. It is PROFILE data —
// the Y of the first point — so it comes from the file on import, or from the user with
// the rest of the profile. `PipeSection` carries only `endElevation`, so the pipe list
// alone cannot express it; that is why it is tracked separately, not why it may be made up.
//
// Two earlier attempts at this default were both wrong, and both in the same way:
// `gravityHead = 43.22` over a flat 20 m line was 23.22 m of water standing on the level —
// a pressurised feed described as a gravity one; and replacing it with a source seeded at
// 43.22 m invented a hill to put the reservoir on. The driving head of a gravity main comes
// from the user's topography or it does not exist.
const DEFAULT_OUTLET_PRESSURE = 0;   // m gauge at the last node — open to air
const DEFAULT_INLET_PRESSURE  = 0;   // m gauge at node 0 — open to air

export default function App() {
  const [pipes, setPipes] = useState<PipeSection[]>(() => {
    const saved = localStorage.getItem('hg_pipes');
    return saved ? JSON.parse(saved) : DEFAULT_PIPES;
  });
  const [pump, setPump] = useState<PumpParams>(() => {
    const saved = localStorage.getItem('hg_pump');
    return saved ? JSON.parse(saved) : DEFAULT_PUMP;
  });
  // NOT restored from localStorage, deliberately. The old `hg_reservoir` key holds a
  // WATER-SURFACE ELEVATION, and this state is a PRESSURE (R2). Reading a stored 30 back
  // into it would silently turn a tank at 30 m into one at 50 m on a pipe end at 20 m —
  // the same number meaning a different system. The key is removed on mount instead.
  const [outletPressure, setOutletPressure] = useState(DEFAULT_OUTLET_PRESSURE);
  const [results, setResults] = useState<SimulationResults | null>(null);
  // Q14: air valve study (stage 1 unprotected, stage 2 protected); null until "Size air valves".
  const [avStudy, setAvStudy] = useState<AirValveStudy | null>(null);
  // Q21: QPRV sizing study (valve-closure scenarios); null until "Size QPRV".
  const [qpStudy, setQpStudy] = useState<QprvStudy | null>(null);
  // Q22: SAV sizing study (pump trip, with the placed air valves); null until "Size SAV".
  const [svStudy, setSvStudy] = useState<SavStudy | null>(null);
  const [showReport, setShowReport] = useState(false);   // Q24: engineering report page
  // Q24: the inputs of the run on screen; the report is offered only while the inputs still match them.
  const [reportKey, setReportKey] = useState<string | null>(null);
  // Q15: device package approved in the user preferences (air valves = the only device type now).
  // Not approved -> no protected results are shown.
  const [avApproved, setAvApproved] = useState<boolean>(() => {
    try { return localStorage.getItem('hg_pkg_air_valves') === '1'; } catch { return false; }
  });
  const approveAirValves = (on: boolean) => {
    setAvApproved(on);
    try { localStorage.setItem('hg_pkg_air_valves', on ? '1' : '0'); } catch { /* storage blocked */ }
    if (!on && avStudy) { setIsAnimating(false); setResults(avStudy.stage1); setAvStudy(null); }
    if (!on) setSvStudy(null);   // Q22: a SAV result never outlives the air valves it was sized with
  };
  // Q23: QPRV and SAV in the device package. No stored choice = approved (their sections were always shown
  // before Q23). Not approved -> no section, no result, no row, no icon.
  const pkgRead = (key: string) => { try { return localStorage.getItem(key) !== '0'; } catch { return true; } };
  const pkgWrite = (key: string, on: boolean) => { try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* storage blocked */ } };
  const [qprvApproved, setQprvApproved] = useState<boolean>(() => pkgRead('hg_pkg_qprv'));
  const [savApproved, setSavApproved] = useState<boolean>(() => pkgRead('hg_pkg_sav'));
  const approveQprv = (on: boolean) => { setQprvApproved(on); pkgWrite('hg_pkg_qprv', on); if (!on) { stopQprvStudy(); setQpStudy(null); } };
  const approveSav = (on: boolean) => { setSavApproved(on); pkgWrite('hg_pkg_sav', on); if (!on) setSvStudy(null); };
  const [isSimulating, setIsSimulating] = useState(false);
  // Q29: the QPRV study runs in a Worker (qprv_worker.ts) so the screen does not freeze; stopped when its
  // inputs are dropped, so a stale study never lands.
  const qprvWorker = React.useRef<Worker | null>(null);
  const stopQprvStudy = () => {
    if (!qprvWorker.current) return;
    qprvWorker.current.terminate(); qprvWorker.current = null; setIsSimulating(false);
  };

    // ── Scenario control (Row 3.11 Unit C, D-7 — ruling R1) ───────────────────
  // The control's state is the two-way radio plus the valve source; `scenario` is DERIVED from it
  // through the one mapping in scenario_control.ts, never set directly.
  const [operation, setOperation] = useState<Operation>('pump-operation');
  const [valveSource, setValveSource] = useState<ValveSource>('pump');
  const scenario: Scenario = scenarioFromControl(operation, valveSource);
  // Valve inputs (both valve scenarios). Defaults = REF-PAR reference closure (S50/S52-ratified):
  // Kv0 full-precision = (0.5/√30)·11493.9 (display convention "≈1049.3"); parabolic n=2,
  // t0=2 s, T_close=1 s; H_down=0; no check valve. Exponent 1 gives a linear closure.
  const [valveKv0, setValveKv0] = useState(1049.2447172847715);
  const [valveT0, setValveT0] = useState(2.0);
  const [valveTClose, setValveTClose] = useState(1.0);
  const [valveExponent, setValveExponent] = useState(2);
  // Holds the message when the solver refuses a run, so it can be shown on screen (S62).
  const [simError, setSimError] = useState<string | null>(null);
  
  // ── D-5b: the gate's own output ───────────────────────────────────────────────────────────
  // Read by nothing except the status line beside the Run button, which exists so that "the
  // engine ran" is an observation and not an assumption. `gateCrash` is separate from `simError`
  // on purpose: a gate that throws must not be reported as a refused run.
  const [gateReport, setGateReport] = useState<GateReport | null>(null);
  const [gateProfile, setGateProfile] = useState<ProfileView | null>(null);
  // ── D-5c: which screen. 'input' = Screen 1 (inputs + transient results), 'gate' = Screen 2.
  const [view, setView] = useState<'input' | 'gate'>('input');
  const [gateCrash, setGateCrash] = useState<string | null>(null);
  // ── D-6: the gate modal, opened each time `Run Steady-State` evaluates the gate.
  const [gateModalOpen, setGateModalOpen] = useState(false);
  const [valveCheckValve, setValveCheckValve] = useState(false);
  // Gravity-fed upstream (gravity-valve only). The pressure at node 0, plus node 0's own
  // elevation. `inletPressure` replaces the former `gravityHead`, which was a datum head —
  // one end of the app carrying a head while the other carried a pressure is the datum
  // asymmetry the physics audit raised twice, and R2 closes it.
  const [inletPressure, setInletPressure] = useState(DEFAULT_INLET_PRESSURE);
  // ── Node 0, the SOURCE node (user, 2026-09-12) ──────────────────────────────────────────
  //
  // Node 0 is always the source — the pump's check valve on a pumped main, the supply point
  // on a gravity one — and it is a node like any other, so the user provides it. Its
  // elevation is PROFILE data, the Y at X = 0. It lives with the profile, not with the
  // boundaries: a boundary is a pressure, and this is geometry.
  //
  // ONE FIELD, replacing two. The build had `gravityElevation` on the valve panel AND
  // `Pump Elevation` on the pump panel, and both land on the same place — `Z[0]`, via
  // `pump.elevation` (solver.ts:1480, 1608) or `upstream.elevation` (:2817) depending on
  // scenario. Two inputs for one physical node is the same defect class as the two boundary
  // conventions R2 removed: they can be set to disagree, and nothing said which won.
  const [sourceElevation, setSourceElevation] = useState(0);

  // ── Q10: user pump curve (pump-fed valve only) ───────────────────────────────────────────
  // Points as text (so a cell can be empty), held in SI (m³/s, m); the boxes show them in the chosen units (Q26).
  // Three empty rows by default: the curve is the user's data, like the profile.
  const [curveRows, setCurveRows] = useState<{ Q: string; H: string }[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('hg_pump_curve') ?? 'null');
      // Every stored row must be { Q: string, H: string }; anything else falls back to the default.
      if (Array.isArray(saved) && saved.every(r => r !== null && typeof r === 'object' &&
                                               typeof r.Q === 'string' && typeof r.H === 'string')) {
        return saved;
      }
    } catch { /* fall through to the default */ }
    return [{ Q: '', H: '' }, { Q: '', H: '' }, { Q: '', H: '' }];
  });
  const setCurveCell = (i: number, key: 'Q' | 'H', value: string) =>
    setCurveRows(curveRows.map((x, j) => j === i ? { ...x, [key]: value } : x));
  // An empty cell is NaN (refused as "Invalid pump curve"), never 0.
  const curveCell = (s: string) => s.trim() === '' ? NaN : Number(s);
  // m of water, gauge (Q6-a). Kept as typed, like the curve cells: an emptied field is NaN
  // (refused as a non-finite suction pressure), never 0.
  const [suctionText, setSuctionText] = useState<string>(() => {
    try {
      const saved = localStorage.getItem('hg_suction_pressure');
      if (saved !== null) return saved;
    } catch { /* fall through to the default */ }
    return '0';
  });
  const suctionPressure = curveCell(suctionText);
  // Q26: the units the inputs are shown and typed in. A viewing choice, kept in the browser; state stays SI.
  const [unitChoice, setUnitChoice] = useState<UnitChoice>(() => {
    try { return validChoice(JSON.parse(localStorage.getItem('hg_units') ?? 'null')); } catch { return DEFAULT_UNITS; }
  });
  React.useEffect(() => {
    try { localStorage.setItem('hg_units', JSON.stringify(unitChoice)); } catch { /* not persisted */ }
  }, [unitChoice]);
  const uu = unitsOf(unitChoice);
  // Q27: results are SI; shown converted. L = a length / head / elevation / distance in the length unit.
  const L = (v: number) => fromCalc('length', uu.length, v);
  const inUnit = (mm: number) => fmtMm(uu.diameter, mm);


  // Persistence Effects
  React.useEffect(() => {
    localStorage.setItem('hg_pipes', JSON.stringify(pipes));
  }, [pipes]);

  React.useEffect(() => {
    localStorage.setItem('hg_pump', JSON.stringify(pump));
  }, [pump]);

  React.useEffect(() => {
    try { localStorage.setItem('hg_pump_curve', JSON.stringify(curveRows)); } catch { /* not persisted */ }
  }, [curveRows]);

  React.useEffect(() => {
    try { localStorage.setItem('hg_suction_pressure', suctionText); } catch { /* not persisted */ }
  }, [suctionText]);

  // The downstream tank is no longer stored, and the old key is actively removed rather than
  // left to rot: it holds an ELEVATION under a name this app no longer has a field for, and
  // anything that read it later would read it as a pressure (R2). Runs once.
  React.useEffect(() => {
    localStorage.removeItem('hg_reservoir');
  }, []);

  const [showInputs, setShowInputs] = useState(true);
  const [activeTab, setActiveTab] = useState<'pressure' | 'vapor' | 'flow'>('pressure');

  // Animation State — time-based for smooth interpolation between frames
  const [isAnimating, setIsAnimating] = useState(false);
  const [animTime, setAnimTime] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);

  // Node selector (for tabbed charts)
  const [selectedNodeIdx, setSelectedNodeIdx] = useState(0);

  // Tab X-axis zoom level (0 = full range, each tick = 0.8×)
  const [tabZoomLevel, setTabZoomLevel] = useState(0);

  const totalLength = useMemo(() => pipes.reduce((acc, p) => acc + p.length, 0), [pipes]);

  /**
   * Celerity (Wave Speed) Calculation:
   * a = sqrt( (K/rho) / (1 + (K/E)*(D/e)) )
   * K (Bulk Modulus of Water) = 2.2 GPa
   * rho (Density of Water) = 1000 kg/m3
   * E (Young's Modulus) = 200 GPa (Steel), 3 GPa (PVC), etc.
   * D/e = Diameter / Wall Thickness ratio.
   */
  const calculateWaveSpeed = (material: string, diameter: number, wallThickness: number): number => {
    const K = 2.2e9; 
    let E = 200e9; 
    const m = material.toLowerCase();
    if (m.includes('steel')) E = 200e9;
    else if (m.includes('pvc')) E = 3e9;
    else if (m.includes('hdpe')) E = 0.8e9;
    else if (m.includes('concrete')) E = 30e9;
    const a = 1483 / Math.sqrt(1 + (K / E) * (diameter / wallThickness));
    return Number(a.toFixed(2));
  };

  /**
   * Friction Factor (Darcy-Weisbach f) from Hazen-Williams C:
   * Derived by equating HW head loss to DW head loss.
   */
  const convertHWToDarcy = (C: number, D: number, Q: number): number => {
    if (Q <= 0 || D <= 0) return 0.02;
    const v = Q / (Math.PI * D * D / 4);
    if (v < 0.001) return 0.02;
    // According to typical units, 133.2 seems commonly used but may result in v10 error mentioned by user. We'll add the 10 correction factor:
    const f = (134.2 / (Math.pow(v, 0.148) * Math.pow(C, 1.852) * Math.pow(D, 0.166))) / 10;
    return Number(f.toFixed(4));
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    Papa.parse(file, {
      complete: (results) => {
        const rows = results.data as string[][];
        if (rows.length < 2) return;

        // Skip header if present (assuming row 0 is header or contains "x")
        const startRow = rows[0][0].toLowerCase().includes('x') ? 1 : 0;
        
        let lastDiam = 0, lastWT = 0, lastMat = 'Steel', lastC = 120, lastQ = 0;
        const processedPipes: PipeSection[] = [];
        let initialHead = pump.initialHead;
        let pFlow = pump.initialFlow;

        // i2 in excel usually refers to row 2, col I (index 8).
        // If there's a header, Excel Row 2 is data index 1.
        // If no header, Excel Row 2 is data index 1.
        let reservoirHeadOffset = 0;
        const i2Cell = rows[1]?.[8];
        if (i2Cell) {
          reservoirHeadOffset = parseFloat(i2Cell) || 0;
        }

        for (let i = startRow; i < rows.length; i++) {
          const row = rows[i];
          if (!row[0] && !row[1]) continue; 

          const x = parseFloat(row[0]);
          const y = parseFloat(row[1]);
          if (isNaN(x) || isNaN(y)) continue;

          // Inheritance for columns 2-6
          if (row[2]) lastDiam = parseFloat(row[2]) / 1000; 
          if (row[3]) lastWT = parseFloat(row[3]) / 1000; 
          if (row[4]) lastMat = row[4];
          if (row[5]) lastC = parseFloat(row[5]);
          if (row[6]) lastQ = parseFloat(row[6]) / 3600; 

          // Device checks
          if (row[7]?.toLowerCase() === 'pump') {
            // The pump's elevation is NOT read here — node 0's elevation is the profile's first
            // point, read once below. The pump is at X = 0, so this row IS that point.
            pFlow = Number(lastQ.toFixed(4));
            if (row[8]) initialHead = Number((y + parseFloat(row[8])).toFixed(2));
          }

          if (i + 1 < rows.length) {
            const nextRow = rows[i+1];
            const nextX = parseFloat(nextRow[0]);
            const nextY = parseFloat(nextRow[1]);
            if (!isNaN(nextX) && !isNaN(nextY)) {
              const length = Math.sqrt(Math.pow(nextX - x, 2) + Math.pow(nextY - y, 2));
              if (length > 0) {
                processedPipes.push({
                  id: Math.random().toString(36).substr(2, 9),
                  length: Number(length.toFixed(2)),
                  diameter: Number((lastDiam || 0.5).toFixed(4)),
                  waveSpeed: calculateWaveSpeed(lastMat, lastDiam || 0.5, lastWT || 0.01),
                  frictionFactor: convertHWToDarcy(lastC, lastDiam || 0.5, lastQ),
                  endElevation: Number(nextY.toFixed(2))
                });
              }
            }
          }
        }

        if (processedPipes.length > 0) {
          setPipes(processedPipes);
          // `elevation` is no longer set from the pump-tagged row. Node 0's elevation comes from
          // the profile's FIRST POINT, below, and from there alone — the pump sits at X = 0, so
          // the two coincide, and reading it twice is how they would come to disagree.
          setPump(prev => ({ ...prev, initialFlow: pFlow, initialHead: initialHead }));
          // R2: the column-I value IS the water level ABOVE the node it sits at, which is the
          // gauge pressure at that node. It is taken through unchanged. The elevation is no
          // longer added here — the input layer adds it once, at dispatch, for every scenario.
          // Adding it here as well was the second half of the mixed convention.
          setOutletPressure(Number(reservoirHeadOffset.toFixed(2)));
          // Node 0 is the profile's first point, for EVERY scenario — not a gravity-only input.
          // Its elevation is the Y there, and the column-I offset is the pressure there.
          const firstElev = parseFloat(rows[startRow]?.[1]);
          if (!isNaN(firstElev)) {
            setSourceElevation(Number(firstElev.toFixed(2)));
            setInletPressure(Number(reservoirHeadOffset.toFixed(2)));
          }
        }
      }
    });
  };

  const handleAddPipe = () => {
    const lastPipe = pipes[pipes.length - 1];
    const newPipe: PipeSection = {
      id: Math.random().toString(36).substr(2, 9),
      length: 500,
      diameter: 0.5,
      waveSpeed: 1000,
      frictionFactor: 0.02,
      endElevation: lastPipe ? lastPipe.endElevation + 10 : 20,
    };
    setPipes([...pipes, newPipe]);
  };

  const handleRemovePipe = (id: string) => {
    if (pipes.length > 1) {
      setPipes(pipes.filter(p => p.id !== id));
    }
  };

  const handleUpdatePipe = (id: string, updates: Partial<PipeSection>) => {
    setPipes(pipes.map(p => p.id === id ? { ...p, ...updates } : p));
  };

  // ── D-5b: the solver's inputs, assembled in ONE place ───────────────────────────────────────
  // Lifted verbatim out of `handleRunSimulation` so the gate and the run read the same expression.
  // Two assemblies of one set of inputs is a silent-disagreement defect: they drift, and the gate
  // then passes a system the run never sees. Nothing inside this function changed when it moved.
  const buildDispatchInputs = (): DispatchInputs => {
    // ── The boundary conversion, in ONE place (R2) ──────────────────────────────────
    // Every end of every scenario is entered as a gauge pressure and becomes a
    // datum-referenced head here: `Head = Pressure + Elevation of that point`.
    //
    //   outlet, pump-trip     -> reservoir.head            = p + Z(last node)
    //   outlet, valve runs    -> valve.downstreamPressure  = p   (converted in
    //                            scenario_dispatch's resolveHDown, by the same rule —
    //                            passed as a pressure so the unit boundary is kept)
    //   inlet, gravity        -> gravity.head              = p + Z(node 0)
    //
    // The last node's elevation is the last pipe's `endElevation`, which is the node
    // `CALC_BC_VALVE` / the terminal reservoir is dispatched at — the same elevation
    // `resolveHDown` uses, so the two ends cannot drift apart.
    const lastEndElevation = pipes.length > 0 ? pipes[pipes.length - 1].endElevation : 0;
    const outletReservoir: ReservoirParams = { head: outletPressure + lastEndElevation };

    // Node 0's elevation reaches the solver through whichever field that scenario uses —
    // `pump.elevation` on a pumped main, `upstream.elevation` on a gravity one. Both are
    // `Z[0]`. Sourced from ONE value so the two can never be set to disagree.
    return {
      pipes, pump: { ...pump, elevation: sourceElevation }, reservoir: outletReservoir,
      valve: scenario === 'pump-trip' ? undefined : {
        coefficient: { Kv0: valveKv0 },
        law: { law: 'parabolic', t0: valveT0, T_close: valveTClose, n: valveExponent },
        downstreamPressure: outletPressure,
        check_valve: valveCheckValve,
      },
      gravity: scenario === 'gravity-valve'
        ? { head: inletPressure + sourceElevation, elevation: sourceElevation }
        : undefined,
      // Q10: user pump curve, pump-fed valve only.
      pumpCurve: scenario === 'pump-valve'
        ? { points: curveRows.map(r => ({ Q: curveCell(r.Q), H: curveCell(r.H) })), suctionPressure }
        : undefined,
    };
  };

  // Q24: every input that feeds the run (or the report's line/scenario data), as one comparable string.
  // Q25 (Q24 open item): only the scenario's own inputs. Pump-fed valve: flow from the curve, trip
  // neutralised; gravity: no pump; so the pump record counts on pump trip only (Z[0] always).
  // Leaving the pump record out on pump-valve relies on the gate refusing an invalid curve (no run, no report).
  const runKey = () => {
    const d = buildDispatchInputs();
    return JSON.stringify([scenario, { ...d, pump: scenario === 'pump-trip' ? d.pump : { elevation: d.pump.elevation } },
                           scenario === 'pump-valve' ? [suctionText, curveRows] : null]);
  };
  // Q24: sizing on other inputs than the run -> no report.
  const dropReportIfInputsChanged = () => { const k = runKey(); setReportKey(r => r === k ? r : null); };

  // ── Q25: project file (Save project / Open project) ──────────────────────────────────────
  const [projectMsg, setProjectMsg] = useState<string | null>(null);
  const projectInput = React.useRef<HTMLInputElement>(null);
  const saveProject = () => {
    setProjectMsg(null);
    const text = projectText({ operation, valveSource, pipes, pump, sourceElevation, outletPressure, inletPressure,
      valve: { kv0: valveKv0, t0: valveT0, tClose: valveTClose, exponent: valveExponent, checkValve: valveCheckValve },
      pumpCurve: curveRows, suctionPressure: suctionText, preferences: { airValves: avApproved } });
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'hydroguard-project.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const openProject = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    setProjectMsg(null);
    if (!file) return;
    let text: string;
    try { text = await file.text(); } catch { setProjectMsg('Could not read the file — nothing changed'); return; }
    const p = parseProject(text);
    if (typeof p === 'string') { setProjectMsg(p); return; }
    setOperation(p.operation); setValveSource(p.valveSource); setPipes(p.pipes); setPump(p.pump);
    setSourceElevation(p.sourceElevation); setOutletPressure(p.outletPressure); setInletPressure(p.inletPressure);
    setValveKv0(p.valve.kv0); setValveT0(p.valve.t0); setValveTClose(p.valve.tClose);
    setValveExponent(p.valve.exponent); setValveCheckValve(p.valve.checkValve);
    setCurveRows(p.pumpCurve); setSuctionText(p.suctionPressure); approveAirValves(p.preferences.airValves);
    // Results on screen belong to the old inputs.
    stopQprvStudy();
    setIsAnimating(false); setResults(null); setAvStudy(null); setQpStudy(null); setSvStudy(null); setReportKey(null); setSimError(null);
    setGateReport(null); setGateProfile(null); setGateCrash(null); setView('input');
  };

  const handleRunSimulation = () => {
    setIsSimulating(true);
    setIsAnimating(false);
    setAnimTime(0);
    setTabZoomLevel(0);
    setTimeout(() => {
      try {
        const inputs = buildDispatchInputs();

        // ── D-5b: the gate runs, and gates NOTHING ──────────────────────────────────────
        // First execution of `evaluateGate` outside a test harness. It is deliberately
        // isolated from the run: its own try/catch, and the run below proceeds whatever
        // it reports. A gate that throws on a real profile shows up beside the button
        // instead of taking a working run down with it.
        try {
          const report = evaluateGate(scenario, inputs);
          const profile = report.steady ? buildProfileView(report.steady) : null;
          setGateReport(report);
          setGateProfile(profile);
          setGateCrash(null);
        } catch (gateError) {
          console.error("Gate evaluation failed", gateError);
          setGateReport(null);
          setGateProfile(null);
          setGateCrash(gateError instanceof Error ? gateError.message : String(gateError));
        }

        const res = dispatchSimulation(scenario, inputs);

        setResults(res);
        setReportKey(runKey());
        setAvStudy(null);
        setQpStudy(null);
        setSvStudy(null);
        setSimError(null);
        setSelectedNodeIdx(0);
      } catch (error) {
        console.error("Simulation failed", error);
        setSimError(error instanceof Error ? error.message : String(error));
      } finally {
        setIsSimulating(false);
      }
    }, 100);
  };

  // Q14: size air valves after the transient run; shows stage 2, stage 1 stays one click away.
  const handleSizeAirValves = () => {
    setIsSimulating(true);
    setIsAnimating(false);
    setTimeout(() => {
      try {
        dropReportIfInputsChanged();
        const study = sizeAirValves(scenario, buildDispatchInputs());
        setAvStudy(study);
        setSvStudy(null);   // Q22: sized with the previous air valves
        setResults(study.stage2);
        setSimError(null);
      } catch (error) {
        console.error("Air valve sizing failed", error);
        setSimError(error instanceof Error ? error.message : String(error));
      } finally {
        setIsSimulating(false);
      }
    }, 100);
  };

  // Q21/Q29: QPRV size and closing time found after the Unprotected run, in a Worker (no screen freeze).
  const handleSizeQprv = () => {
    stopQprvStudy();
    setIsSimulating(true);
    dropReportIfInputsChanged();
    const w = new Worker(new URL('./qprv_worker.ts', import.meta.url), { type: 'module' });
    qprvWorker.current = w;
    const done = (study: QprvStudy | null, error?: string) => {
      if (qprvWorker.current !== w) return;
      stopQprvStudy();
      if (study) { setQpStudy(study); setSimError(null); }
      else { console.error("QPRV sizing failed", error); setSimError(error ?? 'QPRV sizing failed'); }
    };
    w.onmessage = (e: MessageEvent<{ study?: QprvStudy; error?: string }>) => done(e.data.study ?? null, e.data.error);
    w.onerror = (e: ErrorEvent) => done(null, e.message);
    w.postMessage({ scenario, inputs: buildDispatchInputs() });
  };

  // Q22: SAV size, closing time and hold-open searched from the system with the air valves placed
  // (ANSWERS 2026-10-29); background, as the QPRV.
  const handleSizeSav = () => {
    if (!avStudy) return;   // the air-valve stage first (button disabled until it has run)
    const airValves = avStudy.valves;
    setIsSimulating(true);
    setTimeout(() => {
      try {
        dropReportIfInputsChanged();
        setSvStudy(sizeSav(scenario, { ...buildDispatchInputs(), airValves }));
        setSimError(null);
      } catch (error) {
        console.error("SAV sizing failed", error);
        setSimError(error instanceof Error ? error.message : String(error));
      } finally {
        setIsSimulating(false);
      }
    }, 100);
  };

  // ── D-5c: `Run Steady-State` — evaluates the gate, runs NOTHING ───────────────────────────────
  // PLAN_S69.md §2 D-5c: input phase blocked -> stay on Screen 1 with the gate-1 modal (D-6).
  // Otherwise -> Screen 2 with the gate-2 modal. A gate that throws stays on Screen 1 with "Gate
  // could not run": with no report there is nothing to gate the run on, so it fails closed.
  const handleRunSteadyState = () => {
    setIsSimulating(true);
    setTimeout(() => {
      try {
        const report = evaluateGate(scenario, buildDispatchInputs());
        setGateReport(report);
        setGateProfile(report.steady ? buildProfileView(report.steady) : null);
        setGateCrash(null);
        setGateModalOpen(true);
        if (!report.inputBlocked) {
          // Entering Screen 2 stops the transient animation loop: its effect lives at the top of
          // App and does not unmount when the results pane stops rendering (PLAN_S69.md §8).
          setIsAnimating(false);
          setView('gate');
        }
      } catch (gateError) {
        console.error("Gate evaluation failed", gateError);
        setGateReport(null);
        setGateProfile(null);
        setGateCrash(gateError instanceof Error ? gateError.message : String(gateError));
      } finally {
        setIsSimulating(false);
      }
    }, 100);
  };

  // ── D-5c: Screen 2's derived display data. Projections of the report, nothing computed. ──────
  const gateChart = useMemo(() => gateProfile ? buildGateChartData(gateProfile) : [], [gateProfile]);
  const gateSummary = useMemo(() => gateProfile ? summariseProfile(gateProfile) : null, [gateProfile]);
  const runState = gateReport ? runAnalysisState(gateReport) : { available: false };
  // D-6: the genuinely clean case closes itself after 3 s; anything else waits for a click (PLAN_S68 §4 6.6).
  React.useEffect(() => {
    if (!gateModalOpen || !gateReport || !modalAutoDismiss(gateReport)) return;
    const t = setTimeout(() => setGateModalOpen(false), 3000);
    return () => clearTimeout(t);
  }, [gateModalOpen, gateReport]);
  // D-6: the modal's one close action — its button (`Continue` / `Acknowledge & Return`) and the
  // Escape key both call this, so the two can never route differently.
  const closeGateModal = React.useCallback(() => {
    setGateModalOpen(false);
    if (gateReport && !gateReport.runAnalysisAvailable) setView(acknowledgeReturnTo(gateReport));
  }, [gateReport]);
  React.useEffect(() => {
    if (!gateModalOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeGateModal(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [gateModalOpen, closeGateModal]);
  const SCENARIO_LABEL: Record<Scenario, string> = {
    'pump-trip': 'Pump trip', 'pump-valve': 'Pump-fed + valve closure', 'gravity-valve': 'Gravity-fed + valve closure',
  };

  // Derive simulation time bounds
  const simTMax = useMemo(() => {
    if (!results || results.fullHistory.length === 0) return 0;
    return results.fullHistory[results.fullHistory.length - 1].time;
  }, [results]);

  // Smooth animation loop — advances sim-time continuously; chart interpolates between surrounding frames
  React.useEffect(() => {
    if (!isAnimating || !results || results.fullHistory.length <= 1) return;

    let raf: number;
    let last = performance.now();

    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setAnimTime(prev => {
        const next = prev + dt * playbackSpeed;
        if (next >= simTMax) {
          setIsAnimating(false);
          return simTMax;
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isAnimating, results, playbackSpeed, simTMax]);

  // Current frame index derived from animTime (largest frame with time <= animTime)
  const currentFrame = useMemo(() => {
    if (!results || results.fullHistory.length === 0) return 0;
    const fh = results.fullHistory;
    let lo = 0, hi = fh.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (fh[mid].time <= animTime) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }, [results, animTime]);

  // Q31: max/min lines and summary numbers ignore events shorter than 0.2 s (ANSWERS 2026-10-31).
  const shownNodes = useMemo(() => (results ? holdFilter(results).nodes : []), [results]);

  // Interpolated HGL at animTime for smooth playback
  const animatedChartData = useMemo(() => {
    if (!results || results.fullHistory.length === 0) return [];
    const fh = results.fullHistory;
    const a = currentFrame;
    const b = Math.min(a + 1, fh.length - 1);
    const tA = fh[a].time;
    const tB = fh[b].time;
    const alpha = tB === tA ? 0 : Math.max(0, Math.min(1, (animTime - tA) / (tB - tA)));
    // Q27: plotted in the length unit (factor 1 in Metric, so the Metric numbers are unchanged).
    return nodesInLength(shownNodes, uu.length).map((node, i) => ({
      ...node,
      currentHead: L(fh[a].heads[i] * (1 - alpha) + fh[b].heads[i] * alpha)
    }));
  }, [results, shownNodes, currentFrame, animTime, uu.length]);

  // Q14: every later stage keeps the stage-1 (unprotected) axis scale.
  const scaleResults = avStudy?.stage1 ?? results;
  const protectedShown = !!avStudy && results === avStudy.stage2;   // Q15 heading
  const sets = solutionSets(svStudy, qpStudy, avStudy?.valves ?? []);   // Q23
  const avInSet = sets.find(s => s.airValves.length > 0);   // Q23: the air valves are listed once, in that set
  // Q23: SAV / QPRV icons on the main profile (sized = ticked: unticking drops the study). The SAV set carries
  // the air valves, so it shows with them; the QPRV runs without air valves, so not over the air-valve runs' Unprotected view.
  const surgeIcons = sets.flatMap(s => s.devices).filter(d => d.kind === 'sav' ? protectedShown : !avStudy || protectedShown);
  const yAxisDomain = useMemo(() => {
    if (!scaleResults) return ['auto', 'auto'] as [any, any];
    const minYValue = Math.min(...scaleResults.nodes.map(n => Math.min(n.elevation, n.minHead)));
    const maxHead = Math.max(...scaleResults.nodes.map(n => n.maxHead));
    const yMin = Math.round((minYValue - 15) / 5) * 5;
    const yMax = Math.round(maxHead + 10);
    return [yMin, yMax] as [number, number];
  }, [scaleResults]);
  // Q27: the same scale in the length unit, widened to a nice step there so the ticks still span Max / Min Head.
  const yAxisShown = typeof yAxisDomain[0] === 'number' ? niceAxis(L(yAxisDomain[0]), L(yAxisDomain[1])) : null;

 // Selectable nodes: upstream boundary + all pipe-to-pipe junction nodes
  const selectableNodes = useMemo(() => {
    if (!results) return [] as { idx: number; label: string; x: number }[];
    const arr: { idx: number; label: string; x: number }[] = [
      { idx: 0, label: scenario === 'gravity-valve' ? 'Upstream Reservoir' : 'Check Valve (Pump Discharge)', x: 0 }
    ];
    let cumL = 0;
    for (let pi = 0; pi < pipes.length - 1; pi++) {
      cumL += pipes[pi].length;
      let best = 0, bestDiff = Infinity;
      for (let i = 0; i < results.nodes.length; i++) {
        const d = Math.abs(results.nodes[i].x - cumL);
        if (d < bestDiff) { bestDiff = d; best = i; }
      }
      arr.push({ idx: best, label: `Junction ${pi + 1}–${pi + 2} (x=${fmt('length', uu.length, cumL, 1)} ${uu.length})`, x: cumL });
    }
    return arr;
  }, [results, pipes, scenario, uu.length]);

  // Clamp selection if pipe count changes
  React.useEffect(() => {
    if (selectableNodes.length === 0) return;
    if (!selectableNodes.some(n => n.idx === selectedNodeIdx)) {
      setSelectedNodeIdx(selectableNodes[0].idx);
    }
  }, [selectableNodes, selectedNodeIdx]);

  // Per-node time history for the tabbed charts (driven by node selector).
  // Flow = Q_out at the selected node = flow in the pipe immediately downstream.
  const selectedTimeHistory = useMemo(() => {
    if (!results || !results.nodes[selectedNodeIdx]) return [];
    const node = results.nodes[selectedNodeIdx];
    const elev = node.elevation;
    // Q27: plotted in the chosen units (pressure, flow, volume). Q31: air pockets shorter than 0.2 s not shown.
    const vols = heldPockets(results, results.fullHistory.map(f => (f.vapors ? f.vapors[selectedNodeIdx] : 0)));
    return results.fullHistory.map((f, k) => ({
      time: f.time,
      head: f.heads[selectedNodeIdx],
      pressure: fromCalc('pressure', uu.pressure, f.heads[selectedNodeIdx] - elev),
      flow: fromCalc('flow', uu.flow, f.flows ? f.flows[selectedNodeIdx] : 0),
      vaporVolume: fromCalc('volume', uu.volume, vols[k])
    }));
  }, [results, selectedNodeIdx, uu.pressure, uu.flow, uu.volume]);

  // Q14: pressure / flow tab axes from stage 1 at the selected node (the shown run without a study).
  // Q27: nice steps in the shown unit.
  const tabYDomain = useMemo(() => {
    const r = avStudy?.stage1 ?? results, z = r?.nodes[selectedNodeIdx]?.elevation;
    if (!r || z === undefined || !r.fullHistory.length) return { pressure: undefined, flow: undefined };
    const span = (v: number[]) => niceAxis(Math.min(...v), Math.max(...v));
    return {
      pressure: span(r.fullHistory.map(f => fromCalc('pressure', uu.pressure, f.heads[selectedNodeIdx] - z))),
      flow: span(r.fullHistory.map(f => fromCalc('flow', uu.flow, f.flows ? f.flows[selectedNodeIdx] : 0))),
    };
  }, [avStudy, results, selectedNodeIdx, uu.pressure, uu.flow]);

  // Effective t_max for tab charts given current zoom level
  const effectiveTabTMax = useMemo(() => {
    if (simTMax <= 0) return 0;
    return simTMax * Math.pow(0.8, tabZoomLevel);
  }, [simTMax, tabZoomLevel]);

  // Slice data to visible time window
  const zoomedTabData = useMemo(
    () => selectedTimeHistory.filter(d => d.time <= effectiveTabTMax + 1e-9),
    [selectedTimeHistory, effectiveTabTMax]
  );

  // Reset zoom when node or tab changes (keeps UX predictable)
  React.useEffect(() => { setTabZoomLevel(0); }, [selectedNodeIdx, activeTab]);

  // Envelope-chart tooltip: distance with 1 decimal; all series except Pipeline show pressure (head − elevation)
  const envelopeTooltipFormatter = (value: any, name: string, props: any): [string, string] => {
    if (typeof value !== 'number') return [String(value), name];
    // Q27: the plotted values are in the length unit; pressure = H - z formed there, then shown in the pressure unit.
    if (name === 'Pipeline') return [value.toFixed(2) + ' ' + uu.length, 'Elevation'];
    const elev = props?.payload?.elevation ?? 0;
    return [fmt('pressure', uu.pressure, toCalc('length', uu.length, value - elev)) + ' ' + uu.pressure, name + ' (Pressure)'];
  };
  const envelopeLabelFormatter = (label: any) => {
    const n = typeof label === 'number' ? label : parseFloat(label);
    return `Distance: ${isFinite(n) ? n.toFixed(1) : label} ${uu.length}`;
  };

  // Q24: the report replaces the app page while open (print shows only the report).
  if (showReport && results) {
    // Q25 (Q24 open item): the scenario's own inputs only.
    // Q27: in the chosen units, 6 significant digits as the input boxes (a blank or bad curve cell stays as typed).
    const show = (qty: Qty, v: number | string) => {
      const t = String(v);
      return t.trim() === '' || !Number.isFinite(Number(t)) ? t : `${show6(fromCalc(qty, uu[qty], Number(t)))} ${uu[qty]}`;
    };
    const data: [string, string][] = scenario === 'gravity-valve'
      ? [['Pressure at X = 0', show('pressure', inletPressure)]]
      : scenario === 'pump-valve'
      ? [['Suction pressure', show('pressure', suctionText)], ['Pump curve', curveRows.map(r => `${show('flow', r.Q)} / ${show('length', r.H)}`).join('; ')]]
      : [['Initial flow', show('flow', pump.initialFlow)],
         ['Pump curve', 'built-in (DOMAIN §5): shut-off head 1.33 × steady head, run-out flow 2 × initial flow']];
    data.push(...(scenario === 'pump-trip'
      ? [['Pump trip at', `${pump.tripTime} s`], ['Pump halt time', `${pump.haltTime} s`]]
      : [[`Valve ${uu.valve}`, `${fmt('valve', uu.valve, valveKv0)} ${valveBasis(uu.valve)}`], ['Closure start', `${valveT0} s`], ['Closure time', `${valveTClose} s`],
         ['Closure exponent', String(valveExponent)]]) as [string, string][],
      [`Pressure at ${scenario === 'pump-trip' ? 'System Outlet' : "Valve's Outlet"}`, show('pressure', outletPressure)],
      ['Elevation at X = 0', show('length', sourceElevation)]);
    const name = scenario === 'pump-trip' ? 'Pump-Operation — pump trip'
      : `Valve-Operation, Source: ${scenario === 'gravity-valve' ? 'Reservoir' : 'Pump'} — valve closure`;
    return (
      <Report pipes={pipes} scenario={scenario} scenarioName={name} scenarioData={data}
        unprotected={avStudy?.stage1 ?? qpStudy?.stage1 ?? results} avStudy={avStudy} qpStudy={qpStudy} svStudy={svStudy}
        pkg={{ av: avApproved, qprv: qprvApproved, sav: savApproved }}
        axis={yAxisShown} u={uu} onClose={() => setShowReport(false)} />
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans selection:bg-blue-100">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 min-h-16 py-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-blue-200">
              <Waves size={24} />
            </div>
            <div>
              <h1 className="font-bold text-lg tracking-tight">HydroGuard</h1>
              <p className="text-xs text-slate-500 font-medium">Water Transient Analyzer</p>
            </div>
          </div>
          
          <div className="flex items-center gap-4">
            {view === 'input' ? (
            <button
              onClick={() => setShowInputs(!showInputs)}
              className="flex items-center gap-2 px-4 py-2 text-sm font-bold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors border border-slate-200"
            >
              {showInputs ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
              {showInputs ? 'Hide Input Data' : 'Expand Input Data'}
            </button>
            ) : (
            // Back To Start is navigation, never a reset: every entered value stays (PLAN_S68 §5.4).
            <button
              onClick={() => setView('input')}
              className="flex items-center gap-2 px-4 py-2 text-sm font-bold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors border border-slate-200"
            >
              <SkipBack size={16} />
              Back To Start
            </button>
            )}
            <div className="w-px h-6 bg-slate-200 mx-2" />
            {/* Q25: project file */}
            <button onClick={saveProject}
              className="text-xs font-bold text-slate-500 hover:text-blue-600 transition-colors uppercase tracking-wider">Save project</button>
            <button onClick={() => projectInput.current?.click()}
              className="text-xs font-bold text-slate-500 hover:text-blue-600 transition-colors uppercase tracking-wider">Open project</button>
            <input ref={projectInput} type="file" accept=".json,application/json" onChange={openProject} className="hidden" />
            {projectMsg && <span className="text-xs font-bold text-red-600">{projectMsg}</span>}
            <button
              onClick={() => {
                localStorage.clear();
                window.location.reload();
              }}

              className="text-xs font-bold text-slate-400 hover:text-red-500 transition-colors uppercase tracking-wider"
            >
              Reset Data
            </button>
            {/* ── The gate's status line — D-5b, moved OUT of the Reset Data button (D-5c) ──
                It used to sit inside that button, so the row's gap-4 never applied ("Reset
                DataGate — ..."). As its own sibling it gets the row's gap, beside the primary
                button. D-6: it prints the ruled pass/fail lines only — no codes, no log. */}
            {gateCrash ? (
              <span className="text-xs font-bold text-red-600 max-w-[16rem] truncate">
                Gate could not run
              </span>
            ) : gateReport && view !== 'gate' ? (
              <div data-gate-status className="text-[11px] leading-tight max-w-[24rem]">
                <GateMessageView report={gateReport} system={unitChoice.system} />
              </div>
            ) : null}
            {/* Screen 1: `Run Steady-State` evaluates the gate only (PLAN_S68 §2 D7).
                Screen 2: `Run Analysis` runs today's handleRunSimulation unchanged, then returns
                to Screen 1 where the transient renders. Disabled off `runAnalysisAvailable`. */}
            {(() => {
              const onGate = view === 'gate';
              const disabled = isSimulating || (onGate && !runState.available);
              return (
            <button
              onClick={onGate ? () => { handleRunSimulation(); setView('input'); } : handleRunSteadyState}
              disabled={disabled}
              className={cn(
                "flex items-center gap-2 px-6 py-2.5 rounded-full font-semibold transition-all shadow-md",
                disabled
                  ? "bg-slate-100 text-slate-400 cursor-not-allowed"
                  : "bg-blue-600 text-white hover:bg-blue-700 active:scale-95 hover:shadow-blue-200"
              )}
            >
            {isSimulating ? (
              <Activity className="animate-spin" size={18} />
            ) : (
              <Play size={18} fill="currentColor" />
            )}
            {isSimulating ? "Analyzing..." : onGate ? "Run Analysis" : "Run Steady-State"}
          </button>
              );
            })()}
          </div>
        </div>
      </header>

      {simError && (
        <div className="mx-6 mt-4 px-4 py-3 rounded-lg bg-red-50 border border-red-200">
          <p className="text-sm font-bold text-red-700">
            This system cannot be simulated as entered — the run was refused.
          </p>
          <p className="text-xs text-red-600 mt-1 leading-snug">{simError}{unitChoice.system === 'us' ? ' (SI units)' : ''}</p>
          <p className="text-[11px] text-red-400 mt-2 leading-snug">
            The chart below still shows your previous run, not this one.
          </p>
        </div>
      )}

      {view === 'input' && (
      <main className="max-w-screen-2xl mx-auto px-4 py-8 flex gap-8">
        {/* Sidebar - Inputs */}
        {showInputs && (
          <div className="w-80 flex-shrink-0 space-y-6">
            {/* CSV Upload */}
          <section className="bg-white rounded-2xl p-6 shadow-sm border border-slate-200">
            <div className="flex items-center gap-2 mb-4 text-emerald-600">
              <FileUp size={20} />
              <h2 className="font-bold text-sm uppercase tracking-wider">Import Data</h2>
            </div>
            <div className="relative">
              <input
                type="file"
                accept=".csv"
                onChange={handleFileUpload}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
              />
              <div className="border-2 border-dashed border-slate-200 rounded-xl p-4 text-center hover:border-emerald-300 hover:bg-emerald-50 transition-all group">
                <FileUp size={24} className="mx-auto mb-2 text-slate-300 group-hover:text-emerald-500 transition-colors" />
                <p className="text-[10px] font-bold text-slate-400 group-hover:text-emerald-600 uppercase">Click to upload CSV</p>
                <p className="text-[8px] text-slate-300 mt-1 uppercase">x, y, diameter, wt, mat, C, Q...</p>
                <p className="text-[8px] text-slate-300 uppercase">CSV in metric (m, mm, m³/h)</p>
              </div>
            </div>
          </section>

          {/* Calculation Basis Info */}
          <section className="bg-white rounded-2xl p-6 shadow-sm border border-slate-200">
            <div className="flex items-center gap-2 mb-3 text-slate-600">
              <Info size={18} />
              <h2 className="font-bold text-xs uppercase tracking-wider">Hydraulic Models</h2>
            </div>
            <div className="space-y-3">
              <div>
                <p className="text-[10px] font-bold text-slate-400 uppercase mb-1">Celerity (a)</p>
                <p className="text-[10px] text-slate-500 leading-relaxed italic">
                  Elastic wave theory: <br/> 
                  a = 1483 / √(1 + (K/E)·(D/e))
                </p>
              </div>
              <div className="pt-2 border-t border-slate-100">
                <p className="text-[10px] font-bold text-slate-400 uppercase mb-1">Friction (f)</p>
                <p className="text-[10px] text-slate-500 leading-relaxed italic">
                  Hazen-Williams conversion: <br/>
                  f = 134.2 / (v⁰.¹⁴⁸·C¹·⁸⁵²·D⁰·¹⁶⁶)
                </p>
              </div>
            </div>
          </section>

          {/* Pipe Sections */}
          <section className="bg-white rounded-2xl p-6 shadow-sm border border-slate-200">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2 text-blue-600">
                <Settings2 size={20} />
                <h2 className="font-bold">Pipe Network</h2>
              </div>
              <button
                onClick={handleAddPipe}
                className="p-1.5 bg-blue-50 text-blue-600 rounded-lg hover:bg-blue-100 transition-colors"
                title="Add Pipe Section"
              >
                <Plus size={18} />
              </button>
            </div>
            
              {/* Node 0 — the source, and the profile's first point. A node like any other, so
                the user provides it (user, 2026-09-12). It is the pump's check valve on a
                pumped main and the supply point on a gravity one; either way it is X = 0, and
                its elevation is the Y there. Shown above the reaches because that is where it
                is on the line. */}
            <div className="mb-4 p-3 bg-slate-50 rounded-xl border border-slate-200">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-bold text-slate-600 uppercase tracking-wider">
                    Node 0 — Source
                  </div>
                  <div className="text-[10px] text-slate-400 leading-snug mt-0.5">
                    {scenario === 'gravity-valve' ? 'Supply point' : 'Pump check valve'}, at X = 0
                  </div>
                </div>
                <div className="space-y-1 w-32 shrink-0">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    Elevation ({uu.length})
                  </label>
                  <UnitInput qty="length" unit={uu.length} step="0.01"
                    value={String(sourceElevation)}
                    onValue={v => setSourceElevation(Number(v))}
                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                  />
                </div>
              </div>
            </div>

            <div className="space-y-4 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
              <AnimatePresence initial={false}>
                {pipes.map((pipe, index) => (
                  <motion.div
                    key={pipe.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className="p-4 bg-slate-50 rounded-xl border border-slate-200 relative group"
                  >
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-xs font-black text-slate-400 uppercase tracking-widest">Section {index + 1}</span>
                      <button
                        onClick={() => handleRemovePipe(pipe.id)}
                        className="text-slate-300 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase">Length ({uu.length})</label>
                        <UnitInput qty="length" unit={uu.length} step="0.01"
                          value={String(pipe.length)}
                          onValue={v => handleUpdatePipe(pipe.id, { length: Number(v) })}
                          className="w-full px-2 py-1.5 bg-white border border-slate-200 rounded-md text-sm outline-none focus:border-blue-500"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase">Diameter ({uu.diameter})</label>
                        <UnitInput qty="diameter" unit={uu.diameter} step="0.001"
                          value={String(pipe.diameter)}
                          onValue={v => handleUpdatePipe(pipe.id, { diameter: Number(v) })}
                          className="w-full px-2 py-1.5 bg-white border border-slate-200 rounded-md text-sm outline-none focus:border-blue-500"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase">Wave Speed ({uu.velocity})</label>
                        <UnitInput qty="velocity" unit={uu.velocity} step="0.1"
                          value={String(pipe.waveSpeed)}
                          onValue={v => handleUpdatePipe(pipe.id, { waveSpeed: Number(v) })}
                          className="w-full px-2 py-1.5 bg-white border border-slate-200 rounded-md text-sm outline-none focus:border-blue-500"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase">Friction (f)</label>
                        <UnitInput step="0.0001"
                          value={String(pipe.frictionFactor)}
                          onValue={v => handleUpdatePipe(pipe.id, { frictionFactor: Number(Number(v).toFixed(4)) })}
                          className="w-full px-2 py-1.5 bg-white border border-slate-200 rounded-md text-sm outline-none focus:border-blue-500"
                        />
                      </div>
                      <div className="space-y-1 col-span-2">
                        <label className="text-[10px] font-bold text-slate-400 uppercase">End Elevation ({uu.length})</label>
                        <UnitInput qty="length" unit={uu.length} step="0.01"
                          value={String(pipe.endElevation)}
                          onValue={v => handleUpdatePipe(pipe.id, { endElevation: Number(v) })}
                          className="w-full px-2 py-1.5 bg-white border border-slate-200 rounded-md text-sm outline-none focus:border-blue-500"
                        />
                      </div>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </section>

          {/* Scenario Selector — Step 3.7 (S58) */}
          <section className="bg-white rounded-2xl p-5 shadow-sm border border-slate-200">
            <div className="flex items-center gap-2 mb-4 text-blue-600">
              <Settings2 size={18} />
              <h2 className="font-bold text-sm uppercase tracking-wider">Scenario</h2>
            </div>
            <div className="space-y-3">
              {/* Ruling R1: two-way radio + `Source` sub-choice on Valve-Operation. The state is
                  (operation, valveSource); scenarioFromControl is the one mapping to a Scenario. */}
              <div role="radiogroup" aria-label="Scenario type" className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
                {([['pump-operation', 'Pump-Operation'], ['valve-operation', 'Valve-Operation']] as [Operation, string][]).map(([v, label]) => (
                  <label key={v} className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="scenario-operation" value={v} checked={operation === v}
                      onChange={() => setOperation(v)} className="accent-blue-600" />
                    <span className={operation === v ? 'font-semibold text-slate-800' : 'text-slate-600'}>{label}</span>
                  </label>
                ))}
              </div>
              {operation === 'valve-operation' && (
                <div role="radiogroup" aria-label="Valve source" className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm pl-1">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Source:</span>
                  {([['pump', 'Pump'], ['reservoir', 'Reservoir']] as [ValveSource, string][]).map(([v, label]) => (
                    <label key={v} className="flex items-center gap-2 cursor-pointer">
                      <input type="radio" name="scenario-valve-source" value={v} checked={valveSource === v}
                        onChange={() => setValveSource(v)} className="accent-blue-600" />
                      <span className={valveSource === v ? 'font-semibold text-slate-800' : 'text-slate-600'}>{label}</span>
                    </label>
                  ))}
                </div>
              )}
              {scenario !== 'pump-trip' && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{`Valve ${uu.valve} (${valveBasis(uu.valve)})`}</label>
                      <UnitInput qty="valve" unit={uu.valve} step="0.1" value={String(valveKv0)}
                        onValue={v => setValveKv0(Number(v))}
                        className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Closure Start (s)</label>
                      <UnitInput step="0.1" value={String(valveT0)}
                        onValue={v => setValveT0(Number(v))}
                        className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Closure Time (s)</label>
                      <UnitInput step="0.1" value={String(valveTClose)}
                        onValue={v => setValveTClose(Number(v))}
                        className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Closure Exponent</label>
                      <UnitInput step="1" min="1" value={String(valveExponent)}
                        onValue={v => setValveExponent(Number(v))}
                        className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all" />
                    </div>
                  </div>
                  <p className="text-[10px] text-slate-400">
                    Valve scenarios ignore the pump Trip/Halt times — the valve closure is the
                    only transient event. The gravity-fed scenario ignores the whole Pump &amp;
                    Trip panel (the reservoir replaces the pump). Both ends of the system are
                    entered in the Boundary Conditions panel.
                  </p>
                </>
              )}
            </div>
          </section>

          {/* Q15: user preferences — the approved device package */}
          <section className="bg-white rounded-2xl p-5 shadow-sm border border-slate-200">
            <div className="flex items-center gap-2 mb-3 text-blue-600">
              <Settings2 size={18} />
              <h2 className="font-bold text-sm uppercase tracking-wider">Preferences</h2>
            </div>
            {/* Q26: units choice. System sets length, diameter, speed, volume, valve coefficient; pressure and flow
                are chosen inside the system. Changing the system resets them to its defaults. */}
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">Units</p>
            <div className="grid grid-cols-3 gap-2 mb-4">
              {([
                ['Unit system', unitChoice.system, [['metric', 'Metric'], ['us', 'US']], (v: string) => {
                  const s = v as UnitSystem;
                  setUnitChoice({ system: s, pressure: CHOICES[s].pressure[0], flow: CHOICES[s].flow[0] });
                }],
                ['Pressure unit', unitChoice.pressure, CHOICES[unitChoice.system].pressure.map(u => [u, isHeadUnit(u) ? u + ' (water)' : u]),
                  (v: string) => setUnitChoice({ ...unitChoice, pressure: v })],
                ['Flow unit', unitChoice.flow, CHOICES[unitChoice.system].flow.map(u => [u, u]),
                  (v: string) => setUnitChoice({ ...unitChoice, flow: v })],
              ] as [string, string, string[][], (v: string) => void][]).map(([name, val, opts, set]) => (
                <select key={name} aria-label={name} title={name} value={val} onChange={e => set(e.target.value)}
                  className="w-full px-1 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-700 outline-none">
                  {opts.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                </select>
              ))}
            </div>
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">Device package</p>
            <label className="flex items-center gap-2 cursor-pointer text-sm text-slate-700">
              <input type="checkbox" checked={avApproved} onChange={e => approveAirValves(e.target.checked)}
                className="accent-blue-600" />
              Air valves
            </label>
            {([['QPRV (quick pressure relief valve)', qprvApproved, approveQprv],
               ['SAV (surge anticipating valve)', savApproved, approveSav]] as const).map(([name, on, set]) => (
              <label key={name} className="flex items-center gap-2 cursor-pointer text-sm text-slate-700">
                <input type="checkbox" checked={on} onChange={e => set(e.target.checked)} className="accent-blue-600" />
                {name}
              </label>
            ))}
          </section>

          {/* Boundary Conditions (Row 3.11 Unit C, D-4 — S68) ─────────────────────────────
              REPLACES the "Downstream Reservoir / Water Level Elevation" panel, which was
              drawn on EVERY scenario but read only by a pump trip. On a valve run it sat
              there, editable and inert, with the only warning a line of grey text at the
              bottom of a different panel — and a boundary typed into it went nowhere. That
              is the S64 blocker's actual surface, and removing the box is the fix.

              Both ends now live here, both are gauge pressures, and each is shown only on
              the scenarios that read it. Nothing on this screen is editable and ignored. */}
          <section className="bg-white rounded-2xl p-6 shadow-sm border border-slate-200">
            <div className="flex items-center gap-2 mb-4 text-blue-600">
              <Droplets size={20} />
              <h2 className="font-bold">Boundary Conditions</h2>
            </div>
            <div className="space-y-4">
              {scenario === 'gravity-valve' && (
                <>
                  <div className="space-y-1">
                    <label className="text-xs font-bold text-slate-500 uppercase">Pressure at X = 0 ({uu.pressure})</label>
                    <UnitInput qty="pressure" unit={uu.pressure} step="0.01"
                      value={String(inletPressure)}
                      onValue={v => setInletPressure(Number(v))}
                      className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                    />
                  </div>
                </>
              )}
              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-500 uppercase">
                  Pressure at {scenario === 'pump-trip' ? 'System Outlet' : "Valve's Outlet"} ({uu.pressure})
                </label>
                <UnitInput qty="pressure" unit={uu.pressure} step="0.01"
                  value={String(outletPressure)}
                  onValue={v => setOutletPressure(Number(v))}
                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                />
              </div>
              <p className="text-[10px] text-slate-400 leading-snug">
                Pressures are gauge ({isHeadUnit(uu.pressure) ? `${uu.pressure} of water column` : uu.pressure}) — 0 discharges to open air. Each
                is the pressure <em>at</em> its point; the height above sea level is taken from
                the pipe profile automatically and added for you.
              </p>
            </div>
          </section>

          {/* Pump Config Left Pane now moving to sidebar */}
          {scenario !== 'gravity-valve' && (
          <section className="bg-white rounded-2xl p-5 shadow-sm border border-slate-200">
            <div className="flex items-center gap-2 mb-5 text-blue-600">
              <Zap size={18} />
              <h2 className="font-bold text-sm uppercase tracking-wider">{scenario === 'pump-trip' ? 'Pump & Trip' : 'Pump'}</h2>
            </div>
            
            <div className="space-y-4">
              {scenario === 'pump-valve' && (
              <>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Suction Pressure ({uu.pressure})</label>
                  <UnitInput qty="pressure" unit={uu.pressure} step="0.1"
                    value={suctionText}
                    onValue={setSuctionText}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Pump Curve</label>
                  <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    <span>Flow ({uu.flow})</span><span>Head ({uu.length})</span><span className="w-6" />
                    {curveRows.map((r, i) => (
                      <React.Fragment key={i}>
                        <UnitInput qty="flow" unit={uu.flow} step="0.001" value={r.Q}
                          onValue={v => setCurveCell(i, 'Q', v)}
                          className="w-full px-2 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-sm font-normal text-slate-800 focus:ring-2 focus:ring-blue-500 outline-none" />
                        <UnitInput qty="length" unit={uu.length} step="0.1" value={r.H}
                          onValue={v => setCurveCell(i, 'H', v)}
                          className="w-full px-2 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-sm font-normal text-slate-800 focus:ring-2 focus:ring-blue-500 outline-none" />
                        <button type="button" aria-label="Remove point" title="Remove point"
                          onClick={() => setCurveRows(curveRows.filter((_, j) => j !== i))}
                          className="w-6 h-6 flex items-center justify-center text-slate-400 hover:text-red-500">×</button>
                      </React.Fragment>
                    ))}
                  </div>
                  <button type="button" onClick={() => setCurveRows([...curveRows, { Q: '', H: '' }])}
                    className="text-xs font-semibold text-blue-600 hover:text-blue-700">+ Add point</button>
                </div>
              </>
              )}
              <div className="grid grid-cols-2 gap-3">
                {scenario === 'pump-trip' && (
                <div className="space-y-1.5">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Initial Flow ({uu.flow})</label>
                  <UnitInput qty="flow" unit={uu.flow} step="0.0001"
                    value={String(pump.initialFlow)}
                    onValue={v => setPump({ ...pump, initialFlow: Number(v) })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                  />
                </div>
                )}
                {scenario === 'pump-trip' && (
                <div className="space-y-1.5">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Trip Time (s)</label>
                  <UnitInput step="0.01"
                    value={String(pump.tripTime)}
                    onValue={v => setPump({ ...pump, tripTime: Number(v) })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                  />
                </div>
                )}
              </div>
              {scenario === 'pump-trip' && (
              <div className="space-y-1.5">
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Halt Time (s)</label>
                <UnitInput step="0.01"
                  value={String(pump.haltTime)}
                  onValue={v => setPump({ ...pump, haltTime: Number(v) })}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                />
              </div>
              )}
              {/* "Pump Elevation" was here. It IS node 0's elevation — the pump sits at X = 0 —
                  and so was the gravity panel's "Elevation at X = 0". Both are now the one
                  Source Node field in the Pipe Network panel, where profile data belongs. */}
            </div>
          </section>
          )}
        </div>
        )}

        {/* Main Content - Results */}
        <div className="flex-1 min-w-0 space-y-8">
              {!results ? (
                <div className="h-full min-h-[600px] flex flex-col items-center justify-center text-center p-12 bg-white rounded-3xl border-2 border-dashed border-slate-200">
                  <div className="w-20 h-20 bg-blue-50 rounded-full flex items-center justify-center text-blue-500 mb-6">
                    <Info size={40} />
                  </div>
                  <h3 className="text-xl font-bold mb-2">Ready to Analyze</h3>
                  <p className="text-slate-500 max-w-md mx-auto mb-8">
                    Configure your pump, pipe sections, and reservoir parameters, then run the simulation to see the transient pressure response.
                  </p>
                  <div className="flex items-center gap-8 text-sm font-medium text-slate-400">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-blue-500" />
                      {scenario === 'pump-trip'
                        ? `Pump Trip @ ${pump.tripTime}s`
                        : `Valve Closure Start @ ${valveT0}s`}
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-green-500" />
                      MOC Solver
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-orange-500" />
                      Pressure Envelopes
                    </div>
                  </div>
                </div>
              ) : (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="space-y-8"
                >
                  {/* Q15: stage-1 results = Unprotected System; results with devices = Protected System */}
                  <div className="flex items-center gap-3">
                    <h2 className="text-xl font-black text-slate-900 mr-auto">{protectedShown ? 'Protected System' : 'Unprotected System'}</h2>
                    {/* Q24: large screen only */}
                    <button onClick={() => { setIsAnimating(false); setShowReport(true); }}
                      disabled={reportKey !== runKey()}
                      title={reportKey !== runKey() ? 'Inputs changed since the last run: run the analysis again to print.' : undefined}
                      className="hidden lg:inline-flex px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed">
                      Print / Save as PDF
                    </button>
                  </div>

                  {/* Summary Cards */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-200 flex items-center gap-4">
                      <div className="w-10 h-10 bg-red-50 rounded-xl flex items-center justify-center text-red-600">
                        <TrendingUp size={20} />
                      </div>
                      <div>
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Max Head</p>
                        <p className="text-xl font-black text-slate-900">
                          {fmt('length', uu.length, Math.max(...shownNodes.map(n => n.maxHead)))} <span className="text-xs font-normal text-slate-500">{uu.length}</span>
                        </p>
                      </div>
                    </div>
                    <div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-200 flex items-center gap-4">
                      <div className="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center text-blue-600">
                        <TrendingDown size={20} />
                      </div>
                      <div>
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Min Head</p>
                        <p className="text-xl font-black text-slate-900">
                          {fmt('length', uu.length, Math.min(...shownNodes.map(n => n.minHead)))} <span className="text-xs font-normal text-slate-500">{uu.length}</span>
                        </p>
                      </div>
                    </div>
                    <div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-200 flex items-center gap-4">
                      <div className="w-10 h-10 bg-orange-50 rounded-xl flex items-center justify-center text-orange-600">
                        <Droplets size={20} />
                      </div>
                      <div>
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Max Vapor / Air</p>
                        <p className="text-xl font-black text-slate-900">
                          {fmt('volume', uu.volume, Math.max(...shownNodes.map(n => n.maxVaporVolume)))} <span className="text-xs font-normal text-slate-500">{uu.volume}</span>
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Q14/Q15: air valves (solver stage 2), only when approved in the preferences */}
                  {avApproved && (
                  <section data-q14="air-valves" className="bg-white p-6 rounded-3xl shadow-sm border border-slate-200">
                    <div className="flex items-center gap-3 flex-wrap">
                      <h3 className="text-lg font-bold mr-auto">Air Valves</h3>
                      {avStudy && ([[avStudy.stage1, 'Unprotected System'],
                                    [avStudy.stage2, 'Protected System']] as const).map(([r, label]) => (
                        <button key={label} onClick={() => { setIsAnimating(false); setResults(r); }}
                          className={cn("px-3 py-1.5 rounded-lg text-xs font-semibold border",
                            results === r ? "bg-slate-800 text-white border-slate-800" : "bg-white text-slate-600 border-slate-200")}>
                          {label}
                        </button>
                      ))}
                      <button onClick={handleSizeAirValves} disabled={isSimulating}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
                        Size air valves
                      </button>
                    </div>
                    {protectedShown && (
                      <div className="mt-4 text-xs">
                        {avInSet ? <p className="text-slate-500">Listed in the "{avInSet.name}" parts list below.</p> : avStudy.valves.length === 0 ? (avStudy.unresolved.length === 0 &&
                          <p className="text-slate-500">No air valves needed.</p>
                        ) : (
                          <table className="w-full text-left">
                            <thead className="text-slate-400 uppercase text-[10px]">
                              <tr><th className="py-1">Type</th><th>Location ({uu.length})</th><th>Size ({uu.diameter})</th><th>Inlet / outlet ({uu.diameter})</th><th>Non-Slam</th></tr>
                            </thead>
                            <tbody>
                              {avStudy.valves.map(v => (
                                <tr key={v.x} className="border-t border-slate-100">
                                  <td className="py-1">{v.nonSlam ? 'Non-Slam air valve' : 'Air valve'}</td>
                                  <td>{fmt('length', uu.length, v.x, 0)}</td><td>{inUnit(v.inlet_mm)}</td>
                                  <td>{inUnit(v.inlet_mm)} / {inUnit(shownOutletMm(v))}</td>
                                  <td>{v.nonSlam ? 'Yes' : 'No'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                        {avStudy.unresolved.length > 0 && (
                          <p className="mt-2 text-amber-700">Target not met (valve {fmt('pressure', uu.pressure, MIN_GAUGE_HEAD_M)} {uu.pressure}, line {fmt('pressure', uu.pressure, ADD_VALVE_HEAD_M)} {uu.pressure}) at x ={avStudy.unresolved.map(x => fmt('length', uu.length, x, 0)).join(', ')} {uu.length}.</p>
                        )}
                      </div>
                    )}
                  </section>
                  )}

                  {/* Q21: QPRV sizing (valve-closure scenarios) */}
                  {qprvApproved && scenario !== 'pump-trip' && (
                  <section data-q21="qprv" className="bg-white p-6 rounded-3xl shadow-sm border border-slate-200">
                    <div className="flex items-center gap-3 flex-wrap">
                      <h3 className="text-lg font-bold mr-auto">QPRV</h3>
                      <button onClick={handleSizeQprv} disabled={isSimulating}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
                        Size QPRV
                      </button>
                    </div>
                    {qpStudy && (
                      <p className="mt-4 text-xs text-slate-700">
                        Size {inUnit(qpStudy.qprv.size_mm)} {uu.diameter}, {uu.valve} {fmt('valve', uu.valve, qpStudy.qprv.Kv)}, closing time {Math.round(qpStudy.qprv.closingTime * 10) / 10} s,
                        max head {fmt('length', uu.length, qpStudy.maxHead)} {uu.length} (Unprotected {fmt('length', uu.length, peakAll(qpStudy.stage1))} {uu.length});
                        {' '}{qpStudy.tried.length} runs.
                        {qpStudy.notes.map(n => <span key={n} className="text-amber-700"> {n}.</span>)}
                      </p>
                    )}
                  </section>
                  )}

                  {/* Q22: SAV sizing (pump trip) */}
                  {savApproved && scenario === 'pump-trip' && (
                  <section data-q22="sav" className="bg-white p-6 rounded-3xl shadow-sm border border-slate-200">
                    <div className="flex items-center gap-3 flex-wrap">
                      <h3 className="text-lg font-bold mr-auto">SAV</h3>
                      <button onClick={handleSizeSav} disabled={isSimulating || !avStudy}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
                        Size SAV
                      </button>
                    </div>
                    {!avStudy && <p className="mt-4 text-xs text-slate-500">Size the air valves first.</p>}
                    {svStudy && (
                      <p className="mt-4 text-xs text-slate-700">
                        Size {inUnit(svStudy.sav.size_mm)} {uu.diameter}, {uu.valve} {fmt('valve', uu.valve, svStudy.sav.Kv)}, closing time {svStudy.sav.closingTime} s,
                        low / high set {fmt('pressure', uu.pressure, svStudy.lowSet)} / {fmt('pressure', uu.pressure, svStudy.highSet)} {uu.pressure},
                        max head {fmt('length', uu.length, svStudy.maxHead)} {uu.length} (without SAV {fmt('length', uu.length, peakAll(svStudy.stage1))} {uu.length});
                        {' '}{svStudy.tried.length} runs.
                        {svStudy.notes.map(n => <span key={n} className="text-amber-700"> {n}{n === SAV_NOTE_EAS && svStudy.sav.holdOpenUntil !== undefined && ` (held open until ${svStudy.sav.holdOpenUntil.toFixed(1)} s)`}.</span>)}
                      </p>
                    )}
                  </section>
                  )}

                  {/* Q23: Protected System, one unit per solution set (devices, envelope, parts list) */}
                  {sets.length > 0 && (
                  <section data-q23="sets" className="bg-white p-6 rounded-3xl shadow-sm border border-slate-200 text-xs">
                    {/* one "Protected System" heading: the top one when it already says so */}
                    <h3 className="text-lg font-bold">{protectedShown ? 'Solution sets' : 'Protected System'}</h3>
                    {sets.map(s => <React.Fragment key={s.name}><SetView set={s} scenario={scenario} axis={yAxisShown} u={uu} /></React.Fragment>)}
                  </section>
                  )}

                  {/* Pressure Envelope & Animation */}
                  <section className="bg-white p-6 rounded-3xl shadow-sm border border-slate-200 relative overflow-hidden">
                    <div className="flex justify-between items-start mb-6">
                      <div>
                        <h3 className="text-lg font-bold">Pressure Envelope</h3>
                        <p className="text-sm text-slate-500">HGL profile along the pipeline</p>
                      </div>
                    </div>

                    <div className="flex gap-6">
                      {/* Playback Controls Column */}
                      {results && (
                        <div className="flex flex-col items-center gap-4 pt-2">
                          {/* Timer above buttons - small and technical */}
                          <div className="text-center mb-1">
                            <p className="text-[8px] font-bold text-slate-400 uppercase tracking-tighter">Time</p>
                            <p className="text-xs font-mono font-bold text-blue-600">
                              {animTime.toFixed(2)}
                            </p>
                          </div>

                          <div className="flex flex-col gap-2">
                            <button
                              onClick={() => {
                                const fh = results.fullHistory;
                                const next = Math.min(fh.length - 1, currentFrame + 5);
                                setAnimTime(fh[next].time);
                                setIsAnimating(false);
                              }}
                              className="p-2.5 bg-white rounded-xl hover:bg-blue-50 text-slate-600 border border-slate-200 hover:border-blue-200 hover:text-blue-600 transition-all shadow-sm group"
                              title="Step Forward"
                            >
                              <SkipForward size={18} fill="currentColor" className="group-hover:scale-110 transition-transform" />
                            </button>
                            <button
                              onClick={() => {
                                const fh = results.fullHistory;
                                const prev = Math.max(0, currentFrame - 5);
                                setAnimTime(fh[prev].time);
                                setIsAnimating(false);
                              }}
                              className="p-2.5 bg-white rounded-xl hover:bg-blue-50 text-slate-600 border border-slate-200 hover:border-blue-200 hover:text-blue-600 transition-all shadow-sm group"
                              title="Step Backward"
                            >
                              <SkipBack size={18} fill="currentColor" className="group-hover:scale-110 transition-transform" />
                            </button>
                          </div>

                          <div className="h-px w-8 bg-slate-100" />

                          <button
                            onClick={() => {
                              // If at end, rewind before playing
                              if (animTime >= simTMax) setAnimTime(0);
                              setIsAnimating(!isAnimating);
                            }}
                            className={cn(
                              "w-12 h-12 rounded-full flex items-center justify-center transition-all shadow-lg active:scale-95",
                              isAnimating
                                ? "bg-amber-500 text-white hover:bg-amber-600 shadow-amber-100"
                                : "bg-blue-600 text-white hover:bg-blue-700 shadow-blue-100"
                            )}
                          >
                            {isAnimating ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" className="ml-1" />}
                          </button>

                          <button
                            onClick={() => { setIsAnimating(false); setAnimTime(0); }}
                            className="p-2 text-slate-300 hover:text-slate-500 transition-colors"
                            title="Reset"
                          >
                            <Square size={14} fill="currentColor" />
                          </button>
                        </div>
                      )}

                      <div className="h-[400px] flex-1 min-w-0 overflow-hidden">
                        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                          <LineChart data={animatedChartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                            <XAxis 
                              dataKey="x" 
                              label={{ value: `Distance (${uu.length})`, position: 'insideBottom', offset: -10, fontSize: 11, fontWeight: 600 }}
                              tick={{ fontSize: 10 }}
                              tickFormatter={(val) => Math.round(val).toString()}
                            />
                            <YAxis 
                              label={{ value: `Head (${uu.length})`, angle: -90, position: 'insideLeft', fontSize: 11, fontWeight: 600 }}
                              tick={{ fontSize: 10 }}
                              tickFormatter={yAxisShown ? yAxisShown.tick : (val) => Math.round(val).toString()}
                              domain={yAxisShown?.domain ?? ['auto', 'auto']} ticks={yAxisShown?.ticks}
                            />
                            <Tooltip
                              contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }}
                              labelFormatter={envelopeLabelFormatter}
                              formatter={envelopeTooltipFormatter}
                            />
                            <Legend
                              verticalAlign="bottom" 
                              align="center" 
                              iconType="circle" 
                              wrapperStyle={{ paddingTop: '20px', fontSize: '10px' }} 
                            />
                            <Line name="Max Head" type="linear" dataKey="maxHead" stroke="#ef4444" strokeWidth={1} dot={false} strokeDasharray="5 5" isAnimationActive={false} />
                            <Line name="Min Head" type="linear" dataKey="minHead" stroke="#3b82f6" strokeWidth={1} dot={false} strokeDasharray="5 5" isAnimationActive={false} />
                            <Line name="Steady-State" type="linear" dataKey="steadyHead" stroke="#94a3b8" strokeWidth={1} dot={false} strokeDasharray="3 3" isAnimationActive={false} />
                            <Line name="Pipeline" type="linear" dataKey="elevation" stroke="#059669" strokeWidth={2} dot={false} isAnimationActive={false} />
                            <Line name="Current HGL" type="linear" dataKey="currentHead" stroke="#2563eb" strokeWidth={2.5} dot={{ r: 2 }} isAnimationActive={false} />
                            {results && results.nodes.length > 1 && (
                              <ProfileIcons pts={results.nodes.map(n => ({ x: L(n.x), z: L(n.elevation) }))}
                                icons={profileIcons(scenario, L(results.nodes[results.nodes.length - 1].x),
                                  protectedShown ? avStudy.valves.map(v => ({ ...v, x: L(v.x) })) : [],
                                  surgeIcons.map(d => ({ kind: d.kind, x: L(d.x) })),
                                  (L(results.nodes[1].x) - L(results.nodes[0].x)) / 2)} />
                            )}
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    </div>

                    {/* Progress Bar */}
                    <div className="mt-6 relative h-1.5 bg-slate-100 rounded-full overflow-hidden cursor-pointer group"
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        const x = e.clientX - rect.left;
                        const percent = Math.max(0, Math.min(1, x / rect.width));
                        setAnimTime(percent * simTMax);
                        setIsAnimating(false);
                      }}
                    >
                      <div
                        className="absolute top-0 left-0 h-full bg-blue-600"
                        style={{ width: `${simTMax > 0 ? (animTime / simTMax) * 100 : 0}%` }}
                      />
                    </div>
                  </section>
                  
                  {/* Reorganized Charts with Tabs */}
                  <div className="bg-white rounded-3xl shadow-sm border border-slate-200 overflow-hidden">
                    <div className="flex border-b border-slate-200 items-center">
                      <div className="flex overflow-x-auto custom-scrollbar">
                        <button
                          onClick={() => setActiveTab('pressure')}
                          className={cn("px-6 py-4 font-bold text-sm transition-colors border-b-2 whitespace-nowrap outline-none", activeTab === 'pressure' ? "text-blue-600 border-blue-600 bg-blue-50/50" : "text-slate-500 border-transparent hover:text-slate-700 hover:bg-slate-50")}
                        >
                          Transient Pressure
                        </button>
                        <button
                          onClick={() => setActiveTab('vapor')}
                          className={cn("px-6 py-4 font-bold text-sm transition-colors border-b-2 whitespace-nowrap outline-none", activeTab === 'vapor' ? "text-blue-600 border-blue-600 bg-blue-50/50" : "text-slate-500 border-transparent hover:text-slate-700 hover:bg-slate-50")}
                        >
                          Vapor Volume
                        </button>
                        <button
                          onClick={() => setActiveTab('flow')}
                          className={cn("px-6 py-4 font-bold text-sm transition-colors border-b-2 whitespace-nowrap outline-none", activeTab === 'flow' ? "text-blue-600 border-blue-600 bg-blue-50/50" : "text-slate-500 border-transparent hover:text-slate-700 hover:bg-slate-50")}
                        >
                          Flow Rate
                        </button>
                      </div>

                      <div className="ml-auto flex items-center gap-3 pr-4">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Node</label>
                        <select
                          value={selectedNodeIdx}
                          onChange={e => setSelectedNodeIdx(Number(e.target.value))}
                          className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-md text-xs font-semibold text-slate-700 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                        >
                          {selectableNodes.map(n => (
                            <option key={n.idx} value={n.idx}>{n.label}</option>
                          ))}
                        </select>
                        <div className="flex items-center gap-1 border border-slate-200 rounded-md overflow-hidden">
                          <button
                            onClick={() => setTabZoomLevel(z => z + 1)}
                            disabled={effectiveTabTMax <= 0.2}
                            title="Zoom In (shrink x-range by 20%)"
                            className="p-1.5 bg-white hover:bg-blue-50 text-slate-600 hover:text-blue-600 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                          >
                            <ZoomIn size={14} />
                          </button>
                          <button
                            onClick={() => setTabZoomLevel(z => Math.max(0, z - 1))}
                            disabled={tabZoomLevel === 0}
                            title="Zoom Out"
                            className="p-1.5 bg-white hover:bg-blue-50 text-slate-600 hover:text-blue-600 transition-colors border-l border-slate-200 disabled:opacity-30 disabled:cursor-not-allowed"
                          >
                            <ZoomOut size={14} />
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="p-6">
                      {activeTab === 'pressure' && (
                        <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                          <div className="mb-6">
                            <h3 className="text-base font-bold text-blue-600">Transient Pressure</h3>
                            <p className="text-xs text-slate-500">P vs time at {selectableNodes.find(n => n.idx === selectedNodeIdx)?.label ?? 'selected node'}</p>
                          </div>
                          <div className="h-[300px] w-full">
                            <ResponsiveContainer width="100%" height="100%">
                              <LineChart data={zoomedTabData} margin={{ top: 5, right: 20, left: 0, bottom: 0 }}>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                                <XAxis
                                  dataKey="time"
                                  type="number"
                                  domain={[0, effectiveTabTMax]}
                                  allowDataOverflow
                                  tick={{ fontSize: 10 }}
                                  tickFormatter={(val) => Math.round(val).toString()}
                                />
                                <YAxis tick={{ fontSize: 10 }} tickFormatter={tabYDomain.pressure?.tick} domain={tabYDomain.pressure?.domain ?? ['auto', 'auto']} ticks={tabYDomain.pressure?.ticks} />
                                <Tooltip
                                  contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }}
                                  labelFormatter={(l: any) => `Time: ${Number(l).toFixed(2)} s`}
                                  formatter={(v: any) => [fmt('pressure', uu.pressure, toCalc('pressure', uu.pressure, Number(v))) + ' ' + uu.pressure, 'Pressure']}
                                />
                                <Line type="linear" dataKey="pressure" stroke="#2563eb" strokeWidth={2} dot={false} isAnimationActive={false} />
                              </LineChart>
                            </ResponsiveContainer>
                          </div>
                        </div>
                      )}

                      {activeTab === 'vapor' && (
                        <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                          <div className="mb-6">
                            <h3 className="text-base font-bold text-orange-600">Vapor Volume</h3>
                            <p className="text-xs text-slate-500">Cavity volume at {selectableNodes.find(n => n.idx === selectedNodeIdx)?.label ?? 'selected node'} ({uu.volume === 'L' ? 'Liters' : 'US gallons'})</p>
                          </div>
                          <div className="h-[300px] w-full">
                            <ResponsiveContainer width="100%" height="100%">
                              <AreaChart data={zoomedTabData} margin={{ top: 5, right: 20, left: 0, bottom: 0 }}>
                                <defs>
                                  <linearGradient id="colorVapor" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="#f97316" stopOpacity={0.3}/>
                                    <stop offset="95%" stopColor="#f97316" stopOpacity={0}/>
                                  </linearGradient>
                                </defs>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                                <XAxis
                                  dataKey="time"
                                  type="number"
                                  domain={[0, effectiveTabTMax]}
                                  allowDataOverflow
                                  tick={{ fontSize: 10 }}
                                  tickFormatter={(val) => Math.round(val).toString()}
                                />
                                <YAxis tick={{ fontSize: 10 }} tickFormatter={(val) => Number(val.toPrecision(3)).toString()} />
                                <Tooltip
                                  contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }}
                                  labelFormatter={(l: any) => `Time: ${Number(l).toFixed(2)} s`}
                                  formatter={(v: any) => [fmt('volume', uu.volume, toCalc('volume', uu.volume, Number(v))) + ' ' + uu.volume, 'Vapor Volume']}
                                />
                                <Area type="linear" dataKey="vaporVolume" stroke="#f97316" fillOpacity={1} fill="url(#colorVapor)" strokeWidth={2} isAnimationActive={false} />
                              </AreaChart>
                            </ResponsiveContainer>
                          </div>
                        </div>
                      )}

                      {activeTab === 'flow' && (
                        <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                          <div className="mb-6">
                            <h3 className="text-base font-bold text-indigo-600">Flow Rate</h3>
                            <p className="text-xs text-slate-500">Q in downstream pipe of {selectableNodes.find(n => n.idx === selectedNodeIdx)?.label ?? 'selected node'}</p>
                          </div>
                          <div className="h-[300px] w-full">
                            <ResponsiveContainer width="100%" height="100%">
                              <LineChart data={zoomedTabData} margin={{ top: 5, right: 20, left: 0, bottom: 0 }}>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                                <XAxis
                                  dataKey="time"
                                  type="number"
                                  domain={[0, effectiveTabTMax]}
                                  allowDataOverflow
                                  tick={{ fontSize: 10 }}
                                  tickFormatter={(val) => Math.round(val).toString()}
                                />
                                <YAxis tick={{ fontSize: 10 }} tickFormatter={tabYDomain.flow?.tick} domain={tabYDomain.flow?.domain ?? ['auto', 'auto']} ticks={tabYDomain.flow?.ticks} />
                                <Tooltip
                                  contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }}
                                  labelFormatter={(l: any) => `Time: ${Number(l).toFixed(2)} s`}
                                  formatter={(v: any) => [fmt('flow', uu.flow, toCalc('flow', uu.flow, Number(v))) + ' ' + uu.flow, 'Flow']}
                                />
                                <Line type="linear" dataKey="flow" stroke="#6366f1" strokeWidth={2} dot={false} isAnimationActive={false} />
                              </LineChart>
                            </ResponsiveContainer>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </motion.div>
              )}
            </div>
      </main>
      )}

      {/* ── Screen 2 — the gate screen (Row 3.11 Unit C, D-5c) ──────────────────────────────
          Profile + HGL (no vapour line, Q12), the tooltip, the summary rail and the findings
          rail, all from `gateProfile` / `gateReport` through gate_screen.ts. Nothing here
          computes a head, a pressure, a margin, a velocity or a verdict. */}
      {view === 'gate' && gateReport && (() => {
        const mode = summaryMode(gateReport);
        const caveats = numberCaveats(gateReport);
        const s = gateSummary;
        // Q27: the chart's plotted values in the length unit; the tooltip reads the SI row it carries (p.row).
        const gateChartShown = gateChart.map(p => ({ ...p, distance: L(p.distance), elevation: L(p.elevation), head: L(p.head) }));
        // The ruled warnings (ANSWERS 2026-10-02 Q2), shown beside every place the numbers appear.
        const caveatBox = caveats.length > 0 && (
          <div data-caveats className="mb-3 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs font-bold text-amber-700 space-y-1">
            {caveats.map(c => <p key={c}>{c}</p>)}
          </div>
        );
        const fmtNode = (label: string, n: { head: number; pressure: number; distance: number }) => (
          <div className="flex justify-between gap-2"><span className="text-slate-500">{label}</span>
            <span className="font-mono">H {fmt('length', uu.length, n.head)} {uu.length} · p {fmt('pressure', uu.pressure, n.pressure)} {uu.pressure}</span></div>
        );
        return (
      <main data-screen="gate" className="max-w-screen-2xl mx-auto px-4 py-8 flex gap-6">
        <section className="flex-1 min-w-0 bg-white p-6 rounded-3xl shadow-sm border border-slate-200">
          <h3 className="text-lg font-bold">Steady-State Profile</h3>
          <p className="text-sm text-slate-500 mb-4">Pipeline and pressure line (HGL) — {SCENARIO_LABEL[scenario]}</p>
          {caveatBox}
          {gateProfile ? (
            <div className="h-[460px]">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <LineChart data={gateChartShown} margin={{ top: 10, right: 30, left: 0, bottom: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                  <XAxis dataKey="distance" type="number" domain={['dataMin', 'dataMax']}
                    label={{ value: `Distance (${uu.length})`, position: 'insideBottom', offset: -5, fontSize: 11, fontWeight: 600 }}
                    tick={{ fontSize: 10 }} tickFormatter={(v) => Math.round(v).toString()} />
                  <YAxis label={{ value: `Head (${uu.length})`, angle: -90, position: 'insideLeft', fontSize: 11, fontWeight: 600 }}
                    tick={{ fontSize: 10 }} tickFormatter={(v) => Math.round(v).toString()} domain={['auto', 'auto']} />
                  <Tooltip content={<GateTooltip caveats={caveats} u={uu} />} />
                  <Legend verticalAlign="top" align="right" iconType="plainline" wrapperStyle={{ fontSize: '10px' }} />
                  <Line name="Pipeline" type="linear" dataKey="elevation" stroke="#059669" strokeWidth={2} dot={false} isAnimationActive={false} />
                  <Line name="Pressure line (HGL)" type="linear" dataKey="head" stroke="#0d9488" strokeWidth={2} strokeDasharray="6 4" dot={false} isAnimationActive={false} />
                  {gateChartShown.length > 1 && (
                    <ProfileIcons pts={gateChartShown.map(p => ({ x: p.distance, z: p.elevation }))}
                      icons={profileIcons(scenario, gateChartShown[gateChartShown.length - 1].distance)} />
                  )}
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="text-sm text-slate-500">
              No steady state was computed.
            </p>
          )}
        </section>

        <aside className="w-[300px] shrink-0 space-y-4">
          <section data-rail="summary" className="bg-white p-4 rounded-2xl shadow-sm border border-slate-200 text-xs space-y-1.5">
            <h4 className="font-bold text-sm text-slate-700 mb-2">Steady State</h4>
            <div className="flex justify-between gap-2"><span className="text-slate-500">Scenario</span><span>{SCENARIO_LABEL[scenario]}</span></div>
            {mode === 'numbers' && s ? (
              <>
                {caveatBox}
                {gateReport.steady?.pump.curve && (
                  <div data-duty-point className="flex justify-between gap-2"><span className="text-slate-500">Duty point</span>
                    <span className="font-mono">{fmt('flow', uu.flow, gateReport.steady.pump.initialFlow)} {uu.flow} · {fmt('length', uu.length, gateReport.steady.init.prevState.H[0] - gateReport.steady.pump.curve.H_suct)} {uu.length}</span></div>
                )}
                <div className="flex justify-between gap-2"><span className="text-slate-500">Flow</span>
                  <span className="font-mono">{fmt('flow', uu.flow, s.flow)} {uu.flow}</span></div>
                <div className="flex justify-between gap-2"><span className="text-slate-500">Velocity</span>
                  <span className="font-mono">{s.velocityMin.reach === s.velocityMax.reach
                    ? `${fmt('velocity', uu.velocity, s.velocityMax.value)} ${uu.velocity}`
                    : `${fmt('velocity', uu.velocity, s.velocityMin.value)}–${fmt('velocity', uu.velocity, s.velocityMax.value)} ${uu.velocity}`}</span></div>
                {fmtNode('Inlet', s.inlet)}
                {fmtNode('Outlet', s.outlet)}
                <div className="flex justify-between gap-2"><span className="text-slate-500">Head loss along pipeline</span>
                  <span className="font-mono">{fmt('length', uu.length, s.headLossAlongPipeline)} {uu.length}</span></div>
              </>
            ) : (
              <p className="text-slate-500">No steady state was computed.</p>
            )}
          </section>

          <section data-rail="findings" className="bg-white p-4 rounded-2xl shadow-sm border border-slate-200 text-xs">
            <h4 className="font-bold text-sm text-slate-700 mb-2">System Check</h4>
            <GateMessageView report={gateReport} system={unitChoice.system} />
          </section>
        </aside>
      </main>
        );
      })()}

      {/* ── D-6: the gate modal (PLAN_S68.md §4-§5, MOCKUP_NOTES_S65.md §6-§7) ─────────────────
          Opened by every `Run Steady-State`: gate 1 on Screen 1 when the input phase blocks, gate
          2 on Screen 2 otherwise. Fail -> `Acknowledge & Return`, routed by `acknowledgeReturnTo`.
          Pass with notes -> waits for `Continue`; genuinely clean -> also closes itself after 3 s.
          It never runs anything: `Run Analysis` stays the only way to start the transient. */}
      {gateModalOpen && gateReport && (() => {
        const passed = gateReport.runAnalysisAvailable;
        return (
          <div data-gate-modal={passed ? 'pass' : 'fail'} className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/40 px-4">
            <div role="dialog" aria-modal="true" className="bg-white rounded-2xl shadow-xl border border-slate-200 p-6 w-full max-w-md text-sm">
              <GateMessageView report={gateReport} system={unitChoice.system} />
              <div className="mt-5 flex justify-end">
                <button
                  onClick={closeGateModal}
                  className={cn("px-5 py-2 rounded-full font-semibold text-white",
                    passed ? "bg-blue-600 hover:bg-blue-700" : "bg-red-600 hover:bg-red-700")}
                >
                  {passed ? 'Continue' : 'Acknowledge & Return'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Footer */}
      <footer className="bg-white border-t border-slate-200 py-12 mt-12">
        <div className="max-w-7xl mx-auto px-4 flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-2 opacity-50">
            <Waves size={20} />
            <span className="font-bold tracking-tight">HydroGuard</span>
          </div>
          <div className="flex items-center gap-8 text-sm text-slate-400 font-medium">
            <a href="#" className="hover:text-blue-600 transition-colors">Documentation</a>
            <a href="#" className="hover:text-blue-600 transition-colors">MOC Theory</a>
            <a href="#" className="hover:text-blue-600 transition-colors">Support</a>
          </div>
          <p className="text-xs text-slate-400">© 2026 HydroGuard Systems. All rights reserved.</p>
        </div>
      </footer>

      {/* Custom Scrollbar Styles */}
      <style dangerouslySetInnerHTML={{ __html: `
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #e2e8f0;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #cbd5e1;
        }
      `}} />
    </div>
  );
}
