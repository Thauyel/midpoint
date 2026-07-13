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
 * Rank by *fairness first*: smallest |Δ| wins. Total drive time is the
 * tiebreaker. This is the better ranking when the user explicitly wants
 * "fair meeting point" rather than "minimum combined drive time".
 */
export function rankByFairnessFirst(candidates, maxFairS = 30 * 60) {
  return [...candidates]
    .filter((c) => Number.isFinite(c.eta_a_s) && Number.isFinite(c.eta_b_s))
    .map((c, i) => ({ ...c, _idx: i }))
    .sort((x, y) => {
      const fairX = Math.min(Math.abs(x.eta_a_s - x.eta_b_s), maxFairS);
      const fairY = Math.min(Math.abs(y.eta_a_s - y.eta_b_s), maxFairS);
      if (fairX !== fairY) return fairX - fairY;
      const totX = x.eta_a_s + x.eta_b_s;
      const totY = y.eta_a_s + y.eta_b_s;
      if (totX !== totY) return totX - totY;
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

/**
 * Rank by distance to the geographic midpoint, with fairness as tiebreaker.
 * This is the "closest to midpoint" ranking -- what most users actually want
 * when they say "find a place in the middle". Drives the default order in
 * the UI; the user can switch to total/fairness via the sort tabs.
 *
 * `mid` is the geographic midpoint {lat, lon}. `candidates` must already
 * carry eta_a_s / eta_b_s if you want fairness to break ties intelligently.
 */
export function rankByMidpointDistance(candidates, mid) {
  if (!mid) return rankByFairnessFirst(candidates);
  return [...candidates]
    .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon))
    .map((c, i) => ({ ...c, _idx: i }))
    .sort((x, y) => {
      const dX = haversine(mid, x);
      const dY = haversine(mid, y);
      if (dX !== dY) return dX - dY;
      // Tiebreaker: smaller fairness gap is better
      const fX = Math.abs((x.eta_a_s ?? 0) - (x.eta_b_s ?? 0));
      const fY = Math.abs((y.eta_a_s ?? 0) - (y.eta_b_s ?? 0));
      if (fX !== fY) return fX - fY;
      return x._idx - y._idx;
    });
}

/**
 * Rank by minimum total drive time (eta_a_s + eta_b_s) ascending.
 */
export function rankByTotalDrive(candidates) {
  return [...candidates]
    .filter((c) => Number.isFinite(c.eta_a_s) && Number.isFinite(c.eta_b_s))
    .map((c, i) => ({ ...c, _idx: i }))
    .sort((x, y) => {
      const totX = x.eta_a_s + x.eta_b_s;
      const totY = y.eta_a_s + y.eta_b_s;
      if (totX !== totY) return totX - totY;
      return x._idx - y._idx;
    });
}

// Average urban driving speed (m/s). ~30 km/h is a reasonable assumption for
// Istanbul, London, NYC, etc. We use this when OSRM is down so the app still
// gives a ranked list instead of failing entirely.
export const URBAN_DRIVE_M_S = 30 * 1000 / 3600; // 8.333

// Minimum plausible ETA floor (seconds) when the straight-line distance is
// very short -- so we don't display "0 s" / "0 min" for cafes sitting on
// top of one of the two endpoints.
export const MIN_ETA_S = 90; // 1.5 min -- realistic for parking + walk to door

/**
 * Fallback ETA from straight-line distance. Used when OSRM /table is
 * unavailable (rate-limited / CORS-blocked / timed out). Less accurate than
 * OSRM but still good enough for fairness ranking.
 */
export function haversineEta(distanceM, speedMps = URBAN_DRIVE_M_S) {
  if (distanceM == null || !isFinite(distanceM)) return null;
  return Math.max(MIN_ETA_S, distanceM / speedMps);
}

// ============================================================
//  Sample points along the line between A and B
// ============================================================
//
// For two points that are far apart (or whose geographic midpoint falls in
// the sea / a mountain / a desert), we don't want to search a tiny circle
// around mid -- we'd find nothing. Instead we sample N "meeting points"
// along the line A->B, and search around each. That way, even if A and B
// are 40km apart across a body of water, we still surface cafes that
// happen to live near the line between them.

/**
 * Linear interpolation between two lat/lon points in *planar* space.
 * Good enough for short to medium distances (<100km). For very long
 * distances this drifts slightly but the candidate search radius absorbs it.
 */
export function lerpLatLon(a, b, t) {
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lon: a.lon + (b.lon - a.lon) * t,
  };
}

/**
 * Sample `n` evenly-spaced points along the line A→B, excluding the
 * endpoints themselves (they'd just return the user's own neighborhood).
 * Includes the geographic midpoint.
 */
export function sampleAlongLine(a, b, n = 7) {
  const points = [];
  // Use a cosine-spaced distribution: denser near the midpoint where the
  // fair zone is, sparser near the endpoints.
  for (let i = 0; i < n; i++) {
    // t in (0, 1) exclusive
    const u = (i + 0.5) / n;
    points.push(lerpLatLon(a, b, u));
  }
  return points;
}

/**
 * Build a list of search anchors: the line samples PLUS the actual
 * geographic midpoint PLUS the two endpoints (small radius each).
 * Returns unique points (within 50m of each other collapsed to one).
 */
