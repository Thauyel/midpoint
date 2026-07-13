// ============================================================
//  tests/test_midpoint.mjs
//  Tiny zero-dep test runner. Runs in plain node:
//      node tests/test_midpoint.mjs
// ============================================================

import {
  haversine,
  midpoint,
  fmtEta,
  fmtDist,
  rankByFairness,
  isFair,
  haversineEta,
  lerpLatLon,
  sampleAlongLine,
  searchAnchors,
  bearing,
  offsetPoint,
  corridorAnchors,
  tangentChordAnchors,
  expandingAnchors,
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
  // Real value ~350.4 km. Allow 1% slack.
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
  // Expected ~ (40.47, 30.92)
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

console.log("\n== rankByFairness ==");

test("ranks by total time ascending", () => {
  const ranked = rankByFairness([
    { name: "slow", eta_a_s: 1200, eta_b_s: 1200 },
    { name: "fast", eta_a_s: 300,  eta_b_s: 300  },
    { name: "mid",  eta_a_s: 600,  eta_b_s: 600  },
  ]);
  eq(ranked.map((r) => r.name), ["fast", "mid", "slow"]);
});

test("tiebreaker is fairness (smaller |Δ| wins)", () => {
  const ranked = rankByFairness([
    { name: "unfair", eta_a_s: 500, eta_b_s: 700 }, // total 1200, Δ 200
    { name: "fair",   eta_a_s: 600, eta_b_s: 600 }, // total 1200, Δ 0
  ]);
  eq(ranked.map((r) => r.name), ["fair", "unfair"]);
});

test("does not mutate input", () => {
  const input = [
    { name: "c", eta_a_s: 900, eta_b_s: 100 },
    { name: "a", eta_a_s: 100, eta_b_s: 900 },
    { name: "b", eta_a_s: 500, eta_b_s: 500 },
  ];
  const before = JSON.stringify(input);
  rankByFairness(input);
  const after = JSON.stringify(input);
  if (before !== after) throw new Error("input array was mutated");
});

console.log("\n== isFair ==");

test("isFair true for |Δ| <= 5min", () => {
  if (!isFair({ eta_a_s: 600, eta_b_s: 900 })) throw new Error("300s Δ should be fair");
  if (!isFair({ eta_a_s: 600, eta_b_s: 600 }))  throw new Error("0 Δ should be fair");
});

test("isFair false for |Δ| > 5min", () => {
  if (isFair({ eta_a_s: 600, eta_b_s: 901 })) throw new Error("301s Δ should be unfair");
});

console.log("\n== sampling helpers ==");

test("lerpLatLon midpoint at t=0.5", () => {
  const a = { lat: 40.992, lon: 29.025 };
  const b = { lat: 40.888, lon: 29.184 };
  const m = lerpLatLon(a, b, 0.5);
  if (Math.abs(m.lat - 40.940) > 0.001) throw new Error(`lat off: ${m.lat}`);
  if (Math.abs(m.lon - 29.1045) > 0.001) throw new Error(`lon off: ${m.lon}`);
});

test("sampleAlongLine returns n points strictly inside (0,1)", () => {
  const a = { lat: 0, lon: 0 };
  const b = { lat: 10, lon: 10 };
  const pts = sampleAlongLine(a, b, 5);
  if (pts.length !== 5) throw new Error(`expected 5, got ${pts.length}`);
  for (const p of pts) {
    if (p.lat < 0 || p.lat > 10) throw new Error(`lat out of range: ${p.lat}`);
    if (p.lon < 0 || p.lon > 10) throw new Error(`lon out of range: ${p.lon}`);
  }
});

test("searchAnchors dedupes points within 50m", () => {
  const a = { lat: 40.992, lon: 29.025 };
  const b = { lat: 40.888, lon: 29.184 };
  const anchors = searchAnchors(a, b, 5);
  if (anchors.length > 8) throw new Error(`too many anchors: ${anchors.length}`);
  for (let i = 0; i < anchors.length; i++) {
    for (let j = i+1; j < anchors.length; j++) {
      if (haversine(anchors[i], anchors[j]) < 50) {
        throw new Error(`anchors ${i},${j} too close: ${haversine(anchors[i], anchors[j])}m`);
      }
    }
  }
});

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

test("corridorAnchors produces 2n points", () => {
  const a = { lat: 40.992, lon: 29.025 };
  const b = { lat: 40.888, lon: 29.184 };
  const c = corridorAnchors(a, b, 5, 600);
  if (c.length !== 10) throw new Error(`expected 10, got ${c.length}`);
});

console.log("\n== tangent chord ==");

test("tangentChordAnchors produces 4n points", () => {
  const a = { lat: 40.992, lon: 29.025 };
  const b = { lat: 40.888, lon: 29.184 };
  const r = 5000;
  const c = tangentChordAnchors(a, b, r, 5);
  // 5 line samples × 4 points each (offset +r, offset -r, r*0.4, -r*0.4)
  if (c.length !== 20) throw new Error(`expected 20, got ${c.length}`);
});

test("tangent chord points are equidistant from A and B", () => {
  // For two circles of equal radius r centred at A and B, the tangent
  // chord points sit on a line perpendicular to A→B at distance r from
  // the line AB. They should be roughly equidistant from A and B.
  const a = { lat: 41.0, lon: 29.0 };
  const b = { lat: 41.0, lon: 29.1 };  // 10km east of A
  const r = 5000;
  const chord = tangentChordAnchors(a, b, r, 1);
  // The offset=200 points should be roughly equidistant (small inset).
  for (const p of chord) {
    const dA = haversine(a, p);
    const dB = haversine(b, p);
    if (Math.abs(dA - dB) > 100) {
      throw new Error(`not equidistant: dA=${dA} dB=${dB} point=${JSON.stringify(p)}`);
    }
  }
});

test("expandingAnchors produces N anchors with growing radius", () => {
  const mid = { lat: 40.94, lon: 29.10 };
  const anchors = expandingAnchors(mid, 2000, 1500, 5);
  if (anchors.length !== 5) throw new Error(`expected 5, got ${anchors.length}`);
  if (anchors[0]._r !== 2000) throw new Error(`first radius ${anchors[0]._r}`);
  if (anchors[4]._r !== 8000) throw new Error(`last radius ${anchors[4]._r}`);
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

console.log("\n== ranking ==");

test("rankByFairness prefers small |Δ| when totals are equal", () => {
  const a = { eta_a_s: 900, eta_b_s: 900 };
  const b = { eta_a_s: 800, eta_b_s: 1000 };
  const ranked = rankByFairness([b, a]);
  // rankByFairness returns new objects (spread) so compare eta fields
  if (ranked[0].eta_a_s !== 900 || ranked[0].eta_b_s !== 900) {
    throw new Error(`expected a first, got ${JSON.stringify(ranked[0])}`);
  }
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);