// ============================================================
//  places.js  --  Overpass API wrapper
//
//  Query the OSM "around" pattern with `out tags` so we get
//  the human name without paying for geometry. Bounded by
//  radius_m, capped at 30 raw hits per call.
//
//  Multi-endpoint with automatic failover (overpass-api.de is
//  the canonical public one; overpass.kumi.systems is the
//  mirror that's often faster / less loaded).
// ============================================================

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
  // kumi.systems is the most reliable from browser contexts (CORS-friendly
  // and forwards to the main Overpass cluster). We try it first.
  "https://overpass.kumi.systems/api/interpreter",
  // api.de is the canonical but enforces CORS strictly on POST from browser
  // origins other than openstreetmap.org, so it usually fails from Vercel.
  "https://overpass-api.de/api/interpreter",
  // osm.ch has a stale DB (timestamp often weeks old) and is the last resort.
  "https://overpass.osm.ch/api/interpreter",
];

const MAX_ATTEMPTS = 2;
const BASE_BACKOFF_MS = 600;
// Per-endpoint hard timeout (ms). The public Overpass mirrors are sometimes
// pathologically slow (30s+ before any response) -- we'd rather fail fast
// and try the next mirror.
const ENDPOINT_TIMEOUT_MS = 8000;
// Per-anchor timeout (ms) for the multi-anchor Nominatim search. With 8
// anchors and a 5s budget each, the worst-case POI scan completes in 40s.
const ANCHOR_TIMEOUT_MS = 5000;

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

const PHOTON_ENDPOINT = "https://photon.komoot.io/api/";

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
  // Photon uses lat/lon + a "zoom"-like distance, not a radius. We use
  // `location_bias_scale=2&zoom=15` to bias results near the point with
  // ~1km precision (zoom 15 = city-block scale). The `lang` defaults to
  // local; we don't set it so the API uses its own heuristic.
  const url = new URL(PHOTON_ENDPOINT);
  url.searchParams.set("lat", String(mid.lat));
  url.searchParams.set("lon", String(mid.lon));
  // Photon's `q` is an optional text filter; we use it to bias toward the
  // category keyword if there's a single category. With multi-category we
  // skip the q filter and rely on `osm_tag` filters below.
  if (categories.length === 1 && categories[0] !== "generic") {
    url.searchParams.set("q", categories[0]);
  }
  // Apply OSM tag filters (limit=50 per call so we get a decent pool).
  url.searchParams.set("limit", "30");
  url.searchParams.set("zoom", "15");
  for (const kv of filters) {
    url.searchParams.set("osm_tag", kv);
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
      const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        id: `photon/${f.properties?.osm_type || "n"}/${f.properties?.osm_id || key}`,
        name,
        lat,
        lon,
        category: inferCategoryFromPhoton(f, categories),
        tags: f.properties || {},
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

const NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org/search";

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
    const url = new URL(NOMINATIM_ENDPOINT);
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

/**
 * Search for places around MULTIPLE anchor points and return the union.
 * Deduplicates by ~30m proximity. Used when the two endpoints are far apart
 * or their geographic midpoint falls in the sea -- we sample anchors along
 * the line A->B and search around each.
 *
 * Internally: each anchor is queried via the Nominatim POI fallback path
 * directly (not via findPlaces), because:
 *   1. Overpass is rate-limited and slow per-mirror; we don't want to
 *      hit 3 Overpass mirrors × N anchors = 30+ requests just for one find.
 *   2. The line-anchor strategy inherently needs MANY small queries,
 *      not one big Overpass query -- so Nominatim's "one request per
 *      category" pattern actually fits better.
 *   3. Nominatim has CORS-friendly access from any browser origin.
 *
 * Returns [{ id, name, lat, lon, category, tags }]. Never throws: errors on
 * individual anchors are swallowed and we move on.
 */
export async function findPlacesAlong(anchors, categories, radiusM = 800, { signal } = {}) {
  if (!Array.isArray(anchors) || anchors.length === 0) return [];
  if (!Array.isArray(categories) || categories.length === 0) return [];

  const all = [];
  const seen = []; // for ~30m dedup
  const POOL = 3;  // max concurrent anchors
  let cursor = 0;

  async function processAnchor(anchor) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ANCHOR_TIMEOUT_MS);
    try {
      // Photon first -- fast and rate-limit free.
      let places = await photonPoiSearch(anchor, categories, radiusM, ctl.signal);
      // If Photon returns nothing, fall back to Nominatim.
      if (places.length === 0) {
        places = await nominatimPoiSearch(anchor, categories, radiusM, ctl.signal);
      }
      clearTimeout(timer);
      return places;
    } catch {
      clearTimeout(timer);
      return [];
    }
  }

  async function worker() {
    while (cursor < anchors.length) {
      const idx = cursor++;
      if (signal?.aborted) return;
      const places = await processAnchor(anchors[idx]);
      for (const p of places) {
        const dupe = seen.some((q) =>
          Math.abs(q.lat - p.lat) < 0.0003 && Math.abs(q.lon - p.lon) < 0.0003
        );
        if (!dupe) {
          seen.push(p);
          all.push(p);
        }
        if (all.length >= 60) return;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(POOL, anchors.length) }, worker));
  return all;
}

function makeError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}