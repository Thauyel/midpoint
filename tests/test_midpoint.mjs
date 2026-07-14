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
  rankByFairnessFirst,
  rankByMidpointDistance,
  rankByFairestFromMid,
  rankByTotalDrive,
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
  projectOntoAxis,
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

test("rankByMidpointDistance sorts by distance to midpoint ascending", () => {
  const mid = { lat: 41.0, lon: 29.0 };
  // Place near midpoint
  const near = { lat: 41.001, lon: 29.001, eta_a_s: 900, eta_b_s: 900 };
  // Place on the geographic far side
  const far  = { lat: 41.05, lon: 29.05,  eta_a_s: 600, eta_b_s: 600 };
  const ranked = rankByMidpointDistance([far, near], mid);
  if (ranked[0].lat !== near.lat) {
    throw new Error(`expected "near" first (closer to mid), got ${JSON.stringify(ranked[0])}`);
  }
});

test("rankByMidpointDistance breaks ties by fairness when distances are equal", () => {
  const mid = { lat: 41.0, lon: 29.0 };
  // Two places at the SAME distance from mid -- one fair, one unfair
  const fair =   { lat: 41.01, lon: 29.0, eta_a_s: 600, eta_b_s: 600 };
  const unfair = { lat: 41.01, lon: 29.0, eta_a_s: 300, eta_b_s: 900 };
  // To make sure they have ~equal distance, mirror coords: use the same point twice
  const ranked = rankByMidpointDistance([unfair, { ...fair }], mid);
  if (ranked[0].eta_a_s !== fair.eta_a_s) {
    throw new Error(`expected fair tie-breaker to win, got ${JSON.stringify(ranked[0])}`);
  }
});

test("rankByTotalDrive sorts by total ascending", () => {
  const fast = { eta_a_s: 300, eta_b_s: 300 };  // total 600
  const slow = { eta_a_s: 900, eta_b_s: 900 };  // total 1800
  const ranked = rankByTotalDrive([slow, fast]);
  if (ranked[0].eta_a_s !== fast.eta_a_s) {
    throw new Error(`expected fast first, got ${JSON.stringify(ranked[0])}`);
  }
});

test("rankByFairnessFirst places a fair point ahead of an unfair one even if total is longer", () => {
  const a = { eta_a_s: 900, eta_b_s: 900 };  // fair, total 1800
  const b = { eta_a_s: 700, eta_b_s: 700 };  // also fair, total 1400
  const c = { eta_a_s: 200, eta_b_s: 800 };  // |Δ|=600 (unfair)
  const ranked = rankByFairnessFirst([c, b, a]);
  if (ranked[0] === c || ranked[2] === c) {
    throw new Error(`expected c (unfair) last, got order [${ranked.map(r => r.eta_a_s).join(", ")}]`);
  }
});

console.log("\n== rankByFairestFromMid (default sort) ==");

test("rankByFairestFromMid prefers fair places, with closeness-to-mid as tiebreaker", () => {
  const mid = { lat: 41.0, lon: 29.0 };
  // Both ~same distance from M, but one is fair and one is unfair.
  // The fair one should win despite identical distance-to-mid.
  const fairNear   = { lat: 41.005, lon: 29.005, eta_a_s: 900, eta_b_s: 900 };  // fair, |Δ|=0
  const unfairNear = { lat: 41.005, lon: 29.005, eta_a_s: 200, eta_b_s: 800 };  // 600s from same spot
  const ranked = rankByFairestFromMid([unfairNear, fairNear], mid);
  if (ranked[0].eta_a_s !== 900) {
    throw new Error(`expected fair first (with Δ=0), got ${JSON.stringify(ranked[0])}`);
  }
});

test("rankByFairestFromMid falls back to dist-to-mid when no ETAs", () => {
  // The default ranker must still work even if candidates don't carry ETAs
  // (the OSRM call might have failed for some or all of them).
  const mid = { lat: 41.0, lon: 29.0 };
  const near = { lat: 41.001, lon: 29.001 };
  const far  = { lat: 41.05,  lon: 29.05 };
  const ranked = rankByFairestFromMid([far, near], mid);
  if (ranked[0].lat !== near.lat) {
    throw new Error(`expected near first when no ETAs, got ${JSON.stringify(ranked[0])}`);
  }
});

test("rankByFairestFromMid breaks fairness ties by closeness-to-mid", () => {
  const mid = { lat: 41.0, lon: 29.0 };
  // Two equally fair places, one near M and one far.
  // The near one should win.
  const fairFar  = { lat: 41.10, lon: 29.10, eta_a_s: 600, eta_b_s: 600 };  // 14km away, fair
  const fairNear = { lat: 41.01, lon: 29.01, eta_a_s: 600, eta_b_s: 600 };  // 1.4km away, fair
  const ranked = rankByFairestFromMid([fairFar, fairNear], mid);
  if (ranked[0].lat !== fairNear.lat) {
    throw new Error(`expected near-and-fair first when both are equally fair, got ${JSON.stringify(ranked[0])}`);
  }
});

