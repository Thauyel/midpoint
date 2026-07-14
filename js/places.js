// ============================================================
//  places.js  --  POI search around a single midpoint circle
//
//  v4: clean circle-from-midpoint algorithm. One circle, one radius,
//  progressive expansion if too few places found. Photon is the primary
//  source (CORS-friendly, no rate limit). Nominatim is the fallback.
// ============================================================

import { expandSteps } from "./midpoint.js?v=41";

// Browser-like headers. Overpass-API.de and other OSM endpoints on the public
// internet are aggressive about User-Agent / Origin / Referer. Real browsers
// always send these, so we mirror that.
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

const ENDPOINTS = [
  // All Overpass queries now route through the Vercel serverless proxy
  // (/api/overpass), which fans out to the public mirrors server-to-server.
  // This sidesteps both CORS and the browser-rate-limit problem entirely.
  "/api/overpass",
];

const MAX_ATTEMPTS = 2;
const BASE_BACKOFF_MS = 600;
// Per-endpoint hard timeout (ms). The public Overpass mirrors are sometimes
// pathologically slow (30s+ before any response) -- we'd rather fail fast
// and try the next mirror.
const ENDPOINT_TIMEOUT_MS = 8000;

const cache = new Map();
const inflight = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Map our category names → Overpass tag filters. OSM tags are messy
// and category boundaries blur; we over-include rather than under-include.
const CAT_FILTERS = {
  cafe: `
    node["amenity"="cafe"](around:{R},{LAT},{LON});
    way["amenity"="cafe"](around:{R},{LAT},{LON});
  `,
  restaurant: `
    node["amenity"="restaurant"](around:{R},{LAT},{LON});
    way["amenity"="restaurant"](around:{R},{LAT},{LON});
    node["amenity"="fast_food"](around:{R},{LAT},{LON});
    way["amenity"="fast_food"](around:{R},{LAT},{LON});
  `,
  bar: `
    node["amenity"="bar"](around:{R},{LAT},{LON});
    way["amenity"="bar"](around:{R},{LAT},{LON});
    node["amenity"="pub"](around:{R},{LAT},{LON});
    way["amenity"="pub"](around:{R},{LAT},{LON});
  `,
  park: `
    node["leisure"="park"](around:{R},{LAT},{LON});
    way["leisure"="park"](around:{R},{LAT},{LON});
    node["leisure"="garden"](around:{R},{LAT},{LON});
    way["leisure"="garden"](around:{R},{LAT},{LON});
    relation["leisure"="park"](around:{R},{LAT},{LON});
  `,
  generic: `
    node["amenity"~"cafe|restaurant|bar|pub|fast_food|biergarten|food_court|ice_cream|bakery"](around:{R},{LAT},{LON});
    way["amenity"~"cafe|restaurant|bar|pub|fast_food|biergarden|food_court|ice_cream|bakery"](around:{R},{LAT},{LON});
    node["leisure"~"park|garden|plaza"](around:{R},{LAT},{LON});
    way["leisure"~"park|garden|plaza"](around:{R},{LAT},{LON});
  `,
};

function buildQuery(mid, categories, radiusM) {
  const parts = categories.map((c) => CAT_FILTERS[c] || CAT_FILTERS.generic).join("\n    ");
  const block = parts
    .replaceAll("{R}", String(Math.min(radiusM, 5000)))
    .replaceAll("{LAT}", String(mid.lat))
    .replaceAll("{LON}", String(mid.lon));
  // `out tags center` => tags + a synthetic {center: {lat, lon}} for ways/relations
  // (nodes already carry top-level lat/lon).
  return `
    [out:json][timeout:8];
    (
      ${block}
    );
    out tags center 30;
  `.trim();
}

function makeKey(mid, categories, radiusM) {
  const lat = (Math.round(mid.lat * 200) / 200).toFixed(3); // ~500m grid
  const lon = (Math.round(mid.lon * 200) / 200).toFixed(3);
  return `${lat},${lon}|${[...categories].sort().join(",")}|${radiusM}`;
}

// ---------- Photon POI search (primary) ----------
//
// Photon (https://photon.komoot.io) is Komoot's open-source geocoder built
// on OpenStreetMap data. It is CORS-friendly, has no rate limit, and is
// much faster than Nominatim. Used as the primary multi-anchor POI source.
//
// Returns GeoJSON FeatureCollection. Each feature has properties.osm_key,
// properties.osm_value, properties.name, and geometry.coordinates [lon, lat].

const PHOTON_ENDPOINT = "/api/photon";   // proxied via Vercel serverless function

