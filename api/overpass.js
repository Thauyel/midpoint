// ============================================================
//  api/overpass.js
//  Vercel serverless function: proxies the Overpass API.
//  Several public mirrors CORS-block browser POSTs, and Vercel
//  edge IPs get rate-limited. Server-to-server proxy fixes
//  both. We try mirrors in order until one returns 200.
// ============================================================

const MIRRORS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.osm.ch/api/interpreter",
];

async function tryMirror(url, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: "POST",
      body,
      signal: ctl.signal,
      headers: { "User-Agent": "midpoint-app/1.0 (https://midpoint-rust.vercel.app)" },
    });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,GET,OPTIONS");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  // Overpass queries come in as POST bodies (QGIS-style) or GET ?data=
  const data = req.method === "POST"
    ? (typeof req.body === "string" ? req.body : req.body?.data)
    : req.query.data;

  if (!data) {
    res.status(400).json({ error: "missing_query", message: "send Overpass QL in POST body or ?data=" });
    return;
  }

  for (const mirror of MIRRORS) {
    const upstream = await tryMirror(mirror, data);
    if (upstream && upstream.ok) {
      const body = await upstream.text();
      res.status(200);
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300");
      res.send(body);
      return;
    }
    if (upstream) {
      // Drain body so the connection can be reused, but try next mirror
      try { await upstream.text(); } catch (_) {}
    }
  }
  res.status(502).json({ error: "all_mirrors_failed" });
}