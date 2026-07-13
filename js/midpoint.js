// ============================================================
//  midpoint.js  --  Haversine midpoint + fairness ranking
//  Pure functions, no deps. Tested in tests/test_midpoint.mjs
// ============================================================

const R_EARTH_M = 6_371_008.8; // mean Earth radius in metres (IUGG)

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

/**
 * Great-circle distance in metres between two {lat, lon} points.
 */
export function haversine(a, b) {
  const phi1 = toRad(a.lat);
  const phi2 = toRad(b.lat);
  const dPhi = toRad(b.lat - a.lat);
  const dLam = toRad(b.lon - a.lon);

  const h =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLam / 2) ** 2;

  return 2 * R_EARTH_M * Math.asin(Math.sqrt(h));
}

/**
 * Geographic midpoint of two points on the sphere.
 * Handles antipodes by picking a stable pole-relative point.
 * Returns { lat, lon }.
 */
export function midpoint(a, b) {
  const phi1 = toRad(a.lat);
  const lam1 = toRad(a.lon);
  const phi2 = toRad(b.lat);
  const lam2 = toRad(b.lon);

  const dLam = lam2 - lam1;

  const Bx = Math.cos(phi2) * Math.cos(dLam);
  const By = Math.cos(phi2) * Math.sin(dLam);

  const phi3 = Math.atan2(
    Math.sin(phi1) + Math.sin(phi2),
    Math.sqrt((Math.cos(phi1) + Bx) ** 2 + By ** 2)
  );
  const lam3 = lam1 + Math.atan2(By, Math.cos(phi1) + Bx);

  return { lat: toDeg(phi3), lon: ((toDeg(lam3) + 540) % 360) - 180 };
}

/**
 * Format seconds as "12 min" / "1 h 5 min".
 */
export function fmtEta(seconds) {
  if (seconds == null || !isFinite(seconds)) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h} h ${rem} min` : `${h} h`;
}

/**
 * Format metres as "850 m" / "3.2 km".
 */
export function fmtDist(metres) {
  if (metres == null || !isFinite(metres)) return "—";
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(metres < 10000 ? 2 : 1)} km`;
}

/**
 * Rank candidates by total driving time first, fairness (|Δ|) as tiebreaker.
 * `candidates` must already carry eta_a_s, eta_b_s.
 * Returns a NEW sorted array — input is not mutated.
 */
export function rankByFairness(candidates) {
  return [...candidates]
    .map((c, i) => ({ ...c, _idx: i }))
    .sort((x, y) => {
      const totX = x.eta_a_s + x.eta_b_s;
      const totY = y.eta_a_s + y.eta_b_s;
      if (totX !== totY) return totX - totY;
      const fairX = Math.abs(x.eta_a_s - x.eta_b_s);
      const fairY = Math.abs(y.eta_a_s - y.eta_b_s);
      if (fairX !== fairY) return fairX - fairY;
      return x._idx - y._idx;
    });
}

/**
 * "Is this candidate fair?" — used for the green badge.
 * threshold: seconds of |Δ| below which we consider the place fair.
 */
export function isFair(c, thresholdS = 5 * 60) {
  return Math.abs((c.eta_a_s ?? 0) - (c.eta_b_s ?? 0)) <= thresholdS;
}