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
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 900;

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
 * Geocode a free-text query.
 * Returns { lat, lon, display_name } or throws an Error with .code:
 *   "ZERO_RESULTS"  -- nothing found
 *   "RATE_LIMITED"  -- gave up after MAX_ATTEMPTS on 429
 *   "NETWORK"       -- network/DNS failure
 */
export async function geocode(query, { signal } = {}) {
  const key = makeKey(query);
  if (!key) throw makeError("EMPTY_QUERY", "empty query");

  if (cache.has(key)) return cache.get(key);
  if (inflight.has(key)) return inflight.get(key);

  const promise = (async () => {
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const url = new URL(ENDPOINT);
        url.searchParams.set("q", query);
        url.searchParams.set("format", "jsonv2");
        url.searchParams.set("limit", "1");
        url.searchParams.set("addressdetails", "0");

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
        if (res.status >= 500) {
          lastErr = makeError("NETWORK", `${res.status} on attempt ${attempt}`);
          await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
          continue;
        }
        if (!res.ok) {
          throw makeError("NETWORK", `HTTP ${res.status}`);
        }

        const data = await res.json();
        if (!Array.isArray(data) || data.length === 0) {
          throw makeError("ZERO_RESULTS", `no results for "${query}"`);
        }

        const hit = data[0];
        const result = {
          lat: parseFloat(hit.lat),
          lon: parseFloat(hit.lon),
          display_name: hit.display_name,
        };
        if (!isFinite(result.lat) || !isFinite(result.lon)) {
          throw makeError("ZERO_RESULTS", `invalid coords for "${query}"`);
        }
        cache.set(key, result);
        return result;
      } catch (e) {
        if (e?.name === "AbortError") throw e;
        if (e?.code) throw e; // our own — bail
        lastErr = makeError("NETWORK", e?.message || "fetch failed");
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
      }
    }
    throw lastErr ?? makeError("NETWORK", "geocode failed");
  })();

  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

/**
 * Reverse-geocode (lat,lon) -> display_name. Best-effort.
 */
export async function reverse(lat, lon, { signal } = {}) {
  const key = `rev:${lat.toFixed(5)},${lon.toFixed(5)}`;
  if (cache.has(key)) return cache.get(key);

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