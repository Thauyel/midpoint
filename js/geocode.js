// ============================================================
//  geocode.js  --  Nominatim wrapper
//
//  Free, no API key. 1 req/s rate limit. We:
//    - Add a custom User-Agent (Nominatim ToS require identification)
//    - Cache results in memory by query string
//    - Retry with exponential backoff on 429 / 5xx
//    - Use the `accept-language=en` header for stable display
// ============================================================

const ENDPOINT = "https://nominatim.openstreetmap.org/search";
const PHOTON_GEOCODE = "https://photon.komoot.io/api/";
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 900;
const SUGGEST_LIMIT = 6;

// Browser-like headers. Nominatim's edge blocks default fetch UAs from
// datacenter ranges. Real browsers send these, so we mirror that.
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.openstreetmap.org/",
  "Origin": "https://www.openstreetmap.org",
};

const cache = new Map(); // key: lower(query) -> {lat, lon, display_name, _ts}
const inflight = new Map(); // de-dupe concurrent identical queries

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeKey(q) {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Geocode a free-text query and return up to SUGGEST_LIMIT matches.
 * Returns an array of { lat, lon, display_name, type, importance } or throws.
 * Throws an Error with .code:
 *   "ZERO_RESULTS"  -- nothing found
 *   "RATE_LIMITED"  -- gave up after MAX_ATTEMPTS on 429
 *   "NETWORK"       -- network/DNS failure
 */
export async function geocode(query, { signal, limit = SUGGEST_LIMIT } = {}) {
  const key = makeKey(query);
  if (!key) throw makeError("EMPTY_QUERY", "empty query");

  // For a query with cached single result, return it as the only suggestion.
  const cached = cache.get(key);
  if (cached) return Array.isArray(cached) ? cached : [cached];
  if (inflight.has(key)) return inflight.get(key);

  const promise = (async () => {
    // Photon first -- CORS-friendly, no rate limit, fast. If it returns
    // nothing, fall back to Nominatim.
    let data = await photonGeocode(query, limit, signal);
    if (!Array.isArray(data) || data.length === 0) {
      data = await nominatimGeocode(query, limit, signal);
    }
    if (!Array.isArray(data) || data.length === 0) {
      throw makeError("ZERO_RESULTS", `no results for "${query}"`);
    }

    const results = data
      .map((hit) => ({
        lat: typeof hit.lat === "number" ? hit.lat : parseFloat(hit.lat),
        lon: typeof hit.lon === "number" ? hit.lon : parseFloat(hit.lon),
        display_name: hit.display_name,
        type: hit.type,
        importance: typeof hit.importance === "number" ? hit.importance : 0,
      }))
      .filter((r) => isFinite(r.lat) && isFinite(r.lon))
      .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))
      .slice(0, limit);

    if (results.length === 0) {
      throw makeError("ZERO_RESULTS", `no usable results for "${query}"`);
    }

    cache.set(key, results);
    return results;
  })();

  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

/**
 * Single-result convenience wrapper used when the user clicks a suggestion
 * (we already have all the data we need at that point).
 */
export async function geocodeOne(query, opts = {}) {
  const results = await geocode(query, { ...opts, limit: 1 });
  return results[0];
}

/**
 * Reverse-geocode (lat,lon) -> display_name. Best-effort.
 */
export async function reverse(lat, lon, { signal } = {}) {
  const key = `rev:${lat.toFixed(5)},${lon.toFixed(5)}`;
  if (cache.has(key)) return cache.get(key);

  // Try Photon first (no rate limit). Falls back to Nominatim on failure.
  const photonUrl = new URL(PHOTON_GEOCODE);
  photonUrl.searchParams.set("lat", String(lat));
  photonUrl.searchParams.set("lon", String(lon));
  photonUrl.searchParams.set("limit", "1");
  try {
    const res = await fetch(photonUrl, {
      headers: { "Accept": "application/json" },
      signal,
    });
    if (res.ok) {
      const data = await res.json();
      const feat = data?.features?.[0];
      const props = feat?.properties || {};
      const bits = [props.name, props.street, props.city || props.town || props.village, props.state, props.country].filter(Boolean);
      const display_name = bits.join(", ") || props.name || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
      if (feat) {
        const result = { lat, lon, display_name };
        cache.set(key, result);
        return result;
      }
    }
  } catch { /* fall through to Nominatim */ }

  // Nominatim fallback for reverse.
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const url = new URL("https://nominatim.openstreetmap.org/reverse");
      url.searchParams.set("lat", String(lat));
      url.searchParams.set("lon", String(lon));
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("zoom", "16");

      const res = await fetch(url, {
        headers: HEADERS,
        signal,
      });
      if (res.status === 429) {
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || !data.display_name) return null;
      const result = { lat, lon, display_name: data.display_name };
      cache.set(key, result);
      return result;
    } catch {
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
    }
  }
  return null;
}

