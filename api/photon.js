// ============================================================
//  api/photon.js
//  Vercel serverless function: proxies the Photon (Komoot) POI
//  geocoder. Photon is CORS-friendly but does rate-limit Vercel
//  edge IPs after enough requests. Running server-to-server
//  gives us a stable connection.
// ============================================================

const ENDPOINT = "https://photon.komoot.io";
const FETCH_TIMEOUT_MS = 6000;   // Photon is typically <500ms; >6s means trouble

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  // Forward all query params. Photon accepts q, lat, lon, limit,
  // osm_tag (single only), location_bias_scale, zoom, lang.
  const url = new URL(ENDPOINT + "/api/");
  for (const [k, v] of Object.entries(req.query || {})) {
    if (v != null) url.searchParams.set(k, String(v));
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const upstream = await fetch(url, {
      headers: { "Accept": "application/json" },
      signal: ctl.signal,
    });
    clearTimeout(timer);
    const body = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300");
    res.send(body);
  } catch (e) {
    clearTimeout(timer);
    const isTimeout = e?.name === "AbortError";
    res.status(isTimeout ? 504 : 502).json({
      error: isTimeout ? "photon_timeout" : "photon_unreachable",
      message: String(e?.message || e),
    });
  }
}