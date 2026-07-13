// ============================================================
//  api/nominatim.js
//  Vercel serverless function: proxies Nominatim search & reverse.
//  Needed because Nominatim returns no Access-Control-Allow-Origin
//  for viewbox queries, and rate-limits browser fetches from
//  Vercel's edge IPs. The proxy runs server-to-server, which is
//  exempt from both CORS and rate-limit (we set User-Agent/Referer).
// ============================================================

const ENDPOINT = "https://nominatim.openstreetmap.org";

const BROWSER_LIKE_HEADERS = {
  // Nominatim's usage policy requires identifying ourselves.
  "User-Agent": "midpoint-app/1.0 (https://midpoint-rust.vercel.app)",
  "Referer":    "https://midpoint-rust.vercel.app/",
  "Accept":     "application/json",
};

export default async function handler(req, res) {
  // CORS preflight (in case the browser ever needs it for non-proxied calls)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  // mode = "search" (default) or "reverse"
  const mode = String(req.query.mode || "search");
  const { q, viewbox, bounded, format, limit, countrycodes, lat, lon, zoom, "accept-language": acceptLang } = req.query;

  const url = new URL(ENDPOINT + (mode === "reverse" ? "/reverse" : "/search"));

  if (mode === "reverse") {
    if (lat != null) url.searchParams.set("lat", String(lat));
    if (lon != null) url.searchParams.set("lon", String(lon));
    if (zoom != null) url.searchParams.set("zoom", String(zoom));
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "1");
  } else {
    if (q)            url.searchParams.set("q", String(q));
    if (viewbox)      url.searchParams.set("viewbox", String(viewbox));
    if (bounded)      url.searchParams.set("bounded", String(bounded));
    if (countrycodes) url.searchParams.set("countrycodes", String(countrycodes));
    url.searchParams.set("format", String(format || "json"));
    url.searchParams.set("limit",  String(limit || "30"));
    url.searchParams.set("addressdetails", "1");
  }

  try {
    const upstream = await fetch(url, {
      headers: {
        ...BROWSER_LIKE_HEADERS,
        "Accept-Language": String(acceptLang || "tr,en"),
      },
    });
    const body = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
    res.setHeader("Cache-Control", mode === "reverse"
      ? "public, max-age=3600, s-maxage=86400"
      : "public, max-age=60, s-maxage=300");
    res.send(body);
  } catch (e) {
    res.status(502).json({ error: "upstream_unreachable", message: String(e?.message || e) });
  }
}