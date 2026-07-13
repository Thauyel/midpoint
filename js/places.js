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

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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
          const out = parseOverpass(data, categories);
          // An empty result isn't necessarily a failure of THIS endpoint, but
          // if all three mirrors return empty then we know the area has
          // nothing in OSM (rare in cities). Surface that so the caller can
          // try the Nominatim fallback.
          cache.set(key, out);
          return out;
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
    throw lastErr ?? makeError("OVERPASS_FAILED", "all endpoints failed");
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

function makeError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}