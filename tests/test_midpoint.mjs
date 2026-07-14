// ============================================================
//  tests/test_midpoint.mjs
//  Tiny zero-dep test runner. Runs in plain node:
//      node tests/test_midpoint.mjs
//
//  Tests the v4 circle-from-midpoint algorithm.
// ============================================================

import {
  haversine,
  midpoint,
  fmtEta,
  fmtDist,
  rankByCircleDistance,
  rankByFairnessFromCircle,
  rankByTotalDriveFromCircle,
  isFair,
  haversineEta,
  bearing,
  offsetPoint,
  circleRadiusFor,
  expandSteps,
  baseRadiusFor,
  maxRadiusFor,
  insideCircle,
  MIN_RADIUS_M,
} from "../js/midpoint.js";

let passed = 0;
let failed = 0;

const test = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
    failed++;
  }
};

const eq = (actual, expected, label = "") => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${label} expected ${e}, got ${a}`);
  }
};

const approx = (actual, expected, tol = 1e-3, label = "") => {
  if (Math.abs(actual - expected) > tol) {
    throw new Error(`${label} expected ≈${expected} (±${tol}), got ${actual}`);
  }
};

console.log("\n== haversine ==");

test("zero distance for identical points", () => {
  const p = { lat: 41.0082, lon: 28.9784 }; // Istanbul
  approx(haversine(p, p), 0);
});

test("Istanbul → Ankara ≈ 350 km", () => {
  const ist = { lat: 41.0082, lon: 28.9784 };
  const ank = { lat: 39.9334, lon: 32.8597 };
  const km = haversine(ist, ank) / 1000;
  if (Math.abs(km - 350) > 4) throw new Error(`expected ~350 km, got ${km.toFixed(2)}`);
});

test("symmetric (a→b == b→a)", () => {
  const a = { lat: 40, lon: 28 };
  const b = { lat: 41, lon: 29 };
  approx(haversine(a, b), haversine(b, a));
});

test("Lecco → Milan ~ 46 km", () => {
  const lec = { lat: 45.8566, lon: 9.3933 };
  const mil = { lat: 45.4642, lon: 9.1900 };
  const km = haversine(lec, mil) / 1000;
  if (Math.abs(km - 46.4) > 1) throw new Error(`expected ~46.4 km, got ${km.toFixed(2)}`);
});

console.log("\n== midpoint ==");

test("midpoint of a point with itself is that point", () => {
  const p = { lat: 41.0, lon: 29.0 };
  const m = midpoint(p, p);
  approx(m.lat, 41.0, 1e-6);
  approx(m.lon, 29.0, 1e-6);
});

test("midpoint of Istanbul and Ankara ≈ Bolu area", () => {
  const ist = { lat: 41.0082, lon: 28.9784 };
  const ank = { lat: 39.9334, lon: 32.8597 };
  const m = midpoint(ist, ank);
  approx(m.lat, 40.47, 0.05);
  approx(m.lon, 30.92, 0.05);
});

test("midpoint is symmetric", () => {
  const a = { lat: 40.5, lon: 28.5 };
  const b = { lat: 41.5, lon: 30.5 };
  const m1 = midpoint(a, b);
  const m2 = midpoint(b, a);
  approx(m1.lat, m2.lat, 1e-9);
  approx(m1.lon, m2.lon, 1e-9);
});

test("midpoint distance to each endpoint is equal", () => {
  const a = { lat: 41.0, lon: 29.0 };
  const b = { lat: 41.1, lon: 29.2 };
  const m = midpoint(a, b);
  approx(haversine(a, m), haversine(b, m), 1e-3);
});

console.log("\n== fmtEta / fmtDist ==");

test("fmtEta handles seconds / minutes / hours", () => {
  if (fmtEta(0)   !== "0 s")   throw new Error("0");
  if (fmtEta(45)  !== "45 s")  throw new Error("45");
  if (fmtEta(60)  !== "1 min") throw new Error("60");
  if (fmtEta(720) !== "12 min")throw new Error("720");
  if (fmtEta(3700)!== "1 h 2 min") throw new Error("3700");
  if (fmtEta(3600)!== "1 h")  throw new Error("3600");
});

test("fmtDist handles m / km", () => {
  if (fmtDist(0)    !== "0 m")    throw new Error("0");
  if (fmtDist(850)  !== "850 m")  throw new Error("850");
  if (fmtDist(1000) !== "1.00 km")throw new Error("1000");
  if (fmtDist(3200) !== "3.20 km")throw new Error("3200");
  if (fmtDist(12345)!== "12.3 km")throw new Error("12345");
});

console.log("\n== isFair ==");

test("isFair true for |Δ| <= 5min", () => {
  if (!isFair({ eta_a_s: 600, eta_b_s: 900 })) throw new Error("300s Δ should be fair");
  if (!isFair({ eta_a_s: 600, eta_b_s: 600 }))  throw new Error("0 Δ should be fair");
});

test("isFair false for |Δ| > 5min", () => {
  if (isFair({ eta_a_s: 600, eta_b_s: 901 })) throw new Error("301s Δ should be unfair");
});

console.log("\n== haversineEta ==");

test("haversineEta returns seconds scaled by speed", () => {
  const eta = haversineEta(1000);
  if (Math.abs(eta - 120) > 1) throw new Error(`expected ~120, got ${eta}`);
});

test("haversineEta floors at MIN_ETA_S for tiny distances", () => {
  const eta = haversineEta(10);
  if (eta !== 90) throw new Error(`expected 90, got ${eta}`);
});

console.log("\n== bearing / offsetPoint ==");

test("bearing is 0 between two points due north", () => {
  const a = { lat: 40, lon: 29 };
  const b = { lat: 41, lon: 29 };
  const brg = bearing(a, b);
  if (Math.abs(brg - 0) > 1) throw new Error(`expected ~0°, got ${brg}`);
});

test("bearing is 90 between two points due east", () => {
  const a = { lat: 40, lon: 29 };
  const b = { lat: 40, lon: 30 };
  const brg = bearing(a, b);
  if (Math.abs(brg - 90) > 1) throw new Error(`expected ~90°, got ${brg}`);
});

test("offsetPoint round-trips bearing+distance", () => {
  const a = { lat: 40, lon: 29 };
  const b = offsetPoint(a, 1000, 0);
  if (Math.abs(b.lat - 40.009) > 0.002) throw new Error(`lat off: ${b.lat}`);
  if (Math.abs(b.lon - 29) > 0.001) throw new Error(`lon off: ${b.lon}`);
});

// ============================================================
//  v4: circle-from-midpoint algorithm
// ============================================================

console.log("\n== circle radius (v4) ==");

test("baseRadiusFor(directM) returns directM/2", () => {
  const r = baseRadiusFor(10_000);
  if (Math.abs(r - 5000) > 1) throw new Error(`expected ~5000, got ${r}`);
});

test("baseRadiusFor floors at MIN_RADIUS_M for tiny lines", () => {
  const r = baseRadiusFor(100);
  if (r < MIN_RADIUS_M) throw new Error(`expected ≥ ${MIN_RADIUS_M}, got ${r}`);
});

test("circleRadiusFor step 0 = base", () => {
  const r = circleRadiusFor(10_000, 0);
  if (Math.abs(r - 5000) > 1) throw new Error(`expected ~5000, got ${r}`);
});

test("circleRadiusFor step 1 = 1.5x the base", () => {
  const r = circleRadiusFor(10_000, 1);
  if (Math.abs(r - 7500) > 1) throw new Error(`expected ~7500, got ${r}`);
});

test("circleRadiusFor grows monotonically (or holds at cap)", () => {
  // For directM=20km, maxRadiusFor is 20km. Once we hit the cap, we stay
  // there (we don't keep growing). So the sequence must be monotonic-or-equal,
  // strictly increasing until the cap, then constant.
  const directM = 20_000;
  const radii = [0, 1, 2, 3, 4, 5, 6].map((s) => circleRadiusFor(directM, s));
  for (let i = 1; i < radii.length; i++) {
    if (radii[i] < radii[i - 1]) {
      throw new Error(`step ${i} (${radii[i]}) must be ≥ step ${i - 1} (${radii[i - 1]})`);
    }
  }
  // First few steps must be strictly increasing.
  if (radii[0] >= radii[1] || radii[1] >= radii[2]) {
    throw new Error(`early steps should be strictly increasing: ${radii.slice(0, 3)}`);
  }
});

test("circleRadiusFor caps at maxRadiusFor(directM)", () => {
  const directM = 5_000;
  const r = circleRadiusFor(directM, 10);
  if (r > maxRadiusFor(directM)) {
    throw new Error(`step 10 radius ${r} exceeds maxRadiusFor ${maxRadiusFor(directM)}`);
  }
});

test("circleRadiusFor returns sane numbers for a city line (50 km)", () => {
  // Beylikdüzü ↔ Kartal: 50 km, ~25 km fair radius. Step 0 = 25 km.
  const directM = 50_000;
  const r0 = circleRadiusFor(directM, 0);
  if (r0 < 20_000 || r0 > 30_000) {
    throw new Error(`expected 20-30km for step 0, got ${r0}`);
  }
});

console.log("\n== insideCircle ==");

test("insideCircle: midpoint itself is always inside", () => {
  const mid = { lat: 41.0, lon: 29.0 };
  if (!insideCircle(mid, mid, 1000)) {
    throw new Error("midpoint should be inside its own circle");
  }
});

test("insideCircle: point exactly on the radius boundary is inside (closed set)", () => {
  const mid = { lat: 41.0, lon: 29.0 };
  const p = offsetPoint(mid, 1000, 90); // 1km east
  if (!insideCircle(p, mid, 1000)) {
    throw new Error("point on the radius boundary should be inside (closed set)");
  }
});

test("insideCircle: point just beyond the radius is outside", () => {
  const mid = { lat: 41.0, lon: 29.0 };
  const p = offsetPoint(mid, 1500, 90); // 1.5km east
  if (insideCircle(p, mid, 1000)) {
    throw new Error("point beyond radius should be outside");
  }
});

test("insideCircle: rejects nulls safely", () => {
  if (insideCircle(null, { lat: 0, lon: 0 }, 1000)) {
    throw new Error("null point should return false");
  }
  if (insideCircle({ lat: 0, lon: 0 }, null, 1000)) {
    throw new Error("null center should return false");
  }
});

console.log("\n== rankByCircleDistance (default sort) ==");

test("rankByCircleDistance: closest to midpoint wins", () => {
  const mid = { lat: 41.0, lon: 29.0 };
  const near = { lat: 41.001, lon: 29.001, eta_a_s: 900, eta_b_s: 900 };
  const far  = { lat: 41.05,  lon: 29.05,  eta_a_s: 600, eta_b_s: 600 };
  const ranked = rankByCircleDistance([far, near], mid);
  if (ranked[0].lat !== near.lat) {
    throw new Error(`expected near first, got ${JSON.stringify(ranked[0])}`);
  }
});

test("rankByCircleDistance: breaks ties by fairness when distance equal", () => {
  const mid = { lat: 41.0, lon: 29.0 };
  const fair   = { lat: 41.005, lon: 29.005, eta_a_s: 600, eta_b_s: 600 };
  const unfair = { lat: 41.005, lon: 29.005, eta_a_s: 200, eta_b_s: 1000 };
  const ranked = rankByCircleDistance([unfair, fair], mid);
  if (ranked[0].eta_a_s !== fair.eta_a_s) {
    throw new Error(`expected fair to win tiebreaker, got ${JSON.stringify(ranked[0])}`);
  }
});

test("rankByCircleDistance: drops candidates outside the given radius", () => {
  const mid = { lat: 41.0, lon: 29.0 };
  const inside = { lat: 41.005, lon: 29.005, eta_a_s: 600, eta_b_s: 600 };
  const outside = { lat: 41.5, lon: 29.5, eta_a_s: 100, eta_b_s: 100 };
  const ranked = rankByCircleDistance([outside, inside], mid, 1000);
  if (ranked.some((c) => c.lat === 41.5)) {
    throw new Error("outside candidate should have been dropped");
  }
  if (ranked[0].lat !== inside.lat) {
    throw new Error(`expected inside first, got ${JSON.stringify(ranked[0])}`);
  }
});

test("rankByCircleDistance: no radius filter keeps all candidates", () => {
  const mid = { lat: 41.0, lon: 29.0 };
  const a = { lat: 41.001, lon: 29.001 };
  const b = { lat: 41.05,  lon: 29.05  };
  const ranked = rankByCircleDistance([b, a], mid);
  if (ranked.length !== 2) throw new Error(`expected 2, got ${ranked.length}`);
  if (ranked[0].lat !== a.lat) throw new Error(`expected closer first, got ${ranked[0].lat}`);
});

test("rankByCircleDistance: does not mutate input", () => {
  const mid = { lat: 41.0, lon: 29.0 };
  const input = [
    { lat: 41.05, lon: 29.05, eta_a_s: 100, eta_b_s: 100 },
    { lat: 41.001, lon: 29.001, eta_a_s: 100, eta_b_s: 100 },
  ];
  const before = JSON.stringify(input);
  rankByCircleDistance(input, mid);
  const after = JSON.stringify(input);
  if (before !== after) throw new Error("input mutated");
});

console.log("\n== rankByFairnessFromCircle ==");

test("rankByFairnessFromCircle: fairness first, |Δ| ascending", () => {
  const mid = { lat: 41.0, lon: 29.0 };
  const fair   = { lat: 41.005, lon: 29.005, eta_a_s: 600, eta_b_s: 600 }; // Δ=0
  const unfair = { lat: 41.005, lon: 29.005, eta_a_s: 200, eta_b_s: 1000 }; // Δ=800
  const ranked = rankByFairnessFromCircle([unfair, fair], mid);
  if (ranked[0].eta_a_s !== fair.eta_a_s) {
    throw new Error(`expected fair first, got ${JSON.stringify(ranked[0])}`);
  }
});

test("rankByFairnessFromCircle: breaks ties by closeness to mid", () => {
  const mid = { lat: 41.0, lon: 29.0 };
  const farFair  = { lat: 41.10, lon: 29.10, eta_a_s: 600, eta_b_s: 600 };
  const nearFair = { lat: 41.01, lon: 29.01, eta_a_s: 600, eta_b_s: 600 };
  const ranked = rankByFairnessFromCircle([farFair, nearFair], mid);
  if (ranked[0].lat !== nearFair.lat) {
    throw new Error(`expected near fair first, got ${JSON.stringify(ranked[0])}`);
  }
});

console.log("\n== rankByTotalDriveFromCircle ==");

test("rankByTotalDriveFromCircle: eta_a + eta_b ascending", () => {
  const mid = { lat: 41.0, lon: 29.0 };
  const fast = { lat: 41.005, lon: 29.005, eta_a_s: 300, eta_b_s: 300 };
  const slow = { lat: 41.005, lon: 29.005, eta_a_s: 900, eta_b_s: 900 };
  const ranked = rankByTotalDriveFromCircle([slow, fast], mid);
  if (ranked[0].eta_a_s !== fast.eta_a_s) {
    throw new Error(`expected fast first, got ${JSON.stringify(ranked[0])}`);
  }
});

console.log("\n== expandSteps ==");

test("expandSteps: returns radii that grow geometrically then cap", () => {
  const steps = expandSteps(10_000, { maxRadiusM: 25_000 });
  if (steps[0] !== 5000) throw new Error(`step 0 expected 5000, got ${steps[0]}`);
  if (steps[steps.length - 1] > 25_000) {
    throw new Error(`last step exceeds cap: ${steps[steps.length - 1]}`);
  }
  for (let i = 1; i < steps.length; i++) {
    if (steps[i] <= steps[i - 1]) {
      throw new Error(`step ${i} (${steps[i]}) must exceed step ${i - 1} (${steps[i - 1]})`);
    }
  }
});

test("expandSteps: floors at MIN_RADIUS_M even for tiny directM", () => {
  const steps = expandSteps(50, { maxRadiusM: 5000 });
  if (steps[0] < MIN_RADIUS_M) {
    throw new Error(`step 0 below floor: ${steps[0]}`);
  }
});

test("expandSteps: for 50 km line generates several reasonable steps", () => {
  // Beylikdüzü ↔ Kartal: 50 km line, base = 25 km.
  // Steps: 25km, 37.5km, capped at 50km. Three steps total.
  const steps = expandSteps(50_000);
  if (steps.length < 2) throw new Error(`expected ≥ 2 steps, got ${steps.length}`);
  if (steps[0] < 20_000 || steps[0] > 30_000) {
    throw new Error(`first step should be ~25km, got ${steps[0]}`);
  }
});

console.log("\n== end-to-end sanity: typical user input ==");

test("Taksim → Kadıköy (~6 km) → base ~3 km, mid in Bosphorus", () => {
  // Taksim (41.037, 28.985) → Kadıköy (40.992, 29.025).
  // directM ≈ 6.0 km; base = max(1500, 3000) = 3000m.
  const taksim = { lat: 41.037, lon: 28.985 };
  const kadikoy = { lat: 40.992, lon: 29.025 };
  const m = midpoint(taksim, kadikoy);
  const directM = haversine(taksim, kadikoy);
  const base = baseRadiusFor(directM);
  if (base < 2500 || base > 3500) {
    throw new Error(`expected base ~3km, got ${base}`);
  }
  // Midpoint sits in the Bosphorus area (~41.01, 29.00).
  if (m.lat < 40.99 || m.lat > 41.04) {
    throw new Error(`mid lat should be ~41.01 (Bosphorus), got ${m.lat}`);
  }
});

test("Kadıköy → Kartal (~18 km across sea) → base ~9 km, mid in Marmara", () => {
  const kadikoy = { lat: 40.992, lon: 29.025 };
  const kartal  = { lat: 40.890, lon: 29.190 };
  const m = midpoint(kadikoy, kartal);
  const directM = haversine(kadikoy, kartal);
  const base = baseRadiusFor(directM);
  if (base < 8000 || base > 10000) {
    throw new Error(`expected base ~9km, got ${base}`);
  }
  // Midpoint is over the Marmara sea (~lat 40.94, lon 29.10).
  if (m.lat > 40.96 || m.lat < 40.92) {
    throw new Error(`mid lat should be ~40.94 (Marmara sea), got ${m.lat}`);
  }
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);