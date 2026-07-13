// quick smoke: real Nominatim + OSRM + Overpass calls.
// Run with:  node tests/smoke_live.mjs
// Skipped automatically if --skip-live flag is present.

import { geocode } from "../js/geocode.js";
import { findPlaces } from "../js/places.js";
import { osrmTable } from "../js/routing.js";

const skipLive = process.argv.includes("--skip-live");

if (skipLive) {
  console.log("skipped (--skip-live)");
  process.exit(0);
}

const results = { geocode: null, places: null, routing: null };
let failed = 0;

const check = async (name, fn) => {
  process.stdout.write(`  ${name} … `);
  try {
    const r = await fn();
    console.log("OK");
    return r;
  } catch (e) {
    failed++;
    console.log("FAIL —", e.message);
    return null;
  }
};

console.log("== live smoke ==\n");

// Taksim + Kadıköy — two well-known Istanbul landmarks.
results.geocode = await check("geocode Taksim", () => geocode("Taksim, Istanbul, Turkey"));
results.geocode_b = await check("geocode Kadıköy", () => geocode("Kadıköy, Istanbul, Turkey"));

if (results.geocode && results.geocode_b) {
  const mid = {
    lat: (results.geocode.lat + results.geocode_b.lat) / 2,
    lon: (results.geocode.lon + results.geocode_b.lon) / 2,
  };
  console.log(`  midpoint ≈ ${mid.lat.toFixed(4)}, ${mid.lon.toFixed(4)}`);

  results.places = await check("find cafes near midpoint", () =>
    findPlaces(mid, ["cafe"], 2000)
  );

  if (results.places && results.places.length > 0) {
    console.log(`  ${results.places.length} candidates`);
    const top3 = results.places.slice(0, 3);
    console.log("    sample:");
    for (const c of top3) console.log(`     • ${c.name} (${c.category})`);

    results.routing = await check("OSRM /table", () =>
      osrmTable(
        [results.geocode, results.geocode_b],
        top3.map((c) => [c.lon, c.lat])
      )
    );

    if (results.routing) {
      console.log("  ETAs (A→, B→):");
      for (let i = 0; i < top3.length; i++) {
        const a = results.routing.durations[0][i];
        const b = results.routing.durations[1][i];
        const aFmt = a != null ? `${(a / 60).toFixed(1)} min` : "—";
        const bFmt = b != null ? `${(b / 60).toFixed(1)} min` : "—";
        console.log(`     • ${top3[i].name}: ${aFmt} / ${bFmt}`);
      }
    }
  }
}

console.log(`\n${failed === 0 ? "✓ all live calls OK" : `✗ ${failed} failure(s)`}`);
process.exit(failed === 0 ? 0 : 1);