// Map our app categories to OSM tags. Photon's filter syntax uses
// `osm_tag=KEY:VALUE` (with a colon separating key from value), e.g.
// `osm_tag=amenity:cafe`. Multiple osm_tag params are AND-combined.
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
  const filters = photonFilters(categories);
  // Photon's `osm_tag` filter only accepts ONE value per request. With
  // multiple categories we'd ideally send multiple requests, but we can
  // also fall back to using the `q` text query which Photon interprets
  // broadly. We do one combined query that includes the most popular
  // amenity keywords.
  const qTerms = {
    cafe:       "cafe",
    restaurant: "restaurant",
    bar:        "bar",
    park:       "park",
  };
  const q = categories.map((c) => qTerms[c]).filter(Boolean).join(" ");
  const url = new URL(PHOTON_ENDPOINT, location.origin);
  url.searchParams.set("q", q || "cafe restaurant bar park");
  url.searchParams.set("lat", String(mid.lat));
  url.searchParams.set("lon", String(mid.lon));
  // Photon's `location_bias_scale` parameter biases the search around
  // lat/lon -- default is 0.2 which can pull results from hundreds of
  // km away. Set to 0.1 to keep results local to the endpoint.
  url.searchParams.set("location_bias_scale", "0.1");
  url.searchParams.set("limit", "30");
  url.searchParams.set("zoom", "15");
  // Photon supports one osm_tag. If we have a single category, use it as
  // a precision filter; otherwise let the q text query handle the matching.
  if (filters.length === 1) {
    url.searchParams.set("osm_tag", filters[0]);
  }
  try {
    const res = await fetch(url, {
      headers: { "Accept": "application/json" },
      signal,
    });
    if (!res.ok) return [];
    const data = await res.json();
    const features = Array.isArray(data?.features) ? data.features : [];
    const results = [];
    const seen = new Set();
    for (const f of features) {
      const [lon, lat] = f.geometry?.coordinates || [];
      const name = f.properties?.name;
      if (!name || !isFinite(lat) || !isFinite(lon)) continue;
      // Filter: only keep features whose osm_key+osm_value match one of our
      // requested categories. Photon's q is fuzzy; we tighten it here.
      const props = f.properties || {};
      const matched = filters.some((kv) => {
        const [k, v] = kv.split(":");
        return props.osm_key === k && props.osm_value === v;
      });
      if (filters.length > 0 && !matched) continue;
      // Hard distance filter: drop anything farther than 2x the
      // per-anchor radius. Without this, famous-name matches in
      // Sydney/Berlin can outrank a small cafe next door. We use 2x
      // for headroom: the search is by lat/lon but real geography is
      // messy and we don't want to miss a cafe just across a fjord.
      const dlat = (lat - mid.lat) * 111000;
      const dlon = (lon - mid.lon) * 111000 * Math.cos((mid.lat * Math.PI) / 180);
      const distM = Math.sqrt(dlat * dlat + dlon * dlon);
      if (distM > radiusM * 2) continue;
      const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
      if (seen.has(key)) continue;
      seen.push(key);
      results.push({
        id: `photon/${props.osm_type || "n"}/${props.osm_id || key}`,
        name,
        lat,
        lon,
        category: inferCategoryFromPhoton(f, categories),
        tags: props,
      });
    }
    return results;
  } catch {
    return [];
  }
}

// ---------- Nominatim POI fallback ----------
//
// Photon can occasionally be down. As a last resort we fall back to
// Nominatim with strict rate-limit-aware throttling.

const NOMINATIM_ENDPOINT = "/api/nominatim";   // proxied via Vercel serverless function

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
  const results = [];
  const seen = new Set();

  // Browsers cap concurrent requests per origin at ~6. Nominatim is the
  // origin for all of these queries, so firing 6+ in parallel can cause
  // some to be queued/cancelled. We process at most 3 at once.
  const PARALLEL = 3;
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
        headers: {
          ...BROWSER_HEADERS,
          "Accept": "application/json",
        },
        signal,
      });
      if (res.status === 429) {
        await sleep(1100);
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

  // Run in chunks of PARALLEL to avoid hitting browser concurrent-request caps.
  const allHits = [];
  for (let i = 0; i < tasks.length; i += PARALLEL) {
    if (signal?.aborted) break;
    const chunk = await Promise.all(tasks.slice(i, i + PARALLEL));
    allHits.push(...chunk.flat());
  }
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
  // fall back to preserving order
  for (const c of requested) {
    if (CATEGORY_QUERIES[c]?.some(q => (hit.display_name || "").toLowerCase().includes(q))) return c;
  }
  return requested[0] || "generic";
}

/**
 * Query Overpass. Returns [{ id, name, lat, lon, category, tags }].
 * Errors have .code: "OVERPASS_FAILED" / "NETWORK" / "EMPTY".
 */
