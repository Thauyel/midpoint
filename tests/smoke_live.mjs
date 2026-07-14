// quick smoke: real Nominatim + Photon + OSRM calls against the deployed
// `/api/*` proxies. Run with:  node tests/smoke_live.mjs
// Skipped automatically if --skip-live flag is present.

import { geocode } from "../js/geocode.js";
import { findPlacesInCircle } from "../js/places.js";
import { osrmTable } from "../js/routing.js";
import { midpoint } from "../js/midpoint.js";

const skipLive = process.argv.includes("--skip-live");

if (skipLive) {
  console.log("skipped (--skip-live)");
  process.exit(0);
}

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
const a = await check("geocode Taksim", () => geocode("Taksim, Istanbul, Turkey"));
const b = await check("geocode Kadıköy", () => geocode("Kadıköy, Istanbul, Turkey"));

if (a && b) {
  const mid = midpoint(a, b);
  const cafes = await check("find cafes inside the midpoint circle", () =>
    findPlacesInCircle(mid, ["cafe"], 3000)
  );
  if (cafes && cafes.length > 0) {
    console.log(`  ${cafes.length} cafes inside 3km circle around midpoint`);
    const top3 = cafes.slice(0, 3);
    const r = await check("OSRM /table ETA from A, B to top-3 cafes", () =>
      osrmTable([a, b], top3.map((c) => [c.lon, c.lat]))
    );
    if (r) {
      console.log("  ETAs (from A → from B):");
      for (let i = 0; i < top3.length; i++) {
        const ea = r.durations?.[0]?.[i];
        const eb = r.durations?.[1]?.[i];
        const f = (s) => (Number.isFinite(s) && s > 0 ? `${(s / 60).toFixed(1)} min` : "—");
        console.log(`     • ${top3[i].name}: ${f(ea)} / ${f(eb)}`);
      }
    }
  }
}

console.log(`\n${failed === 0 ? "✓ all live calls OK" : `✗ ${failed} failure(s)`}`);
process.exit(failed === 0 ? 0 : 1);
