# midpoint

two places, one fair meeting point.

type two locations, pick what kind of place you want, get a ranked list
of spots inside a single circle drawn from the geographic midpoint —
each with the relative drive time to both endpoints.

## what it does

- geocodes free-text addresses (Photon primary, Nominatim fallback)
- computes the great-circle midpoint between the two inputs
- draws a single circle around the midpoint at the fair-zone
  boundary (`directM / 2`); expands it geometrically (×1.5 per step)
  up to `maxRadiusFor(directM)` if too few POIs are inside
- asks OSRM (via `/api/osrm`) for driving ETA from each endpoint to
  every candidate place inside the circle
- ranks the places and shows the top 10 with relative times to A and B
- lets you share a search via URL, navigate results with the
  keyboard, and click any result row or map pin to highlight the
  matched pair in both views

## ranking — the circle algorithm

the default sort is **closest to midpoint**: places nearer the
geographic midpoint come first, ties broken by fairness
(`|eta_a − eta_b|`). if the user prefers a different emphasis:

| tab | criterion | tie-breaker |
|---|---|---|
| **closest to midpoint** *(default)* | distance from geographic midpoint | fairness (`|Δ|` seconds) |
| **most fair** | smallest `|eta_a − eta_b|` | distance to midpoint, then total drive |
| **shortest total** | smallest `eta_a + eta_b` | distance to midpoint |

sort tabs re-sort the cached candidates instantly — no network
round-trip.

## pin ↔ list highlight

clicking a pin on the map highlights the matching row in the list
(and scrolls it into view); clicking a row pulses the matching pin.
single shared `selectPlace(idx)` code path serves both directions.

## features

- 🇹🇷 / 🇬🇧 Turkish + English UI with auto-detect
- arrow-key navigation of the suggestion dropdown (Enter to pick)
- keyboard shortcuts: `?` for help, `Cmd/Ctrl+K` to focus input
- click a result row → highlight the pin and pan the map
- click a pin on the map → highlight the matching result row
- "open in Google Maps" / "open in Apple Maps" deep links on every result
- share URL — both addresses + categories encoded, reloads to the same search
- dark CARTO tiles matched to the pure-black theme
- screen-reader friendly: live region announces result counts,
  focusable results with proper aria-labels

## architecture

```
┌───────────────────────────────────────────────────────────┐
│                       browser                              │
│                                                             │
│   app.js ───┬─── geocode.js ──→ /api/nominatim             │
│             │                    /api/photon                │
│             ├─── places.js ────→ /api/photon                │
│             │                    /api/nominatim (POI)        │
│             ├─── routing.js ───→ /api/osrm                 │
│             ├─── map.js ────────→ CARTO Dark Matter tiles   │
│             ├─── i18n.js ─────── (TR / EN + persistence)    │
│             └─── midpoint.js ── (circle math + ranking —    │
│                                  pure, no I/O, fully tested)│
└───────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────┐
│                  Vercel (serverless)                       │
│                                                             │
│   /api/nominatim ──→ nominatim.openstreetmap.org           │
│   /api/photon    ──→ photon.komoot.io                      │
│   /api/osrm      ──→ router.project-osrm.org               │
└───────────────────────────────────────────────────────────┘
```

the proxy layer sidesteps two CORS issues: (1) browsers can't reach some
upstreams from Vercel's edge IPs because of cross-site rules, and (2)
the upstreams rate-limit edge IPs faster than browser IPs. running the
calls server-to-server gets a stable connection at the cost of one
extra hop per request. each endpoint has its own `max-age` cache so
repeat searches hit Vercel's CDN.

## run locally

it's a folder of static files. no build, no deps.

```bash
# option a — open the file directly (most browsers will block some features)
open index.html

# option b — local server (recommended; gives proper cookies and origins)
python3 -m http.server 8080
# → http://localhost:8080/
```

geolocation requires https (or `http://localhost`). Vercel gives you
https for free on deploy.

## test

```bash
node tests/test_midpoint.mjs     # offline — circle math + 41 unit tests
```

## deploy to vercel

```bash
# install the vercel cli once
npm i -g vercel

# from the project root
vercel          # first time — answers prompts, links to vercel
vercel --prod   # promote to production
```

or just import the github repo at <https://vercel.com/new> and it'll
pick up the `vercel.json` automatically.

## data sources

| purpose | service |
|---|---|
| geocode (forward)  | Photon (primary) + Nominatim |
| geocode (reverse)  | Photon (primary) + Nominatim |
| places (POI)       | Photon (primary) + Nominatim |
| routing (ETA)      | <https://router.project-osrm.org> |
| map tiles          | CARTO Dark Matter (free for low traffic) |
| map library        | <https://leafletjs.org> (cdn) |

## privacy

- no accounts, no cookies set by us
- no server-side storage of your searches
- the only calls leaving your browser are to the public OSM/OSRM/CARTO
  services (proxied via `/api/*` to bypass CORS / rate-limits)
- shared URLs are stored entirely in the URL query string — they're
  never sent to any server we control

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
