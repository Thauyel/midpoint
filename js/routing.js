// ============================================================
//  routing.js  --  OSRM /table wrapper
//
//  One call returns every (source, destination) duration in
//  seconds. We use the public demo server
//  (router.project-osrm.org) for MVP -- it serves driving
//  profiles globally and is rate-limited but cacheable.
// ============================================================

const ENDPOINT = "https://router.project-osrm.org/table/v1/driving";
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 800;

// Browser-like headers (OSRM demo enforces browser signals from datacenter IPs).
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.openstreetmap.org/",
  "Origin": "https://www.openstreetmap.org",
};

const cache = new Map();
const inflight = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function gridRound(v) {
  // ~300m grid: enough to coalesce nearby queries without sacrificing accuracy
  return Math.round(v * 300) / 300;
}

function makeKey(src, dst) {
  const s = src.map((p) => `${gridRound(p[0]).toFixed(3)},${gridRound(p[1]).toFixed(3)}`).join("|");
  const d = dst.map((p) => `${gridRound(p[0]).toFixed(3)},${gridRound(p[1]).toFixed(3)}`).join("|");
  return `${s}>>${d}`;
}

/**
 * Compute a duration matrix.
 * @param {Array<{lat, lon}>} sources
 * @param {Array<[lon, lat]>} destinations  -- OSRM wants [lon, lat]
 * @returns {{ durations: number[][], distances: number[][] }}
 *          durations[i][j] = seconds from source i to dest j (null = unroutable)
 */
export async function osrmTable(sources, destinations, { signal } = {}) {
  if (!sources.length || !destinations.length) {
    return { durations: [], distances: [] };
  }
  const srcCoords = sources.map((p) => `${p.lon},${p.lat}`).join(";");
  const dstCoords = destinations.map((p) => `${p[0]},${p[1]}`).join(";");
  const allCoords = `${srcCoords};${dstCoords}`;
  // OSRM source/destination indexes are 0-based into the merged coords array.
  const srcIdx = sources.map((_, i) => i).join(";");
  const dstIdx = destinations.map((_, i) => sources.length + i).join(";");

  const key = makeKey(
    sources.map((p) => [p.lon, p.lat]),
    destinations
  );
  if (cache.has(key)) return cache.get(key);
  if (inflight.has(key)) return inflight.get(key);

  const promise = (async () => {
    // OSRM's URL parser is fragile — it requires the coords inline in the path
    // (not URL-encoded) and only uses `?` for sources/destinations/annotations.
    const params = new URLSearchParams();
    params.set("sources", srcIdx);
    params.set("destinations", dstIdx);
    params.set("annotations", "duration,distance");
    const url = `${ENDPOINT}/${allCoords}?${params}`;

    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(url, {
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
        if (data.code !== "Ok") {
          throw makeError("OSRM", `code=${data.code} ${data.message || ""}`);
        }
        const result = {
          durations: data.durations ?? [],
          distances: data.distances ?? [],
        };
        cache.set(key, result);
        return result;
      } catch (e) {
        if (e?.name === "AbortError") throw e;
        if (e?.code === "OSRM") throw e;
        lastErr = makeError("NETWORK", e?.message || "fetch failed");
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
      }
    }
    throw lastErr ?? makeError("NETWORK", "osrm failed");
  })();

  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

export function clearCache() {
  cache.clear();
}

function makeError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}