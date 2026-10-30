// ── Q17: device icons on the pipeline profile charts (display only) ─────────────────────────────────
// Pictures: builder/inputs/Q17_icons/1..5. Pump, tank and valve sit on the Pipeline line; air valves sit
// above it, the stem's foot touching it. Each icon is one <g data-q17=kind data-x=x>.
import { useXAxisScale, useYAxisScale, ZIndexLayer, DefaultZIndexes } from 'recharts';
import type { Scenario } from './scenario_dispatch';

export type ProfileIconKind = 'air-valve' | 'air-valve-ns' | 'pump' | 'tank' | 'valve' | 'sav' | 'qprv';
export interface ProfileIcon { kind: ProfileIconKind; x: number }

/** The devices the current app models: the scenario's two line ends, plus any placed air valves.
 *  Sources (scenario_dispatch.ts:9-12 routing, buildScenarioArgs :309-357; solver.ts):
 *   pump-trip     = pump at node 0 (PumpParams), downstream reservoir at x = L (legacyToNetwork :1744);
 *   pump-valve    = pump at node 0, valve at x = L discharging to H_down (no tank);
 *   gravity-valve = upstream reservoir at node 0 (GravityUpstream), valve at x = L.
 *  Not drawn: the pump's check valve (solver.ts:1128/1200-1213) is part of the pump boundary, and
 *  ValveParams.check_valve (:2845) is a flag on the end valve; neither is a separate device and the
 *  pictures 1-5 have no check-valve symbol. No other in-line device exists in the app. */
/** Q23: `surgeValves` (SAV at x = 0, QPRV at x = L, O2) are listed first, so the end icon at the same node
 *  is drawn over the foot of their stem. */
export function profileIcons(scenario: Scenario, L: number, airValves: { x: number; nonSlam: boolean }[] = [],
                             surgeValves: ProfileIcon[] = []): ProfileIcon[] {
  const ends: ProfileIcon[] = scenario === 'pump-trip' ? [{ kind: 'pump', x: 0 }, { kind: 'tank', x: L }]
    : scenario === 'gravity-valve' ? [{ kind: 'tank', x: 0 }, { kind: 'valve', x: L }]
    : [{ kind: 'pump', x: 0 }, { kind: 'valve', x: L }];
  return [...surgeValves, ...ends, ...airValves.map(v => ({ kind: (v.nonSlam ? 'air-valve-ns' : 'air-valve') as ProfileIconKind, x: v.x }))];
}

const S = '#1e293b';
function Glyph({ kind }: { kind: ProfileIconKind }) {
  switch (kind) {
    case 'pump':
      return (<><circle r={8} fill="#fff" stroke={S} strokeWidth={2} /><path d="M-3,-5 L5,0 L-3,5 Z" fill={S} /></>);
    case 'tank':
      return (<><rect x={-8} y={-11} width={16} height={22} fill="#f1f5f9" stroke={S} strokeWidth={2} />
        <line x1={-8} y1={-5} x2={8} y2={-5} stroke={S} strokeWidth={1} />
        <path d="M-4,-3 L0,-3 L-3,-1 L1,-1" fill="none" stroke={S} strokeWidth={0.8} /></>);
    case 'valve':
      return (<><path d="M-9,-6 L9,6 L9,-6 L-9,6 Z" fill={S} /><line x1={0} y1={0} x2={0} y2={-9} stroke={S} strokeWidth={1.5} />
        <rect x={-4} y={-15} width={8} height={6} fill="#fff" stroke={S} strokeWidth={1.5} /></>);
    case 'sav':
    case 'qprv':   // Q23: surge valve above its node, as the air valve: stem foot at y = 0, valve body, label;
                   // the body clears an air valve at the same node (air-valve icon top y = -30) by a visible
                   // gap of stem, and the label has a white halo so lines and icons below it do not cross it
      return (<><line x1={0} y1={0} x2={0} y2={-40} stroke={S} strokeWidth={2} />
        <path d="M-8,-51 L8,-41 L8,-51 L-8,-41 Z" fill="#fff" stroke={S} strokeWidth={2} />
        <text y={-55} textAnchor="middle" fontSize={8} fontWeight={700} fill={S} stroke="#fff" strokeWidth={3}
          paintOrder="stroke">{kind === 'sav' ? 'SAV' : 'QPRV'}</text></>);
    default: {   // air valve: stem foot at y = 0, circle above it, triangle on top
      const ns = kind === 'air-valve-ns';
      return (<><line x1={0} y1={0} x2={0} y2={-8} stroke={S} strokeWidth={2} />
        <circle cy={-15} r={7} fill="#fff" stroke={S} strokeWidth={2} />
        <text y={-12.5} textAnchor="middle" fontSize={ns ? 7 : 8} fontWeight={700} fill={S}>{ns ? 'NS' : 'C'}</text>
        <path d="M-7,-30 L7,-30 L0,-22 Z" fill="#fff" stroke={S} strokeWidth={2} />
        {ns && <path d="M-3.5,-28.5 L3.5,-28.5 L0,-25 Z" fill="none" stroke={S} strokeWidth={1} />}</>);
    }
  }
}

/** Child of a recharts LineChart. pts = the Pipeline line's points (x = the X-axis value, z = elevation).
 *  The X axis may be categorical (the Pressure Envelope's XAxis has no type: one category per node, so
 *  tick spacing is per node, not per metre); the Steady-State Profile's is numeric. Either way the icon is
 *  placed by interpolating between the PIXELS of its two neighbouring line points, i.e. on the line as drawn,
 *  at the right fraction between those nodes. pts must be the chart's own data x values so every lookup hits
 *  the category domain; a lookup that still misses is warned in the console, not dropped silently. */
export function ProfileIcons({ pts, icons }: { pts: { x: number; z: number }[]; icons: ProfileIcon[] }) {
  const xs = useXAxisScale(), ys = useYAxisScale();
  if (!xs || !ys || pts.length < 2) return null;
  // Pixel position on the drawn line: the line is straight in pixels between its points, so interpolate there.
  const at = (x: number) => {
    let i = pts.findIndex(p => p.x >= x); if (i <= 0) i = i === 0 ? 1 : pts.length - 1;
    const a = pts[i - 1], b = pts[i], t = b.x === a.x ? 1 : Math.min(1, Math.max(0, (x - a.x) / (b.x - a.x)));
    const ax = xs(a.x), bx = xs(b.x), ay = ys(a.z), by = ys(b.z);
    if (ax === undefined || bx === undefined || ay === undefined || by === undefined) {
      console.warn(`Q17 profile icon at x = ${x} m not drawn: axis scale has no position for x = ${a.x}/${b.x}`);
      return null;
    }
    return { px: ax + (bx - ax) * t, py: ay + (by - ay) * t };
  };
  return (
    // Above the lines (line 400), below the axes (500): icons are not crossed by the HGL / Max / Min lines.
    <ZIndexLayer zIndex={DefaultZIndexes.line + 50}><g pointerEvents="none">
      {icons.map(ic => {
        const p = at(ic.x);
        return p && (
          <g key={`${ic.kind}@${ic.x}`} data-q17={ic.kind} data-x={ic.x} transform={`translate(${p.px},${p.py})`}>
            <Glyph kind={ic.kind} />
          </g>
        );
      })}
    </g></ZIndexLayer>
  );
}
