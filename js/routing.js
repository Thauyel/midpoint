// ============================================================
//  routing.js  --  OSRM /table wrapper
//
//  One call returns every (source, destination) duration in
//  seconds. We use the public demo server
//  (router.project-osrm.org) for MVP -- it serves driving
//  profiles globally and is rate-limited but cacheable.
// ============================================================

// All OSRM calls now route through the Vercel serverless proxy (/api/osrm),
// which forwards to router.project-osrm.org server-to-server. This
// sidesteps both CORS and the browser-rate-limit problem entirely.
const PROXY_BASE = "/api/osrm";
const UPSTREAM_BASE = "https://router.project-osrm.org";
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 800;
// Hard timeout per OSRM call. The public demo is occasionally slow to first
// byte; we'd rather retry than block forever.
const REQUEST_TIMEOUT_MS = 15000;

// When calling our own /api proxy, only minimal headers are needed.
const HEADERS = {
  "Accept": "application/json",
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
    // We always request sources=0;1 explicitly and destinations=all (returns
    // one row per source containing all-pair durations). Using `all` makes
    // the URL parser-friendly across OSRM versions.
    const params = new URLSearchParams();
    params.set("sources", "0;1");
    params.set("destinations", "all");
    params.set("annotations", "duration,distance");
    // Route through the Vercel proxy. The proxy expects the path portion
    // of the upstream URL as `?path=` so it can forward verbatim. This
    // sidesteps both CORS (browser → /api same-origin) and rate-limits
    // (server-to-server upstream, not browser-fetch).
    const upstreamPath = `/table/v1/driving/${allCoords}`;
    const proxyUrl = `${PROXY_BASE}?path=${encodeURIComponent(upstreamPath)}&${params.toString()}`;

    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Per-attempt hard timeout via AbortController.
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
      if (signal) signal.addEventListener("abort", () => ctl.abort(), { once: true });
      try {
        const res = await fetch(proxyUrl, {
          headers: HEADERS,
          signal: ctl.signal,
        });
        clearTimeout(timer);
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
        clearTimeout(timer);
        if (e?.name === "AbortError") {
          if (signal?.aborted) throw makeError("ABORTED", "caller aborted");
          lastErr = makeError("NETWORK", `timeout on attempt ${attempt}`);
          await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
          continue;
        }
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