# midpoint

two places, one fair meeting point.

type two locations, pick what kind of place you want, get a ranked list of
spots where both people travel roughly the same time.

## what it does

- geocodes free-text addresses (Nominatim + Photon via OpenStreetMap)
- computes the great-circle midpoint between the two inputs
- samples anchors along the A→B line, on perpendicular corridors, on the
  fair-zone tangent chords, and on a 3×3 bbox-grid safety net
- asks OSRM (via /api/osrm) for driving ETA from each person to every
  candidate
- ranks by a fairness+axis-projection score and shows the top 10 on a map
- lets you share a search via URL, navigate results with the keyboard,
  and surface explanations for why each place is ranked where it is

## ranking — what does "fair" mean?

three sort modes are available via the tabs:

| tab | criterion | tie-breaker |
|---|---|---|
| **fairest & closest** *(default)* | `|eta_a − eta_b|` (driving minutes) + axis-projection penalty (0.05 × off-axis metres) | distance to the geographic midpoint |
| **most fair** | raw `|eta_a − eta_b|` | total drive time |
| **shortest total** | `eta_a + eta_b` | order returned |

the default combines three signals. a place is **fair** when both people
drive roughly the same time. it's **on-axis** when it sits close to the
A→B line (geometrically, equidistant from both endpoints). and it's
**close** when the geographic midpoint isn't far away. all three pulled
into one score means no single dimension can dominate a clear win
somewhere else.

## features

- 🇹🇷 / 🇬🇧 Turkish + English UI with auto-detect
- arrow-key navigation of the suggestion dropdown (Enter to pick)
- keyboard shortcuts: `?` for help, `Cmd/Ctrl+K` to focus input
- click a result row → pulse the matching pin on the map
- hover a result row → pulse that pin (and the result's ETA badges light up)
- "open in Google Maps" / "open in Apple Maps" deep links on every result
- "explain why" sub-line showing each result's off-axis distance and Δ
- share URL — both addresses + categories encoded, reloads to the same search
- dark CARTO tiles matched to the pure-black theme
- screen-reader friendly: live region announces result counts, focusable
  results with proper aria-labels

## architecture

```
┌───────────────────────────────────────────────────────────┐
│                       browser                              │
│                                                             │
│   app.js ───┬─── geocode.js ──→ /api/nominatim             │
│             │                    /api/photon (POI)          │
│             ├─── places.js ────→ /api/photon                │
│             │                    /api/nominatim (POI)      │
│             │                    /api/overpass              │
│             ├─── routing.js ───→ /api/osrm                 │
│             ├─── map.js ────────→ CARTO Dark Matter tiles   │
│             ├─── i18n.js ─────── (TR / EN + persistence)    │
│             └─── midpoint.js ── (haversine + ranking + axis │
│                                 projection — pure, no I/O) │
└───────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────┐
│                  Vercel (serverless)                       │
│                                                             │
│   /api/nominatim ──→ nominatim.openstreetmap.org           │
│   /api/photon    ──→ photon.komoot.io                      │
│   /api/overpass  ──→ overpass.kumi.systems                 │
│                     overpass-api.de (mirror failover)      │
│                     overpass.osm.ch                        │
│   /api/osrm      ──→ router.project-osrm.org               │
└───────────────────────────────────────────────────────────┘
```

the proxy layer sidesteps two CORS issues: (1) browsers can't reach some
upstreams from Vercel's edge IPs because of cross-site rules, and (2) the
upstreams rate-limit edge IPs faster than browser IPs. running the calls
server-to-server gets a stable connection at the cost of one extra
hop per request. in exchange, every endpoint has its own
`max-age` cache, so repeat searches hit Vercel's CDN.

## run locally

it's a folder of static files. no build, no deps.

```bash
# option a — open the file directly (most browsers will block some features)
open index.html

# option b — local server (recommended; gives proper cookies and origins)
python3 -m http.server 8080
# → http://localhost:8080/
```

geolocation requires https (or `http://localhost`). Vercel gives you https
for free on deploy.

## test

```bash
node tests/test_midpoint.mjs     # offline — haversine + ranking math
node tests/smoke_live.mjs        # live — proxies + upstreams
```

## deploy to vercel

```bash
# install the vercel cli once
npm i -g vercel

# from the project root
vercel          # first time — answers prompts, links to vercel
vercel --prod   # promote to production
```

or just import the github repo at <https://vercel.com/new> and it'll pick
up the `vercel.json` automatically.

## data sources

| purpose | service |
|---|---|
| geocode (forward)  | <https://nominatim.openstreetmap.org> (proxy) + Photon fallback |
| geocode (reverse)  | Photon primary, Nominatim fallback |
| places (POI)       | Photon (primary), Nominatim, Overpass (mirrored) |
| routing (ETA)      | <https://router.project-osrm.org> |
| map tiles          | CARTO Dark Matter (free for low traffic) |
| map library        | <https://leafletjs.org> (cdn) |

## privacy

- no accounts, no cookies set by us
- no server-side storage of your searches
- the only calls leaving your browser are to the public OSM/OSRM/CARTO
  services (proxied via `/api/*` to bypass CORS / rate-limits)
- shared URLs are stored entirely in the URL fragment — they're never
  sent to any server we control

## license

mit

```
MIT License

Copyright (c) 2026 Atacan Küçüksarı

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
