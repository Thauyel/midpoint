// ============================================================
//  api/osrm.js
//  Vercel serverless function: proxies OSRM's /table service
//  for drive-time matrices. Browser-to-OSRM is CORS-blocked
//  from Vercel edge IPs.
// ============================================================

const ENDPOINT = "https://router.project-osrm.org";
const FETCH_TIMEOUT_MS = 12000;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  // /route/v1/driving/{coords}?annotations=duration,distance&sources=...
  const path = req.query.path || "";
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query || {})) {
    if (k === "path") continue;
    if (v != null) qs.set(k, String(v));
  }

  const upstream_url = `${ENDPOINT}${path}${qs.toString() ? "?" + qs.toString() : ""}`;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const upstream = await fetch(upstream_url, {
      headers: { "User-Agent": "midpoint-app/1.0 (https://midpoint-rust.vercel.app)" },
      signal: ctl.signal,
    });
    clearTimeout(timer);
    const body = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
    res.setHeader("Cache-Control", "public, max-age=120, s-maxage=600");
    res.send(body);
  } catch (e) {
    clearTimeout(timer);
    const isTimeout = e?.name === "AbortError";
    res.status(isTimeout ? 504 : 502).json({
      error: isTimeout ? "osrm_timeout" : "osrm_unreachable",
      message: String(e?.message || e),
    });
  }
}