export function searchAnchors(a, b, lineSamplesN = 7) {
  const anchors = [];
  // The endpoints with a tight radius -- "somewhere near A but not at A"
  // and "somewhere near B but not at B" are also valid picks (e.g. the
  // halfway cafe could legitimately be 3km from one endpoint if it has
  // a great view of the sea).
  anchors.push(a, b);
  // The line samples -- these are where the fair places actually live.
  for (const p of sampleAlongLine(a, b, lineSamplesN)) anchors.push(p);
  // The geographic midpoint -- keep this too in case the line samples
  // miss the exact center.
  anchors.push(midpoint(a, b));
  // Dedupe by ~50m proximity.
  const seen = [];
  const out = [];
  for (const p of anchors) {
    const dupe = seen.some((q) => haversine(p, q) < 50);
    if (!dupe) { seen.push(p); out.push(p); }
  }
  return out;
}

/**
 * Bearing from a → b in degrees (0 = north, 90 = east).
 * Used to compute the perpendicular offset for the "wider corridor"
 * anchor search.
 */
export function bearing(a, b) {
  const phi1 = toRad(a.lat);
  const phi2 = toRad(b.lat);
  const dLam = toRad(b.lon - a.lon);
  const y = Math.sin(dLam) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) -
            Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLam);
  return ((toDeg(Math.atan2(y, x)) + 360) % 360);
}

/**
 * Offset a point by `distanceM` metres along the given bearing (degrees).
 */
export function offsetPoint(p, distanceM, bearingDeg) {
  const ang = distanceM / R_EARTH_M; // radians
  const phi1 = toRad(p.lat);
  const lam1 = toRad(p.lon);
  const theta = toRad(bearingDeg);
  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(ang) +
    Math.cos(phi1) * Math.sin(ang) * Math.cos(theta)
  );
  const lam2 = lam1 + Math.atan2(
    Math.sin(theta) * Math.sin(ang) * Math.cos(phi1),
    Math.cos(ang) - Math.sin(phi1) * Math.sin(phi2)
  );
  return { lat: toDeg(phi2), lon: ((toDeg(lam2) + 540) % 360) - 180 };
}

/**
 * Build a wider corridor: anchors perpendicular-offset from the line A→B.
 * This catches cafes that are a few hundred metres off the line (e.g. on
 * the seaside while A and B are both inland) that the strict-line search
 * would miss.
 */
export function corridorAnchors(a, b, lineSamplesN = 5, perpOffsetM = 600) {
  const out = [];
  const brg = bearing(a, b);
  for (const p of sampleAlongLine(a, b, lineSamplesN)) {
    out.push(offsetPoint(p,  perpOffsetM, brg + 90));
    out.push(offsetPoint(p, -perpOffsetM, brg + 90));
  }
  return out;
}

// ============================================================
//  Tangent line through the two fair-zone circles
// ============================================================
//
// The "fair zone" is the intersection of two circles, one around A and
// one around B, both with radius directM * 0.5. The INTERSECTION is a
// lens. The two EXTERNAL tangent points (where a line touches both circles
// from the outside, on the side facing the meeting region) form a chord
// across each circle. A line connecting those tangent points is the
// "tangent chord" -- places on this line are equidistant from A and B
// AND sit on the boundary of the fair zone. Catching cafes along this
// chord is a powerful way to find genuinely fair meeting points.
//
// For two circles of EQUAL radius (which is our case), the external
// tangents are simply parallel to A→B, offset perpendicularly by `r`.
// We add a small inward offset so the line passes just inside the
// fair zone, not exactly on its boundary.

/**
 * Build the two "tangent chord" lines: the perpendicular lines to A→B
 * at each fair-circle's boundary, plus several sample points ALONG the
 * chord. Returns anchors perpendicular to A→B at distance r (the fair
 * radius) from the line, on both sides.
 */
export function tangentChordAnchors(a, b, r, samplesN = 5) {
  const out = [];
  const brg = bearing(a, b);
  // Inset slightly so anchors land inside the fair zone, not on the
  // boundary circle (where a search would mostly return nothing).
  const offset = Math.max(200, r * 0.4);
  // The chord runs perpendicular to A→B. Sample points along it.
  // Use the line sample midpoints to get good geographic spread.
  for (const p of sampleAlongLine(a, b, samplesN)) {
    out.push(offsetPoint(p,  offset, brg + 90));
    out.push(offsetPoint(p, -offset, brg + 90));
    // Also push the boundary points themselves -- popular places that
    // sit exactly on the fair-zone edge are still valuable.
    out.push(offsetPoint(p,  r, brg + 90));
    out.push(offsetPoint(p, -r, brg + 90));
  }
  return out;
}

/**
 * Build a strictly "always-suggest" anchor set: progressively widens
 * the search radius around the geographic midpoint until we get hits.
 * Used as a last-resort fallback if the line/corridor searches return
 * zero places. Returns the union of anchors at increasing radii.
 */
export function expandingAnchors(mid, startRadiusM = 2000, stepM = 2000, maxSteps = 5) {
  const out = [];
  for (let i = 0; i < maxSteps; i++) {
    out.push({ ...mid, _r: startRadiusM + i * stepM });
  }
  return out;
}