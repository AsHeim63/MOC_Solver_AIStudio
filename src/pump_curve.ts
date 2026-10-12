// ── pump_curve.ts — user pump curve: fit from points, and the Q6-h pump flow rule (Q10) ─────────
//
// Pure module, no imports. Treated as a solver module (physics auditor runs on it).
// SI only: Q [m³/s], H [m]; curve H_rise(Q) = a·Q² + α·b·Q + α²·c is the pump's total head RISE
// (DOMAIN §15 (i)); the velocity-head part is ignored (§15 (viii)).

export interface PumpCurveCoefs { a: number; b: number; c: number; }
export interface PumpCurvePoint { Q: number; H: number; }

/** DC-11 named constants (DOMAIN §15 (vi)). */
export const PUMP_CURVE_MIN_POINTS = 3;
export const PUMP_CURVE_FIT_MAX_RESIDUAL_FRAC = 0.05;

export type PumpCurveFit =
    | { ok: true; curve: PumpCurveCoefs; humpRemoved: boolean }
    | { ok: false; reason: string };

/**
 * Fit H = a·Q² + b·Q + c to the entered points (rulings Q6-c, Q6-d, Q6-g; plan §5).
 * Exactly 3 points: exact parabola. More: least squares on x = Q/Qmax. Hump (b > 0): refit with
 * b = 0 (closest no-hump curve). Then a < 0, c > 0, head rise > 0 at every entered Q, and — for
 * more than 3 points or a hump refit — every point within 5 % of c of the curve.
 */
export function fitPumpCurve(points: PumpCurvePoint[]): PumpCurveFit {
    if (points.length < PUMP_CURVE_MIN_POINTS) return { ok: false, reason: `fewer than ${PUMP_CURVE_MIN_POINTS} points` };
    for (const p of points) {
        if (!Number.isFinite(p.Q) || !Number.isFinite(p.H)) return { ok: false, reason: 'a point is not a finite number' };
        if (p.Q < 0) return { ok: false, reason: 'a flow is negative' };
        if (!(p.H > 0)) return { ok: false, reason: 'a head is zero or negative' };
    }
    if (new Set(points.map(p => p.Q)).size < PUMP_CURVE_MIN_POINTS) {
        return { ok: false, reason: `fewer than ${PUMP_CURVE_MIN_POINTS} different flows` };
    }
    let curve = points.length === 3 ? exactParabola(points) : leastSquares(points, true);
    const humpRemoved = curve.b > 0;
    if (humpRemoved) curve = leastSquares(points, false);
    if (!(curve.a < 0) || !(curve.b <= 0) || !(curve.c > 0) || ![curve.a, curve.b, curve.c].every(Number.isFinite)) {
        return { ok: false, reason: 'the fitted curve does not fall with flow' };
    }
    const h = (q: number) => curve.a * q * q + curve.b * q + curve.c;
    if (points.length > 3 || humpRemoved) {
        const worst = Math.max(...points.map(p => Math.abs(p.H - h(p.Q))));
        if (worst > PUMP_CURVE_FIT_MAX_RESIDUAL_FRAC * curve.c) return { ok: false, reason: 'a point is off the curve by more than 5 % of the shut-off head' };
    }
    if (!points.every(p => h(p.Q) > 0)) return { ok: false, reason: 'the curve head is zero or negative at an entered flow' };
    return { ok: true, curve, humpRemoved };
}

/** Newton divided differences through exactly three points with distinct Q. */
function exactParabola(p: PumpCurvePoint[]): PumpCurveCoefs {
    const [p0, p1, p2] = p;
    const f01 = (p1.H - p0.H) / (p1.Q - p0.Q);
    const f12 = (p2.H - p1.H) / (p2.Q - p1.Q);
    const a = (f12 - f01) / (p2.Q - p0.Q);
    return { a, b: f01 - a * (p0.Q + p1.Q), c: p0.H - f01 * p0.Q + a * p0.Q * p1.Q };
}

/** Least squares on x = Q/Qmax, basis [1, x, x²] (withB) or [1, x²] (b fixed at 0). */
function leastSquares(pts: PumpCurvePoint[], withB: boolean): PumpCurveCoefs {
    const Qm = Math.max(...pts.map(p => p.Q));
    const basis = (x: number) => withB ? [1, x, x * x] : [1, x * x];
    const n = withB ? 3 : 2;
    const M = Array.from({ length: n }, () => new Array<number>(n + 1).fill(0));
    for (const p of pts) {
        const f = basis(p.Q / Qm);
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) M[i][j] += f[i] * f[j];
            M[i][n] += f[i] * p.H;
        }
    }
    for (let i = 0; i < n; i++) {   // Gauss-Jordan, partial pivoting
        let piv = i;
        for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[piv][i])) piv = r;
        [M[i], M[piv]] = [M[piv], M[i]];
        for (let r = 0; r < n; r++) {
            if (r === i) continue;
            const k = M[r][i] / M[i][i];
            for (let j = i; j <= n; j++) M[r][j] -= k * M[i][j];
        }
    }
    const s = M.map((row, i) => row[n] / row[i]);
    return withB ? { c: s[0], b: s[1] / Qm, a: s[2] / (Qm * Qm) } : { c: s[0], b: 0, a: s[1] / (Qm * Qm) };
}

/**
 * Run-out flow Q_r(α): positive root of a·Q² + α·b·Q + α²·c = 0 (head rise 0), cancellation-free
 * (a < 0, b ≤ 0, c > 0 ⟹ the bottom is a sum of non-negatives). DOMAIN §15 (ix).
 */
export function pumpRunOutFlow(curve: PumpCurveCoefs, alpha: number): number {
    return alpha * 2.0 * curve.c / (Math.sqrt(curve.b * curve.b - 4.0 * curve.a * curve.c) - curve.b);
}

/**
 * Q6-h pump flow rule Q_pump(Δ), Δ = head rise across the pump (DOMAIN §15 (ix)):
 * Δ ≤ 0 → run-out Q_r(α); Δ ≥ α²·c → 0 (check valve shut); between → the curve root, in the
 * cancellation-free form Q = 2·D / (−α·b + sqrt(α²·b² + 4·(−a)·D)), D = α²·c − Δ.
 */
export function pumpFlowAtHeadRise(curve: PumpCurveCoefs, alpha: number, dH: number): number {
    if (dH <= 0) return pumpRunOutFlow(curve, alpha);
    const D = alpha * alpha * curve.c - dH;
    if (D <= 0) return 0.0;
    const ab = alpha * curve.b;
    return 2.0 * D / (-ab + Math.sqrt(ab * ab + 4.0 * (-curve.a) * D));
}
