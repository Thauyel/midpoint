// ============================================================
//  places.js  --  POI search around a single midpoint circle
//
//  v4: clean circle-from-midpoint algorithm. One circle, one radius.
//  Photon is the primary source (CORS-friendly, no rate limit).
//  Nominatim is the fallback.
// ============================================================

import { expandSteps } from "./midpoint.js?v=43";

// Browser-like headers. Nominatim requires identification; the rest is
// for parity with real browser traffic so we don't trip rate-limiters.
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Referer": "https://www.openstreetmap.org/",
  "Origin": "https://www.openstreetmap.org",
  "Sec-Fetch-Site": "cross-site",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Dest": "empty",
};

const PHOTON_ENDPOINT = "/api/photon";
const NOMINATIM_ENDPOINT = "/api/nominatim";

// ---------- Photon POI search (primary) ----------
//
// Photon (https://photon.komoot.io) is Komoot's open-source geocoder
// built on OpenStreetMap data. It is CORS-friendly, has no rate limit,
// and is much faster than Nominatim. Returns GeoJSON FeatureCollection
// where each feature has properties.osm_key/osm_value, geometry.coords
// [lon, lat], and a name property.

const CATEGORY_OSM = {
  cafe:       ["amenity:cafe"],
  restaurant: ["amenity:restaurant", "amenity:fast_food", "amenity:food_court"],
  bar:        ["amenity:bar", "amenity:pub", "amenity:biergarten"],
  park:       ["leisure:park", "leisure:garden", "leisure:plaza"],
  generic:    [],
};

function photonFilters(categories) {
  const seen = new Set();
  const out = [];
  for (const c of categories) {
    for (const kv of (CATEGORY_OSM[c] || CATEGORY_OSM.generic)) {
      if (!seen.has(kv)) { seen.add(kv); out.push(kv); }
    }
  }
  return out;
}

function inferCategoryFromPhoton(hit, requested) {
  const props = hit.properties || {};
  const key = props.osm_key;
  const value = props.osm_value;
  if (key === "amenity" && value === "cafe") return "cafe";
  if (key === "amenity" && (value === "restaurant" || value === "fast_food" || value === "food_court")) return "restaurant";
  if (key === "amenity" && (value === "bar" || value === "pub" || value === "biergarten")) return "bar";
  if (key === "leisure" && (value === "park" || value === "garden" || value === "plaza")) return "park";
  for (const c of requested) if (c === "cafe" || c === "restaurant" || c === "bar" || c === "park") return c;
  return requested[0] || "generic";
}