export async function findPlaces(mid, categories, radiusM = 2000, { signal } = {}) {
  if (!Array.isArray(categories) || categories.length === 0) {
    throw makeError("EMPTY", "no categories selected");
  }
  const key = makeKey(mid, categories, radiusM);
  if (cache.has(key)) return cache.get(key);
  if (inflight.has(key)) return inflight.get(key);

  const promise = (async () => {
    const query = buildQuery(mid, categories, radiusM);
    let lastErr = null;

    let overpassResults = [];
    outer: for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      for (const endpoint of ENDPOINTS) {
        // Compose an AbortController so a slow mirror doesn't make us wait
        // 30+ seconds before trying the next one.
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), ENDPOINT_TIMEOUT_MS);
        if (signal) signal.addEventListener("abort", () => ctl.abort(), { once: true });
        try {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              ...BROWSER_HEADERS,
            },
            body: "data=" + encodeURIComponent(query),
            signal: ctl.signal,
          });
          clearTimeout(timer);
          if (res.status === 429 || res.status === 504) {
            lastErr = makeError("OVERPASS_FAILED", `${res.status} from ${endpoint}`);
            continue; // try next endpoint
          }
          if (!res.ok) {
            lastErr = makeError("OVERPASS_FAILED", `HTTP ${res.status} from ${endpoint}`);
            continue;
          }
          const data = await res.json();
          overpassResults = parseOverpass(data, categories);
          break outer; // success -- regardless of count, don't keep hammering mirrors
        } catch (e) {
          clearTimeout(timer);
          // If the caller aborted, propagate immediately.
          if (signal?.aborted) throw makeError("ABORTED", "caller aborted");
          // Otherwise it's a per-endpoint problem (timeout, CORS, network) —
          // record it and let the loop try the next mirror.
          if (e?.name === "AbortError") {
            lastErr = makeError("OVERPASS_FAILED", `timeout ${endpoint}`);
          } else {
            lastErr = makeError("NETWORK", e?.message || "fetch failed");
          }
        }
      }
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
    }

    // If Overpass gave us any results, use them.
    if (overpassResults.length > 0) {
      cache.set(key, overpassResults);
      return overpassResults;
    }

    // Overpass returned 0 hits OR every mirror failed -- try Photon first
    // (fast, no rate limit), then Nominatim as last resort.
    console.warn(
      "Overpass returned no results / failed; trying Photon POI search.",
      lastErr?.message || ""
    );
    let fallback = await photonPoiSearch(mid, categories, radiusM, signal);
    if (fallback.length === 0) {
      console.warn("Photon returned nothing, falling back to Nominatim.");
      fallback = await nominatimPoiSearch(mid, categories, radiusM, signal);
    }
    if (fallback.length > 0) {
      cache.set(key, fallback);
      return fallback;
    }

    // Neither source returned anything. If Overpass gave us 0 with no errors
    // it's genuinely an empty area; if every mirror failed, surface that.
    if (lastErr) throw lastErr;
    cache.set(key, []);
    return [];
  })();

  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

function parseOverpass(data, categories) {
  const elements = Array.isArray(data?.elements) ? data.elements : [];
  const seen = new Set();
  const out = [];
  for (const el of elements) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;
    const tags = el.tags || {};
    const name = (tags.name || tags["name:en"] || tags.brand || "").trim();
    if (!name) continue;
    const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: `${el.type}/${el.id}`,
      name,
      lat,
      lon,
      category: inferCategory(tags, categories),
      tags,
    });
    if (out.length >= 30) break;
  }
  return out;
}

function inferCategory(tags, requested) {
  // Pick the most specific first match against our list, preserving order.
  const tagMap = {
    cafe:       tags.amenity === "cafe",
    restaurant: tags.amenity === "restaurant" || tags.amenity === "fast_food",
    bar:        tags.amenity === "bar" || tags.amenity === "pub",
    park:       tags.leisure === "park" || tags.leisure === "garden" || tags.leisure === "plaza",
  };
  for (const c of requested) if (tagMap[c]) return c;
  return requested[0] || "generic";
}

export function clearCache() {
  cache.clear();
}

// ---------- v4: single-circle POI search ----------
//
// The user requested a clean, simple algorithm:
//   "from the actual midpoint extend a circle and after some point
//    find places and tell the relative time to both points."
//
// We support it with a thin wrapper around Photon/Nominatim that takes
// ONE anchor (the midpoint) and ONE radius, queries POIs in that circle,
// and returns them. The "expansion" logic (retry with bigger radius if
// too few results) lives in `findPlacesAlways` below -- the underlying
// search itself stays single-circle, single-radius.

/**
 * Query POIs in a single circle around `mid` with radius `radiusM`.
 * Returns [{ id, name, lat, lon, category, tags }] deduplicated by ~30m.
 * Tries Photon first (fast, CORS-friendly), Nominatim as fallback.
 * `signal` is an AbortSignal to cancel in-flight requests.
 */
export async function findPlacesInCircle(mid, categories, radiusM, { signal } = {}) {
  if (!mid || !Array.isArray(categories) || categories.length === 0) return [];
  // Single anchor -- Photon handles this directly.
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

function makeError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}