test("rankByFairestFromMid does NOT prefer a closer-to-mid but highly-unfair place", () => {
  // The bug we're fixing: an unfair place 1km from M beating a fair place 5km from M.
  const mid = { lat: 41.0, lon: 29.0 };
  const nearUnfair = { lat: 41.001, lon: 29.001, eta_a_s: 60, eta_b_s: 1740 };  // near M, very unfair
  const farFair    = { lat: 41.05,  lon: 29.05,  eta_a_s: 600, eta_b_s: 600 }; // far from M, perfectly fair
  const ranked = rankByFairestFromMid([nearUnfair, farFair], mid);
  // The far-but-fair one wins (rankByFairestFromMid prioritises fairness).
  if (ranked[0].lat !== farFair.lat) {
    throw new Error(`expected far-but-fair to beat near-but-unfair, got ${JSON.stringify(ranked[0])}`);
  }
});

test("rankByFairestFromMid returns original candidates (stable) when ETAs available", () => {
  const mid = { lat: 41.0, lon: 29.0 };
  const c1 = { lat: 41.0, lon: 29.0, eta_a_s: 600, eta_b_s: 600, _idx: 0 };
  const c2 = { lat: 41.01, lon: 29.01, eta_a_s: 600, eta_b_s: 600, _idx: 1 };
  const ranked = rankByFairestFromMid([c1, c2], mid);
  if (ranked.length !== 2) throw new Error(`expected 2 candidates back, got ${ranked.length}`);
  if (!("_idx" in ranked[0])) throw new Error(`expected _idx preserved for stable sort`);
});

console.log("\n== projectOntoAxis ==");

test("projectOntoAxis: point exactly ON A->B line has perpM ≈ 0", () => {
  const a = { lat: 41.0, lon: 29.0 };
  const b = { lat: 41.05, lon: 29.05 };
  // midpoint between a and b - should have perpM ≈ 0
  const mid = { lat: 41.025, lon: 29.025 };
  const proj = projectOntoAxis(a, b, mid);
  if (proj.perpM > 1) throw new Error(`expected perpM ≈ 0 for point on line, got ${proj.perpM}`);
});

test("projectOntoAxis: point perpendicular 1km off the line has perpM ≈ 1000", () => {
  const a = { lat: 41.0, lon: 29.0 };
  const b = { lat: 41.0, lon: 29.06 };   // due east line (lon increases, lat constant)
  // 0.009° = ~1km due north of a point on the line -- perpendicular to the line
  const onLine = { lat: 41.0, lon: 29.03 };
  const offAxis = { lat: 41.009, lon: 29.03 };
  const proj = projectOntoAxis(a, b, offAxis);
  if (Math.abs(proj.perpM - 1000) > 50) {
    throw new Error(`expected perpM ≈ 1000m, got ${proj.perpM.toFixed(0)}`);
  }
});

test("projectOntoAxis: alongM is signed correctly (negative in front of A, positive beyond B)", () => {
  const a = { lat: 41.0, lon: 29.0 };
  const b = { lat: 41.05, lon: 29.05 };
  // 0.005° behind A (so alongM is negative)
  const behind = { lat: 40.995, lon: 28.995 };
  const ahead = { lat: 41.055, lon: 29.055 };
  const p1 = projectOntoAxis(a, b, behind);
  const p2 = projectOntoAxis(a, b, ahead);
  if (p1.alongM >= 0) throw new Error(`expected behind-AlongM negative, got ${p1.alongM}`);
  if (p2.alongM <= 0) throw new Error(`expected ahead-AlongM positive, got ${p2.alongM}`);
});

test("projectOntoAxis: degenerate (a == b) returns finite perpM", () => {
  const a = { lat: 41.0, lon: 29.0 };
  const b = { lat: 41.0, lon: 29.0 };  // same point - degenerate
  const p = { lat: 41.01, lon: 29.01 };
  const proj = projectOntoAxis(a, b, p);
  if (!Number.isFinite(proj.perpM)) {
    throw new Error(`expected finite perpM for degenerate a==b, got ${proj.perpM}`);
  }
});

test("rankByFairestFromMid with axis projection: on-axis fair beats off-axis slightly unfair", () => {
  // The new axis-aware tiebreaker: a place on the A->B line with
  // |Δ|=60s should beat a place equally fair (|Δ|=0) but 2km off-axis.
  // 2km off-axis = 1000s of fairness bonus, so off-axis needs
  // |Δ| < 1000s to beat on-axis with |Δ|=60s. Both candidates
  // satisfy that, so on-axis should win.
  const a = { lat: 41.0, lon: 29.0 };
  const b = { lat: 41.0, lon: 29.06 };   // due east line
  const mid = { lat: 41.0, lon: 29.03 };
  // On-axis place: midpoint area
  const onAxis = { lat: 41.0, lon: 29.03, eta_a_s: 900, eta_b_s: 960 };  // Δ=60
  // Off-axis place but very fair: 2km north of midpoint
  const offAxis = { lat: 41.018, lon: 29.03, eta_a_s: 900, eta_b_s: 900 };  // Δ=0, ~2km off
  const ranked = rankByFairestFromMid([offAxis, onAxis], mid, a, b);
  if (ranked[0].lat !== onAxis.lat) {
    throw new Error(`expected on-axis to win despite worse |Δ|, got ${JSON.stringify(ranked[0])}`);
  }
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);