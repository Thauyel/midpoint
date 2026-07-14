// ============================================================
//  midpoint.js  --  v4: clean circle-from-midpoint algorithm
//
//  The user requested the simpler mental model:
//    "from the actual midpoint extend a circle and after some
//     point find places and tell the relative time to both points."
//
//  This module exports the math behind that algorithm:
//    - haversine / midpoint  : the basic geometry
//    - circleRadiusFor       : radius at each expansion step
//    - expandSteps           : list of radii we try, growing until we get hits
//    - insideCircle          : membership test
//    - rankByCircleDistance  : default sort -- closest to midpoint first
//    - rankByFairnessFromCircle : alternate sort -- fairness first
//    - rankByTotalDriveFromCircle : alternate sort -- shortest combined drive
//    - fmtEta / fmtDist       : display helpers
//    - haversineEta           : straight-line ETA when OSRM is unavailable
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
 * Returns { lat, lon }. Numerically stable for antipodes via the
 * vector-mean formulation.
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

// ============================================================
//  v4: Circle-from-midpoint algorithm
// ============================================================
//
// The "fair zone" is the set of points that are at most
// (directM / 2) from BOTH A and B. For two endpoints separated
// by directM, the circle of radius (directM / 2) around their
// geographic midpoint captures that fair zone precisely. Any
// place inside that circle can be reached by both people in
// roughly the same straight-line time.
//
// We then EXPAND the radius if there aren't enough populated
// places inside (e.g. the midpoint is in the sea). Each step
// grows by 50% so we cover populated areas around the strict
// fair boundary without exploding outward.

/** Minimum search radius -- even for very-close inputs we still
 * look at a city block or two. */
export const MIN_RADIUS_M = 1500;

/** Maximum radius -- never search further from M than the A->B line
 * itself; beyond that we'd just re-discover the endpoints' neighborhoods. */
export function maxRadiusFor(directM) {
  return Math.max(directM, MIN_RADIUS_M * 2);
}

/** Base radius for step 0 -- the strict fair-zone boundary.
 *  Equals directM / 2, floored at MIN_RADIUS_M. */
export function baseRadiusFor(directM) {
  return Math.max(MIN_RADIUS_M, Math.ceil(directM / 2));
}

/** Radius at expansion step `step` (0 = base, 1 = 1.5x, 2 = 2.25x, ...).
 *  Each step multiplies by 1.5 and caps at maxRadiusFor(directM). */
export function circleRadiusFor(directM, step = 0) {
  const base = baseRadiusFor(directM);
  const max = maxRadiusFor(directM);
  const r = base * Math.pow(1.5, step);
  return Math.min(max, Math.round(r));
}

/** Generate the list of search radii we try, growing geometrically
 *  until we either hit the cap or have tried `maxSteps` attempts. */
export function expandSteps(directM, opts = {}) {
  const maxRadiusM = opts.maxRadiusM ?? maxRadiusFor(directM);
  const maxSteps = opts.maxSteps ?? 6;
  const out = [];
  for (let i = 0; i < maxSteps; i++) {
    const r = circleRadiusFor(directM, i);
    if (out.length && r <= out[out.length - 1]) break; // monotonic
    if (r > maxRadiusM) {
      if (out.length && out[out.length - 1] >= maxRadiusM) break;
      out.push(maxRadiusM);
      break;
    }
    out.push(r);
  }
  return out;
}

/** Is `point` inside the circle of `radius` metres around `center`?
 *  Uses haversine for accuracy at any latitude. Closed set
 *  (points exactly on the boundary count as inside). */
export function insideCircle(point, center, radius) {
  if (!point || !center) return false;
  return haversine(point, center) <= radius;
}

// ============================================================
//  Rankers
// ============================================================

/**
 * Rank candidates by distance to the geographic midpoint (ascending).
 * If `radiusM` is given, candidates OUTSIDE that radius are dropped.
 * Ties broken by fairness (smaller |eta_a - eta_b|).
 *
 * Mutates the input by attaching `_dMid` to each element, so downstream
 * code (renderResults) can read the pre-computed distance instead of
 * recomputing haversine for every result-row render.
 */
export function rankByCircleDistance(candidates, mid, radiusM = null) {
  // Single pass: compute distance, attach, filter out-of-radius, sort.
  const arr = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon)) continue;
    const dMid = haversine(mid, c);
    if (radiusM != null && dMid > radiusM) continue;
    arr.push({ c: { ...c, _idx: i, _dMid: dMid }, dMid, fair: Math.abs((c.eta_a_s ?? 0) - (c.eta_b_s ?? 0)) });
  }
  arr.sort((x, y) => {
    if (x.dMid !== y.dMid) return x.dMid - y.dMid;
    if (x.fair !== y.fair) return x.fair - y.fair;
    return x.c._idx - y.c._idx;
  });
  return arr.map((x) => x.c);
}

/**
 * Rank candidates by fairness (|eta_a - eta_b| ascending). Ties broken
 * by distance to midpoint (closer wins), then by combined drive time.
 */
export function rankByFairnessFromCircle(candidates, mid) {
  const arr = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon)) continue;
    const dMid = haversine(mid, c);
    arr.push({
      c: { ...c, _idx: i, _dMid: dMid },
      dMid,
      fair: Math.abs((c.eta_a_s ?? 0) - (c.eta_b_s ?? 0)),
      total: (c.eta_a_s ?? 0) + (c.eta_b_s ?? 0),
    });
  }
  arr.sort((x, y) => {
    if (x.fair !== y.fair) return x.fair - y.fair;
    if (x.dMid !== y.dMid) return x.dMid - y.dMid;
    if (x.total !== y.total) return x.total - y.total;
    return x.c._idx - y.c._idx;
  });
  return arr.map((x) => x.c);
}

/**
 * Rank candidates by total drive time (eta_a + eta_b ascending).
 * Ties broken by distance to midpoint.
 */
export function rankByTotalDriveFromCircle(candidates, mid) {
  const arr = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon)) continue;
    const dMid = haversine(mid, c);
    arr.push({
      c: { ...c, _idx: i, _dMid: dMid },
      dMid,
      total: (c.eta_a_s ?? 0) + (c.eta_b_s ?? 0),
    });
  }
  arr.sort((x, y) => {
    if (x.total !== y.total) return x.total - y.total;
    if (x.dMid !== y.dMid) return x.dMid - y.dMid;
    return x.c._idx - y.c._idx;
  });
  return arr.map((x) => x.c);
}

/** "Is this candidate fair?" -- |Δ| below `thresholdS` seconds.
 *  Used for the green "fair" badge in the UI. */
export function isFair(c, thresholdS = 5 * 60) {
  return Math.abs((c.eta_a_s ?? 0) - (c.eta_b_s ?? 0)) <= thresholdS;
}

// ============================================================
//  ETA fallback (straight-line distance -> seconds)
// ============================================================

// Average urban driving speed (m/s). ~30 km/h is a reasonable assumption
// for Istanbul, London, NYC, etc. Used when OSRM is down.
export const URBAN_DRIVE_M_S = 30 * 1000 / 3600; // 8.333 m/s

// Minimum plausible ETA floor (seconds) so cafes 100m away don't show
// "0 s" -- they show "2 min" (realistic for parking + walk to door).
export const MIN_ETA_S = 90;

/** ETA from straight-line distance, used as fallback when OSRM is
 *  unavailable. Returns seconds (number) or null on bad input. */
export function haversineEta(distanceM, speedMps = URBAN_DRIVE_M_S) {
  if (distanceM == null || !isFinite(distanceM)) return null;
  return Math.max(MIN_ETA_S, distanceM / speedMps);
}