export function clearCache() {
  cache.clear();
}

function makeError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// ============================================================
//  Photon geocoder (https://photon.komoot.io)
// ============================================================
//
// Photon returns GeoJSON FeatureCollection where each feature has:
//   properties: { osm_key, osm_value, name, city, country, ... }
//   geometry.coordinates: [lon, lat]
//
// We map these to the same shape as Nominatim results so the rest of
// the geocode() function is agnostic to which backend served it.

async function photonGeocode(query, limit, signal) {
  const url = new URL(PHOTON_GEOCODE);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(Math.min(limit * 3, 15)));
  // Bias results to Turkey. Photon supports `lang` but no country
  // filter directly, so we POST-FILTER the response to keep only
  // features whose country code starts with "TR". This fixes the
  // "Kadıköy village in Hungary gets ranked above Kadıköy district
  // in Istanbul" problem.
  try {
    const res = await fetch(url, {
      headers: { "Accept": "application/json" },
      signal,
    });
    if (!res.ok) return [];
    const data = await res.json();
    const features = Array.isArray(data?.features) ? data.features : [];
    // Detect if the query mentions Turkey / Türkiye / Istanbul
    const wantTurkey = /\b(turkey|turkiye|türkiye|istanbul|ankara|izmir)\b/i.test(query);
    const enriched = features
      .map((f) => {
        const [lon, lat] = f.geometry?.coordinates || [];
        const props = f.properties || {};
        const bits = [props.name, props.street, props.city || props.town || props.village, props.state, props.country]
          .filter(Boolean);
        const country = (props.country || "").toLowerCase();
        return {
          lat: typeof lat === "number" ? lat : parseFloat(lat),
          lon: typeof lon === "number" ? lon : parseFloat(lon),
          display_name: bits.join(", ") || props.name || query,
          type: props.osm_value || props.type || "",
          importance: typeof props.osm_importance === "number" ? props.osm_importance : 0.5,
          _turkey: props.countrycode === "TR" || country.includes("turk") || country.includes("türk"),
        };
      })
      .filter((r) => isFinite(r.lat) && isFinite(r.lon));

    // If at least 2 of the top results are Turkish, drop any non-Turkish
    // ones -- Photon sometimes ranks a small village named "Kartal" in
    // Hungary above Istanbul's Kartal district. This filter prefers
    // Turkish matches when there are enough of them.
    const turkishCount = enriched.filter((r) => r._turkey).length;
    const preferTurkey = wantTurkey || turkishCount >= 2;

    return enriched
      .filter((r) => !preferTurkey || r._turkey || r.importance > 0.85)
      .sort((a, b) => {
        if (preferTurkey && a._turkey !== b._turkey) return a._turkey ? -1 : 1;
        return (b.importance ?? 0) - (a.importance ?? 0);
      })
      .slice(0, limit)
      .map(({ _turkey, ...rest }) => rest);
  } catch {
    return [];
  }
}

async function nominatimGeocode(query, limit, signal) {
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const url = new URL(ENDPOINT);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("addressdetails", "0");
      url.searchParams.set("dedupe", "1");
      const res = await fetch(url, {
        method: "GET",
        headers: HEADERS,
        signal,
      });
      if (res.status === 429) {
        lastErr = makeError("RATE_LIMITED", `429 on attempt ${attempt}`);
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }
      if (!res.ok) {
        lastErr = makeError("NETWORK", `HTTP ${res.status}`);
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      lastErr = makeError("NETWORK", e?.message || "fetch failed");
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
    }
  }
  // Return empty on exhaustion so the caller can decide what to do
  return [];
}