async function photonPoiSearch(mid, categories, radiusM, signal) {
  // Photon's API accepts exactly one `osm_tag` per request. With multiple
  // categories we MUST issue one request per category (each with its own
  // osm_tag precision filter) in parallel, then merge. The previous
  // "single combined q text query" approach returned noisy global chain
  // restaurants instead of local POIs -- verified by live curl tests.
  const filters = photonFilters(categories);

  async function fetchOne(qq, osmTag) {
    const url = new URL(PHOTON_ENDPOINT, location.origin);
    url.searchParams.set("q", qq);
    url.searchParams.set("lat", String(mid.lat));
    url.searchParams.set("lon", String(mid.lon));
    // Photon's location_bias_scale default of 0.2 pulls results from
    // hundreds of km away. 0.1 keeps POIs local to the endpoint.
    url.searchParams.set("location_bias_scale", "0.1");
    url.searchParams.set("limit", "30");
    url.searchParams.set("zoom", "15");
    if (osmTag) url.searchParams.set("osm_tag", osmTag);
    try {
      const res = await fetch(url, {
        headers: { "Accept": "application/json" },
        signal,
      });
      if (!res.ok) return [];
      const data = await res.json();
      const features = Array.isArray(data?.features) ? data.features : [];
      const out = [];
      for (const f of features) {
        const [lon, lat] = f.geometry?.coordinates || [];
        const props = f.properties || {};
        const name = props.name;
        if (!name || !isFinite(lat) || !isFinite(lon)) continue;
        // With osmTag set on the request, Photon guarantees
        // osm_key+osm_value match. But some features still slip through
        // (e.g. suburb place=suburb with name containing 'cafe'). Tighten
        // to only matching osm_key+osm_value when filters present.
        if (osmTag) {
          const [k, v] = osmTag.split(":");
          if (props.osm_key !== k || props.osm_value !== v) continue;
        }
        // Distance filter: drop anything farther than 2x the radius.
        // Real geography can drift ~30% off a straight line; 2x leaves
        // headroom for cafes across a fjord.
        const dlat = (lat - mid.lat) * 111000;
        const dlon = (lon - mid.lon) * 111000 * Math.cos((mid.lat * Math.PI) / 180);
        const distM = Math.sqrt(dlat * dlat + dlon * dlon);
        if (distM > radiusM * 2) continue;
        out.push({
          id: `photon/${props.osm_type || "n"}/${props.osm_id || `${lat},${lon}`}`,
          name,
          lat,
          lon,
          category: inferCategoryFromPhoton(f, categories),
          tags: props,
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  // Build per-category requests. Each gets its own osm_tag filter so
  // Photon returns precise local POIs for that exact category.
  const tasks = filters.map((osmTag) => {
    // The "q" is just the textual hint; osm_tag is the precision filter.
    const q = osmTag.split(":")[1] || osmTag;
    return fetchOne(q, osmTag);
  });
  // Photon (and our proxy) rate-limit per-IP. We've seen 5+ concurrent
  // requests work fine; cap at 4 to stay under any per-second caps.
  const POOL = 4;
  const chunks = [];
  for (let i = 0; i < tasks.length; i += POOL) chunks.push(tasks.slice(i, i + POOL));
  const all = [];
  for (const chunk of chunks) {
    if (signal?.aborted) break;
    const lists = await Promise.all(chunk);
    for (const list of lists) all.push(...list);
  }
  // Dedupe by 5dp lat/lon (the single-request path already dedupes
  // within itself; this catches the same cafe returned for overlapping
  // osm_tags like amenity:restaurant and amenity:fast_food).
  const out = [];
  const seen = new Set();
  for (const p of all) {
    const k = `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

// ---------- Nominatim POI fallback ----------
//
// Photon can occasionally be down. As a last resort we fall back to
// Nominatim with strict rate-limit-aware throttling.

const CATEGORY_QUERIES = {
  cafe:       ["cafe", "coffee"],
  restaurant: ["restaurant", "fast food"],
  bar:        ["bar", "pub"],
  park:       ["park", "garden"],
  generic:    ["cafe", "restaurant", "bar", "pub", "park"],
};

function makeNominatimQueries(categories) {
  const seen = new Set();
  const out = [];
  for (const c of categories) {
    for (const q of (CATEGORY_QUERIES[c] || CATEGORY_QUERIES.generic)) {
      if (!seen.has(q)) { seen.add(q); out.push(q); }
    }
  }
  return out;
}

function buildViewbox(mid, radiusM) {
  const dLat = radiusM / 111000;
  const dLon = radiusM / (111000 * Math.cos((mid.lat * Math.PI) / 180));
  const left   = mid.lon - dLon;
  const right  = mid.lon + dLon;
  const top    = mid.lat + dLat;
  const bottom = mid.lat - dLat;
  return `${left.toFixed(5)},${top.toFixed(5)},${right.toFixed(5)},${bottom.toFixed(5)}`;
}

async function nominatimPoiSearch(mid, categories, radiusM, signal) {
  const queries = makeNominatimQueries(categories);
  const viewbox = buildViewbox(mid, radiusM);
  const tasks = queries.map(async (q) => {
    if (signal?.aborted) return [];
    const url = new URL(NOMINATIM_ENDPOINT, location.origin);
    url.searchParams.set("q", q);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "20");
    url.searchParams.set("viewbox", viewbox);
    url.searchParams.set("bounded", "1");
    url.searchParams.set("addressdetails", "0");
    try {
      let res = await fetch(url, {
        headers: { ...BROWSER_HEADERS, "Accept": "application/json" },
        signal,
      });
      // Nominatim rate-limits with 429s. We give it ONE retry after a
      // fixed backoff (the public proxy also retries once upstream).
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 1100));
        res = await fetch(url, {
          headers: { ...BROWSER_HEADERS, "Accept": "application/json" },
          signal,
        });
      }
      if (!res.ok) return [];
      const data = await res.json();
      const hits = [];
      for (const hit of data) {
        const lat = parseFloat(hit.lat);
        const lon = parseFloat(hit.lon);
        const name = (hit.display_name || "").split(",")[0].trim();
        if (!name || !isFinite(lat) || !isFinite(lon)) continue;
        hits.push({ name, lat, lon, hit });
      }
      return hits;
    } catch {
      return [];
    }
  });
  // Browsers cap concurrent requests per origin at ~6. We process at
  // most 3 at a time to stay comfortably below the cap.
  const PARALLEL = 3;
  const allHits = [];
  for (let i = 0; i < tasks.length; i += PARALLEL) {
    if (signal?.aborted) break;
    const chunk = await Promise.all(tasks.slice(i, i + PARALLEL));
    allHits.push(...chunk.flat());
  }
  const results = [];
  const seen = new Set();
  for (const { name, lat, lon, hit } of allHits) {
    const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      id: `nominatim/${hit.osm_type || "n"}/${hit.osm_id || key}`,
      name,
      lat,
      lon,
      category: inferCategoryFromClass(hit, categories),
      tags: {},
    });
  }
  return results;
}

function inferCategoryFromClass(hit, requested) {
  const cls = (hit.class || "").toLowerCase();
  const typ = (hit.type || "").toLowerCase();
  if (cls === "amenity" && typ === "cafe") return "cafe";
  if (cls === "amenity" && (typ === "restaurant" || typ === "fast_food" || typ === "food_court")) return "restaurant";
  if (cls === "amenity" && (typ === "bar" || typ === "pub" || typ === "biergarten")) return "bar";
  if (cls === "leisure" && (typ === "park" || typ === "garden")) return "park";
  for (const c of requested) {
    if (CATEGORY_QUERIES[c]?.some(q => (hit.display_name || "").toLowerCase().includes(q))) return c;
  }
  return requested[0] || "generic";
}

/**
 * Query POIs in a single circle around `mid` with radius `radiusM`.
 * Returns [{ id, name, lat, lon, category, tags }] deduplicated by ~30m.
 * Tries Photon first (fast, CORS-friendly), Nominatim as fallback.
 * `signal` is an AbortSignal to cancel in-flight requests.
 */
export async function findPlacesInCircle(mid, categories, radiusM, { signal } = {}) {
  if (!mid || !Array.isArray(categories) || categories.length === 0) return [];
  let places = await photonPoiSearch(mid, categories, radiusM, signal);
  if (places.length === 0) {
    places = await nominatimPoiSearch(mid, categories, radiusM, signal);
  }
  // Dedupe by ~30m proximity (Photon and Nominatim can both return the
  // same cafe twice with slightly different coordinates).
  const out = [];
  const seen = [];
  for (const p of places) {
    const dupe = seen.some(
      (q) => Math.abs(q.lat - p.lat) < 0.0003 && Math.abs(q.lon - p.lon) < 0.0003
    );
    if (!dupe) {
      seen.push(p);
      out.push(p);
    }
  }
  return out;
}

/**
 * Run the v4 circle-from-midpoint algorithm.
 *
 * 1. Compute `mid = midpoint(A, B)` and `directM = haversine(A, B)`.
 * 2. Start at radius `baseRadiusFor(directM)` (the fair-zone boundary).
 * 3. If too few places, expand the radius geometrically (×1.5 per step)
 *    up to `maxRadiusFor(directM)` and try again.
 * 4. Return the union of places found across all radii, deduplicated.
 *
 * The caller (app.js) handles the OSRM ETA matrix and ranking. This
 * function is intentionally narrow: just give me the places that live
 * inside an expanding circle around the midpoint.
 */
export async function findPlacesAlways(mid, categories, directM, {
  signal, minResults = 5,
} = {}) {
  const steps = expandSteps(directM, { maxSteps: 6 });
  const all = [];
  const seen = []; // for ~30m dedup

  for (const radiusM of steps) {
    if (signal?.aborted) break;
    const more = await findPlacesInCircle(mid, categories, radiusM, { signal });
    for (const p of more) {
      const dupe = seen.some(
        (q) => Math.abs(q.lat - p.lat) < 0.0003 && Math.abs(q.lon - p.lon) < 0.0003
      );
      if (!dupe) {
        seen.push(p);
        all.push(p);
      }
    }
    // Stop as soon as we have enough.
    if (all.length >= minResults) break;
  }
  return all;
}

// Clear internal caches (none currently but exposed for API symmetry).
export function clearCache() {}
