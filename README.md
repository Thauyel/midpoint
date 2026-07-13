# midpoint

two places, one fair meeting point.

type two locations, pick what kind of place you want, get a ranked list of
spots near the geographic midpoint where both people travel roughly the
same time.

## what it does

- geocodes free-text addresses (nominatim / openstreetmap)
- computes the great-circle midpoint
- queries openstreetmap for cafes / restaurants / bars / parks nearby
- asks osrm for driving eta from each person to every candidate
- ranks by **total travel time first, fairness (|Δ|) as tiebreaker**
- shows the top 10 on a shared map

## run locally

it's a folder of static files. no build, no deps.

```bash
# option a — open the file directly (most browsers will block some features)
open index.html

# option b — local server (recommended; gives proper cookies and origins)
python3 -m http.server 8080
# → http://localhost:8080/
```

geolocation requires https (or `http://localhost`). vercel gives you https
for free on deploy.

## test

```bash
# offline tests (haversine + ranking math)
node tests/test_midpoint.mjs

# live smoke (hits nominatim + overpass + osrm)
node tests/smoke_live.mjs
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
| geocode | <https://nominatim.openstreetmap.org> |
| places  | <https://overpass-api.de> (with mirror fallback) |
| routing | <https://router.project-osrm.org> |
| map tiles | <https://tile.openstreetmap.org> |
| map library | <https://leafletjs.org> (cdn) |

all four osm endpoints allow browser origins (cors). nothing leaves your
browser except requests to those public services.

## privacy

- no accounts, no cookies set by us
- no server, no logging of your searches
- only the public osm/osrm endpoints see your queries
- open `about` in the footer for the short version

## license

mit — see below.

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