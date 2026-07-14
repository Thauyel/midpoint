// ============================================================
//  app.js  --  entry point. Inputs, suggestion dropdowns, map,
//              pipeline, and i18n glue.
// ============================================================

import { geocode, reverse as reverseGeocode } from "./geocode.js?v=38";
import { findPlaces, findPlacesAlong, findPlacesAlways } from "./places.js?v=38";
import { osrmTable } from "./routing.js?v=38";
import { midpoint, rankByFairness, rankByFairnessFirst, rankByFairestFromMid, rankByTotalDrive, fmtEta, fmtDist, isFair, haversine, haversineEta, sampleAlongLine, corridorAnchors, offsetPoint, bearing, tangentChordAnchors, projectOntoAxis } from "./midpoint.js?v=38";
import { MidpointMap } from "./map.js?v=38";
import { t, applyTranslations, getLanguage } from "./i18n.js?v=38";

const RADIUS_M = 1500;           // BASE per-anchor POI search radius (overridden per-call by length-aware scaling)
const MAX_CANDIDATES = 14;       // cap before OSRM call (14 + 2 sources = 16 coords; OSRM demo friendly)
const MAX_RESULTS = 10;          // how many to render
const DEBOUNCE_MS = 350;
const DEFAULT_CATEGORIES = ["cafe", "restaurant", "bar"];
const SUGGEST_MIN_CHARS = 2;

// ----- state -----
const state = {
  sides: {
    a: { input: null, meta: null, point: null, busy: false, suggestions: [], reqSeq: 0 },
    b: { input: null, meta: null, point: null, busy: false, suggestions: [], reqSeq: 0 },
  },
  categories: new Set(DEFAULT_CATEGORIES),
  finding: false,
  results: [],
  allCandidates: [],   // raw fetched places with eta_a_s/eta_b_s, used for re-sorting
  sortMode: "midpoint", // "midpoint" | "fair" | "total"
  mid: null,
  a: null,
  b: null,
  // Map from {search: rank} so we can rotate viewpoints on the same result
  // set without re-querying the geocoders.
  shareOn: false,
  suggestFocus: null,  // { side, idx } for arrow-key nav
};

// ----- dom -----
const $ = (sel) => document.querySelector(sel);
const els = {
  inputA:     $("#input-a"),
  inputB:     $("#input-b"),
  metaA:      document.querySelector('[data-meta="a"]'),
  metaB:      document.querySelector('[data-meta="b"]'),
  suggA:      document.querySelector('[data-suggestions="a"]'),
  suggB:      document.querySelector('[data-suggestions="b"]'),
  findBtn:    $("#find-btn"),
  hint:       $("#hint"),
  chips:      document.querySelectorAll(".chip"),
  resultList: $("#result-list"),
  results:    $("#results"),
  resultsSub: $("#results-sub"),
  mapEl:      $("#map"),
  aboutBtn:   $("#about-btn"),
  aboutDlg:   $("#about-dlg"),
  locateBtns: document.querySelectorAll(".locate-btn"),
  liveStatus: document.getElementById("live-status"),
  shareBtn: document.getElementById("share-btn"),
  shortcutsBtn: document.getElementById("shortcuts-btn"),
  shortcutsDlg: document.getElementById("shortcuts-dlg"),
  pair: document.querySelector(".pair"),
};

// ----- map -----
const map = new MidpointMap("map");

// ============================================================
//  i18n hookup
// ============================================================

window.addEventListener("langchange", () => {
  // re-render any visible results + hint so labels are translated
  if (state.results.length) renderResults(state.results);
  updateFindBtn();
});

// ============================================================
//  input handlers
// ============================================================

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

const onInputA = debounce(() => fetchSuggestions("a"), DEBOUNCE_MS);
const onInputB = debounce(() => fetchSuggestions("b"), DEBOUNCE_MS);

async function fetchSuggestions(side) {
  const s = state.sides[side];
  const el = els[`input${side.toUpperCase()}`];
  const suggEl = els[`sugg${side.toUpperCase()}`];
  const q = el.value.trim();

  if (q.length < SUGGEST_MIN_CHARS) {
    hideSuggestions(side);
    s.suggestions = [];
    s.point = null;
    setMeta(side, "", "");
    updateFindBtn();
    return;
  }

  if (s.busy) return;
  s.busy = true;
  el.classList.add("is-loading");
  setMeta(side, t("hint.geocode"), "loading");

  const mySeq = ++s.reqSeq;
  try {
    const results = await geocode(q);
    if (mySeq !== s.reqSeq) return; // a newer keystroke superseded us
    s.suggestions = results;
    renderSuggestions(side, results);
    if (results.length) {
      setMeta(side, t("hint.ready_choose"), "");
    } else {
      setMeta(side, t("geo.no_match"), "err");
    }
  } catch (e) {
    if (e.name === "AbortError") return;
    if (e.code === "ZERO_RESULTS") {
      hideSuggestions(side);
      s.suggestions = [];
      setMeta(side, t("geo.no_match"), "err");
    } else if (e.code === "RATE_LIMITED") {
      setMeta(side, t("geo.rate"), "err");
    } else {
      setMeta(side, t("geo.fail"), "err");
    }
  } finally {
    s.busy = false;
    el.classList.remove("is-loading");
    updateFindBtn();
  }
}

function renderSuggestions(side, results) {
  const list = els[`sugg${side.toUpperCase()}`];
  list.innerHTML = "";
  if (!results.length) { hideSuggestions(side); return; }
  for (const r of results) {
    const li = document.createElement("li");
    li.className = "suggestion";
    li.setAttribute("role", "option");
    li.tabIndex = 0;
    li.dataset.lat = r.lat;
    li.dataset.lon = r.lon;
    li.dataset.display = r.display_name;
    li.dataset.type = r.type || "";
    li.innerHTML = `
      <span class="sugg-icon" aria-hidden="true">${suggestionGlyph(side)}</span>
      <span class="sugg-text">${escapeHtml(shortenName(r.display_name))}</span>
    `;
    // Mark focused suggestion for keyboard nav
    if (side === state.suggestFocus?.side && idx === state.suggestFocus?.idx) {
      li.classList.add("is-focused");
    }
    li.addEventListener("mousedown", (e) => {
      // mousedown fires before blur — keeps the dropdown from closing first
      e.preventDefault();
      pickSuggestion(side, r);
    });
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        pickSuggestion(side, r);
      }
    });
    // Hover should also set the "focused" item so keyboard + mouse agree
    li.addEventListener("mouseenter", () => moveFocus(side, idx));
    list.appendChild(li);
  }
  list.hidden = false;
  // If an existing arrow-key selection is past the new list length, clamp it
  if (state.suggestFocus?.side === side && state.suggestFocus.idx >= results.length) {
    moveFocus(side, Math.max(0, results.length - 1));
  }
}

function moveFocus(side, idx) {
  const list = els[`sugg${side.toUpperCase()}`];
  state.suggestFocus = { side, idx };
  for (const li of list.children) li.classList.remove("is-focused");
  if (list.children[idx]) {
    list.children[idx].classList.add("is-focused");
    list.children[idx].scrollIntoView({ block: "nearest" });
  }
}

function suggestionGlyph(side) {
  // mini marker matching the side dot
  return side === "a" ? "A" : "B";
}

function pickSuggestion(side, result) {
  const s = state.sides[side];
  s.point = result;
  els[`input${side.toUpperCase()}`].value = shortenName(result.display_name);
  setMeta(side, truncate(result.display_name, 90), "ok");
  hideSuggestions(side);
  map.setSide(side, { lat: result.lat, lon: result.lon });
  map.flyTo({ lat: result.lat, lon: result.lon }, 12);
  updateFindBtn();
}

function hideSuggestions(side) {
  const list = els[`sugg${side.toUpperCase()}`];
  list.hidden = true;
  list.innerHTML = "";
}

function shortenName(display) {
  // Trim trailing country when the display name is very long
  const parts = display.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 3) return display;
  return parts.slice(0, 3).join(", ");
}

function setMeta(side, text, cls) {
  const el = els[`meta${side.toUpperCase()}`];
  el.textContent = text;
  el.className = "loc-meta" + (cls ? " " + cls : "");
}

function truncate(s, n) {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

// Hide dropdowns when the user clicks anywhere else
document.addEventListener("mousedown", (e) => {
  for (const side of ["a", "b"]) {
    const field = els[`input${side.toUpperCase()}`].closest(".loc-field");
    if (field && !field.contains(e.target)) hideSuggestions(side);
  }
});

// Keyboard nav inside the input — Escape closes the dropdown,
// arrow keys move through suggestions, Enter picks the focused one.
function arrowKeyMove(side, dir) {
  const list = els[`sugg${side.toUpperCase()}`];
  if (list.hidden) return;
  const n = list.children.length;
  if (!n) return;
  let cur = state.suggestFocus?.side === side ? state.suggestFocus.idx : -1;
  if (cur < 0) cur = dir > 0 ? -1 : n;  // start at -1 going down, n-1 going up
  let next = cur + dir;
  next = (next + n) % n;
  moveFocus(side, next);
  // Mirror the focused suggestion's name into the input as a "type ahead"
  // so the user sees what they're about to pick.
  const picked = state.sides[side].suggestions[next];
  if (picked) {
    els[`input${side.toUpperCase()}`].value = shortenName(picked.display_name);
    // Mark this is a "preview" so onInput doesn't overwrite on blur
    state.sides[side]._previewIdx = next;
  }
}
els.inputA.addEventListener("keydown", (e) => {
  if (e.key === "Escape")     { hideSuggestions("a"); }
  else if (e.key === "ArrowDown") { e.preventDefault(); arrowKeyMove("a", +1); }
  else if (e.key === "ArrowUp")   { e.preventDefault(); arrowKeyMove("a", -1); }
  else if (e.key === "Enter") {
    hideSuggestions("a");
    const f = state.suggestFocus?.side === "a" ? state.suggestFocus.idx : 0;
    const picked = state.sides.a.suggestions[f];
    if (picked) { pickSuggestion("a", picked); e.preventDefault(); }
    else { onInputA(); }
  }
});
els.inputB.addEventListener("keydown", (e) => {
  if (e.key === "Escape")     { hideSuggestions("b"); }
  else if (e.key === "ArrowDown") { e.preventDefault(); arrowKeyMove("b", +1); }
  else if (e.key === "ArrowUp")   { e.preventDefault(); arrowKeyMove("b", -1); }
  else if (e.key === "Enter") {
    hideSuggestions("b");
    const f = state.suggestFocus?.side === "b" ? state.suggestFocus.idx : 0;
    const picked = state.sides.b.suggestions[f];
    if (picked) { pickSuggestion("b", picked); e.preventDefault(); }
    else { onInputB(); }
  }
});

// ============================================================
//  hint + button state
// ============================================================

function updateFindBtn() {
  const ready = state.sides.a.point && state.sides.b.point && !state.finding;
  els.findBtn.disabled = !ready;
  els.findBtn.classList.toggle("is-loading", state.finding);

  // If we just rendered results, keep the "done" hint visible -- otherwise
  // calling updateFindBtn() in finally{} would clobber it back to "ready".
  if (state.results.length > 0 && !state.finding) return;

  if (state.finding) {
    setHint(t("hint.places"), "");
  } else if (!state.sides.a.point && !state.sides.b.point) {
    setHint(t("hint.start"), "");
  } else if (!state.sides.a.point) {
    setHint(t("hint.a_need"), "warn");
  } else if (!state.sides.b.point) {
    setHint(t("hint.b_need"), "warn");
  } else if (state.categories.size === 0) {
    setHint(t("hint.cats_need"), "warn");
  } else {
    setHint(t("hint.ready"), "ok");
  }
}

function setHint(text, cls) {
  els.hint.textContent = text;
  els.hint.className = "hint" + (cls ? " " + cls : "");
}

// ============================================================
//  category chips
// ============================================================

els.chips.forEach((chip) => {
  chip.addEventListener("click", () => {
    const cat = chip.dataset.cat;
    if (state.categories.has(cat)) {
      if (state.categories.size === 1) {
        toast(t("toast.cats_one"));
        return;
      }
      state.categories.delete(cat);
      chip.classList.remove("is-on");
      chip.setAttribute("aria-pressed", "false");
    } else {
      state.categories.add(cat);
      chip.classList.add("is-on");
      chip.setAttribute("aria-pressed", "true");
    }
    updateFindBtn();
  });
});

// ============================================================
//  geolocation buttons
// ============================================================

els.locateBtns.forEach((btn) => {
  btn.addEventListener("click", async () => {
    const side = btn.dataset.side;
    if (!("geolocation" in navigator)) {
      toast("browser doesn't support location");
      return;
    }
    btn.disabled = true;
    const label = btn.querySelector("span");
    const original = label.textContent;
    label.textContent = "...";
    try {
      const pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: false,
          timeout: 10_000,
          maximumAge: 60_000,
        });
      });
      const { latitude: lat, longitude: lon } = pos.coords;
      const r = await reverseGeocode(lat, lon).catch(() => null);
      const display = r?.display_name || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
      els[`input${side.toUpperCase()}`].value = shortenName(display);
      state.sides[side].point = { lat, lon, display_name: display };
      setMeta(side, truncate(display, 90), "ok");
      hideSuggestions(side);
      map.setSide(side, { lat, lon });
      map.flyTo({ lat, lon }, 13);
    } catch (e) {
      const code = e?.code;
      const msg =
        code === 1 ? t("geo.perm") :
        code === 2 ? t("geo.unavail") :
        code === 3 ? t("geo.timeout") :
                     t("geo.fail_btn");
      toast(msg);
    } finally {
      btn.disabled = false;
      label.textContent = original;
      updateFindBtn();
    }
  });
});

// ============================================================
//  find midpoint
// ============================================================

els.findBtn.addEventListener("click", runPipeline);

async function runPipeline() {
  if (state.finding) return;
  if (!state.sides.a.point || !state.sides.b.point) return;
  if (state.categories.size === 0) return;

  state.finding = true;
  state.results = [];
  els.results.hidden = true;
  els.resultList.innerHTML = "";
  map.clearPlaces();
  map.clearLines();
  updateFindBtn();

  const a = state.sides.a.point;
  const b = state.sides.b.point;
  const mid = midpoint(a, b);
  state.mid = mid;
  state.a = a;
  state.b = b;
  const directM = haversine(a, b);

  map.setSide("a", a);
  map.setSide("b", b);
  map.setMidpoint(mid);

  // Draw the "fair zone" circles -- one around each endpoint with radius
  // equal to directM * 0.5. Their intersection is the area where a truly
  // fair meeting point could exist.
  map.clearCircles();
  const fairRadius = Math.max(800, directM * 0.5);
  map.drawFairCircle(a, fairRadius, { color: "#7ec8ff", fillOpacity: 0.06 });
  map.drawFairCircle(b, fairRadius, { color: "#c8a2ff", fillOpacity: 0.06 });

  map.drawLine(a, mid, { color: "#7ec8ff", opacity: 0.45 });
  map.drawLine(b, mid, { color: "#c8a2ff", opacity: 0.45 });
  map.fitTo([a, b, mid]);
  map.invalidate();

  try {
    setHint(t("hint.places"), "");
    // 1.4x the fair zone — slightly generous, since real-world driving
    // distance is typically 1.2-1.5x the straight line, and a place 10%
    // outside the strict "fair" ring might still be the best vibe option.
    const candidateFilterM = fairRadius * 1.4;
    const anchors = buildAnchors(a, b, directM, fairRadius);

    // Length-aware per-anchor radius: each line/corridor anchor must reach
    // far enough that adjacent anchors OVERLAP, otherwise we leave gaps in
    // the corridor. The required reach is `directM / lineSamples` -- equal
    // to the gap between adjacent samples, so each circle reaches into its
    // neighbour. For Beylikdüzü↔Kartal (50km, 7 samples) that's ~6700m,
    // vs the old hard-coded 800m which made whole stretches of corridor
    // appear empty. The 2x Photon distance filter on top still trims hits
    // that drift outside the immediate circle.
    const lineSamplesN = directM < 15000 ? 5 : 7;
    const perAnchorM = Math.max(RADIUS_M, Math.ceil(directM / lineSamplesN));
    // Length-aware expanding fallback cap: at minimum, the widening should
    // cover 40% of the line so even when the strict corridor returns
    // nothing the safety net reaches into the populated half of the city.
    // For a 50km line that's 20km -- pretty much the whole of Istanbul.
    const maxRadiusM = Math.max(9000, Math.ceil(directM * 0.4));

    // findPlacesAlways tries the smart anchor set first with the scaled
    // radius; if that returns fewer than 5 places (or zero), it widens
    // the search around the geographic midpoint with progressively larger
    // radii up to maxRadiusM. If STILL empty, falls back to a 3x3 grid
    // search across the entire A↔B bounding box -- this is the ultimate
    // "guaranteed suggestions" safety net for any reasonable input.
    const allPlaces = await findPlacesAlways(anchors, [...state.categories], mid, {
      startRadiusM: perAnchorM,
      stepM: Math.max(1500, Math.ceil(directM * 0.1)),
      maxRadiusM,
      minResults: 5,
      bboxA: a,
      bboxB: b,
    });

    // Drop places whose straight-line distance from BOTH endpoints exceeds
    // candidateFilterM -- those would never be fair no matter what traffic
    // does. This is a hard pre-filter before the expensive OSRM call.
    // Note: candidateFilterM is the FAIR ZONE × 1.4, which grows with line
    // length (e.g. 35km for Beylikdüzü↔Kartal at 50km) so this is generous
    // enough that the user's guarantee ("always suggest something") holds.
    let candidates = allPlaces
      .filter((p) => haversine(a, p) <= candidateFilterM && haversine(b, p) <= candidateFilterM)
      .slice(0, MAX_CANDIDATES);

    // If the strict fair-zone filter dropped everything, fall back to the
    // unfiltered set. The user wanted "somewhere further for both of them
    // but it should still list" -- so we relax the cap rather than show
    // zero results.
    if (candidates.length === 0) {
      candidates = allPlaces.slice(0, MAX_CANDIDATES);
    }

    if (candidates.length === 0) {
      // Even the expanding-radius search came up empty. Surface a clear
      // hint that the user can try a different category.
      setHint(t("hint.no_places"), "warn");
      return;
    }

    setHint(t("hint.routing"), "");
    let matrix;
    try {
      matrix = await osrmTable(
        [a, b],
        candidates.map((p) => [p.lon, p.lat])
      );
    } catch (e) {
      console.warn("OSRM unavailable, falling back to straight-line ETA:", e?.message || e);
      matrix = null;
    }

    const enriched = candidates.map((p, i) => {
      // Prefer OSRM's real ETA; fall back to straight-line estimate if it
      // failed, returned null, or returned 0 (which OSRM does for distances
      // shorter than its routing resolution).
      const osrmA = matrix?.durations?.[0]?.[i];
      const osrmB = matrix?.durations?.[1]?.[i];
      const useOsrmA = Number.isFinite(osrmA) && osrmA > 0;
      const useOsrmB = Number.isFinite(osrmB) && osrmB > 0;
      return {
        ...p,
        eta_a_s: useOsrmA ? osrmA : haversineEta(haversine(a, p)),
        eta_b_s: useOsrmB ? osrmB : haversineEta(haversine(b, p)),
        distance_a_m: matrix?.distances?.[0]?.[i] ?? haversine(a, p),
        distance_b_m: matrix?.distances?.[1]?.[i] ?? haversine(b, p),
      };
    });

    // Rank: default to "fairest & closest to midpoint" -- a place that's
    // roughly equidistant from BOTH endpoints AND not 30km off the axis
    // (which pure fairness could pick). Other modes ("most fair", "shortest
    // total") are available via the sort tabs -- toggling just re-sorts the
    // same set, no re-fetch.
    state.allCandidates = enriched;
    const ranked = applySort(enriched, state.sortMode, mid, a, b).slice(0, MAX_RESULTS);
    state.results = ranked;
    renderResults(ranked);
    renderMapPlaces(ranked);
    setHint(t("hint.done"), "ok");
    // scroll the user to the results
    setTimeout(() => els.results.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
  } catch (e) {
    const msg =
      e?.code === "RATE_LIMITED" ? t("hint.rate") :
      e?.code === "OVERPASS_FAILED" ? t("hint.fail") :
      e?.code === "ZERO_RESULTS" ? t("geo.no_match") :
      t("hint.fail");
    setHint(msg, "err");
    console.error(e);
  } finally {
    state.finding = false;
    updateFindBtn();
  }
}

/**
 * Build the list of search anchors based on how far apart A and B are.
 *
 * - Very close (<2km):  just use endpoints + midpoint
 * - Medium (2-15km):     endpoints + 5 line samples + 1 mid
 * - Far (>15km):         endpoints + 7 line samples + perpendicular corridor
 *
 * The point: for Kadıköy↔Kartal (~14km across the Marmara coast), the
 * geographic midpoint is in the sea. We MUST search along the line between
 * them, not just at the midpoint.
 */
function buildAnchors(a, b, directM, fairRadius) {
  const out = [];
  // Endpoints with a tight radius -- "near A but not at A" is a valid pick
  out.push(a, b);

  if (directM < 2000) {
    // Very close: midpoint is enough
    out.push(midpoint(a, b));
    return out;
  }

  const lineSamples = directM < 15000 ? 5 : 7;
  for (const p of sampleAlongLine(a, b, lineSamples)) {
    out.push(p);
    // For longer distances, also sample off the line in case the straight
    // line passes through a sea/mountain but cafes live on the coast nearby.
    // The corridor reach must also grow with directM, otherwise for very
    // long lines the perpendicular sampling misses whole districts.
    if (directM >= 5000) {
      const brg = bearing(a, b);
      // Corridor offset = 1/4 of the line length, capped so it stays
      // reasonable. For 50km line that's 12.5km -- covers a wide swath.
      const corridorOffset = Math.min(20000, Math.max(800, Math.ceil(directM * 0.25)));
      out.push(offsetPoint(p,  corridorOffset, brg + 90));
      out.push(offsetPoint(p, -corridorOffset, brg + 90));
    }
  }

  // TANGENT CHORD: the two fair-zone circles (one around A, one around B,
  // both radius fairRadius) have external tangent points. The line between
  // those points -- perpendicular to A->B, offset by fairRadius -- is
  // where places are equidistant from BOTH endpoints. Add several anchors
  // along this chord so we don't miss genuinely fair meeting points.
  if (directM >= 2000) {
    for (const p of tangentChordAnchors(a, b, fairRadius, lineSamples)) {
      out.push(p);
    }
  }

  // Always include the geographic midpoint too.
  out.push(midpoint(a, b));

  // Dedupe by ~50m.
  const seen = [];
  const deduped = [];
  for (const p of out) {
    const dupe = seen.some((q) => haversine(p, q) < 50);
    if (!dupe) { seen.push(p); deduped.push(p); }
  }
  return deduped;
}

// ============================================================
//  render results
// ============================================================

function renderResults(ranked) {
  els.resultList.innerHTML = "";
  els.results.hidden = false;
  const catLabels = [...state.categories].map((c) => t("cat.label")[c] || c);
  els.resultsSub.textContent = t("results.sub", ranked.length, catLabels);
  // Announce the count to screen readers -- the role="status" region
  // is aria-live=polite so it doesn't interrupt other announcements.
  if (els.liveStatus) els.liveStatus.textContent = `${ranked.length} ${t("results.title")}`;

  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i];
    const li = document.createElement("li");
    li.className = "result" + (i === 0 ? " is-top" : "");
    li.dataset.idx = i;
    li.dataset.placeId = r.id || `${r.lat},${r.lon}`;
    li.tabIndex = 0; // make focusable for keyboard users
    li.setAttribute("role", "button");
    li.setAttribute("aria-label", `${r.name}, ${fmtEta(r.eta_a_s)} from A, ${fmtEta(r.eta_b_s)} from B`);

    const fair = isFair(r);
    const delta = Math.abs((r.eta_a_s ?? 0) - (r.eta_b_s ?? 0));
    const fairHtml = fair
      ? `<span class="fair-badge">${t("fair")}</span>`
      : `<span class="fair-badge unfair">${t("unfair", fmtEta(delta))}</span>`;

    // Project onto the A→B axis: gives us "how fair geometrically" the
    // place is. We surface this on the row so the user can SEE WHY a
    // particular place was ranked where it was -- no opacity-engine.
    let onAxisKm = null;
    if (state.a && state.b) {
      const proj = projectOntoAxis(state.a, state.b, r);
      onAxisKm = proj.perpM / 1000;
    }
    const distMid = state.mid ? haversine(state.mid, r) : 0;
    const etaA = fmtEta(r.eta_a_s);
    const etaB = fmtEta(r.eta_b_s);

    // Build the explain-why popover so the user can hover any result and
    // see "why is this #1?" (fairness, axis-projection, distance to mid)
    const explain = `Δ ${fmtEta(delta)} · ${onAxisKm != null ? `${onAxisKm.toFixed(onAxisKm < 1 ? 2 : 1)}km off-axis · ` : ""}${fmtDist(distMid)} from mid`;

    const catName = t("cat.label")[r.category] || r.category;
    const mapsUrl  = mapsDeepLink(r.lat, r.lon, r.name);
    const appleMaps = `https://maps.apple.com/?daddr=${r.lat},${r.lon}`;
    li.innerHTML = `
      <span class="result-rank">${i + 1}</span>
      <div class="result-main">
        <p class="result-name">${escapeHtml(r.name)}</p>
        <span class="result-cat">${escapeHtml(catName)} · ${fmtDist(distMid)} ${t("fromMid")}</span>
        <span class="result-explain">${escapeHtml(explain)}</span>
      </div>
      <div class="result-etas">
        <span class="eta eta-a"><span class="eta-dot" aria-hidden="true"></span><span class="eta-label" data-i18n="eta.fromA">a</span><strong>${etaA}</strong></span>
        <span class="eta eta-b"><span class="eta-dot" aria-hidden="true"></span><span class="eta-label" data-i18n="eta.fromB">b</span><strong>${etaB}</strong></span>
        ${fairHtml}
      </div>
      <div class="result-actions">
        <a class="ghost-btn map-link" href="${mapsUrl}" target="_blank" rel="noopener" aria-label="Open in Google Maps" data-i18n-title="maps.google" title="open in google maps">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
        </a>
        <a class="ghost-btn map-link" href="${appleMaps}" target="_blank" rel="noopener" aria-label="Open in Apple Maps" data-i18n-title="maps.apple" title="open in apple maps">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2l3.5 7H22l-5.5 4.5L18.5 21 12 16 5.5 21l2-7.5L2 9h6.5L12 2z"/></svg>
        </a>
      </div>
    `;

    // Hover/focus syncs the map marker pulse
    li.addEventListener("mouseenter", () => map.focusPlace(i, true));
    li.addEventListener("mouseleave", () => map.focusPlace(i, false));
    li.addEventListener("focus", () => map.focusPlace(i, true));
    li.addEventListener("blur", () => map.focusPlace(i, false));

    li.addEventListener("click", (e) => {
      // Don't trigger when clicking the map links
      if (e.target.closest(".map-link")) return;
      map.flyTo({ lat: r.lat, lon: r.lon }, 16);
      document.querySelectorAll(".place-marker").forEach((m) => m.classList.remove("is-top", "is-pulse"));
      const m = map.markers.places[i];
      if (m && m.getElement) {
        const el = m.getElement();
        const inner = el.querySelector(".place-marker");
        if (inner) {
          inner.classList.add("is-top", "is-pulse");
          setTimeout(() => inner.classList.remove("is-pulse"), 1200);
        }
      }
    });

    els.resultList.appendChild(li);
  }
}

/**
 * Build a Google Maps "directions here" deep link. Falls back to a plain
 * "place pin" if we don't have coordinates.
 */
function mapsDeepLink(lat, lon, name) {
  const q = encodeURIComponent(`${lat},${lon}`);
  return `https://www.google.com/maps/dir/?api=1&destination=${q}&travelmode=driving`;
}

function renderMapPlaces(ranked) {
  map.clearPlaces();
  ranked.forEach((r, i) => map.addPlace(r, i, { isTop: i === 0 }));
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ============================================================
//  toast
// ============================================================

let toastEl = null;
let toastTimer = null;
function toast(msg, isErr = false) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.className = "toast";
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.toggle("is-err", !!isErr);
  toastEl.classList.add("is-show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("is-show"), 2500);
}

// ============================================================
//  about dialog
// ============================================================

els.aboutBtn.addEventListener("click", () => {
  if (typeof els.aboutDlg.showModal === "function") {
    els.aboutDlg.showModal();
  } else {
    alert("midpoint — " + t("about.p1"));
  }
});

// ============================================================
//  sort tabs (closest to midpoint / most fair / min total time)
// ============================================================

/**
 * Apply the current sort mode to the candidates. Pure function over a copy.
 * `mid` is required for "midpoint" mode; falls back to fairness sort if
 * somehow missing (shouldn't happen).
 */
function applySort(candidates, mode, mid, a, b) {
  if (mode === "fair")   return rankByFairnessFirst(candidates);
  if (mode === "total")  return rankByTotalDrive(candidates);
  return rankByFairestFromMid(candidates, mid, a, b); // default
}

// Re-sort whenever a sort tab is clicked. Uses cached `allCandidates`
// so no network round-trip.
const sortTabs = document.querySelectorAll(".sort-tab");
sortTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const mode = tab.dataset.sort;
    if (!mode || mode === state.sortMode) return;
    state.sortMode = mode;
    sortTabs.forEach((t) => {
      const active = t.dataset.sort === mode;
      t.classList.toggle("is-active", active);
      t.setAttribute("aria-selected", active ? "true" : "false");
    });
    if (!state.allCandidates.length || !state.mid) return;
    const ranked = applySort(state.allCandidates, state.sortMode, state.mid, state.a, state.b).slice(0, MAX_RESULTS);
    state.results = ranked;
    renderResults(ranked);
    renderMapPlaces(ranked);
  });
});

// ============================================================
//  wire up
// ============================================================

els.inputA.addEventListener("input", onInputA);
els.inputB.addEventListener("input", onInputB);

updateFindBtn();

// Invalidate map size when results appear (layout shift)
const mo = new MutationObserver(() => map.invalidate());
mo.observe(els.results, { attributes: true, attributeFilter: ["hidden"] });

// Apply translations on load (in case DOMContentLoaded fired before module ran)
if (document.readyState !== "loading") applyTranslations();
else document.addEventListener("DOMContentLoaded", applyTranslations);

// ============================================================
//  share URL with both addresses encoded — survives reloads,
//  helps users send the same search to a friend or themselves.
// ============================================================
function readShareUrl() {
  try {
    const p = new URL(location.href).searchParams;
    return {
      a: p.get("a") || "",
      b: p.get("b") || "",
      cats: (p.get("cats") || "").split(",").filter(Boolean),
      sort: p.get("sort") || "midpoint",
    };
  } catch { return { a: "", b: "", cats: [], sort: "midpoint" }; }
}

function writeShareUrl() {
  const s = state.sides.a.point && state.sides.b.point;
  if (!s) return false;
  const a = state.sides.a.input.value.trim();
  const b = state.sides.b.input.value.trim();
  if (!a || !b) return false;
  const cats = [...state.categories].join(",");
  const url = new URL(location.href);
  url.searchParams.set("a", a);
  url.searchParams.set("b", b);
  if (cats && cats !== DEFAULT_CATEGORIES.join(",")) {
    url.searchParams.set("cats", cats);
  } else {
    url.searchParams.delete("cats");
  }
  if (state.sortMode !== "midpoint") {
    url.searchParams.set("sort", state.sortMode);
  } else {
    url.searchParams.delete("sort");
  }
  history.replaceState(null, "", url.toString());
  return true;
}

// Restore from URL on first load, ONCE the geocoders are ready. We mark
// the inputs with the saved text and let the existing input handlers
// run the geocode; once both sides have points, we fire runPipeline if
// the user came here with a real saved pair.
function restoreFromShareUrl() {
  const share = readShareUrl();
  if (!share.a || !share.b) return;
  if (els.inputA.value !== share.a) els.inputA.value = share.a;
  if (els.inputB.value !== share.b) els.inputB.value = share.b;
  // Apply saved categories (preserve defaults if not specified)
  if (share.cats.length > 0) {
    // Clear all then add the saved ones
    for (const cat of state.categories) {
      // ... we need to toggle off, but state.categories starts at DEFAULT_CATEGORIES
    }
    // Simplify: re-set state and chip UI
    state.categories.clear();
    share.cats.forEach((c) => state.categories.add(c));
    els.chips.forEach((chip) => {
      const on = state.categories.has(chip.dataset.cat);
      chip.classList.toggle("is-on", on);
      chip.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }
  if (share.sort && share.sort !== state.sortMode) {
    state.sortMode = share.sort;
    const tab = document.querySelector(`.sort-tab[data-sort="${share.sort}"]`);
    if (tab) tab.click();
  }
  // Geocode both via the same handler the live input uses. They fire in
  // parallel and each will call setMeta + show a dropdown when done.
  onInputA(); onInputB();
  // Watchdog: if the geocoders resolve and both sides get points, kick
  // off the pipeline automatically. 12s budget -- if Photon is slow we
  // don't want to wait forever.
  let ticks = 0;
  const ticker = setInterval(() => {
    ticks++;
    if (state.sides.a.point && state.sides.b.point && !state.finding) {
      clearInterval(ticker);
      runPipeline();
      return;
    }
    if (ticks > 60) clearInterval(ticker);
  }, 200);
}

// Wire share button
if (els.shareBtn) {
  els.shareBtn.addEventListener("click", async () => {
    if (!state.sides.a.point || !state.sides.b.point) {
      toast(t("toast.share_need"), true);
      return;
    }
    if (writeShareUrl()) {
      const url = location.href;
      try {
        await navigator.clipboard.writeText(url);
        toast(t("toast.share_ok"));
      } catch {
        // Clipboard blocked -- just select the URL bar via the dialog
        prompt(t("toast.share_copy"), url);
      }
    } else {
      toast(t("toast.share_need"), true);
    }
  });
}

// ============================================================
//  keyboard shortcuts (? to show, Cmd/Ctrl+K to focus input)
// ============================================================
document.addEventListener("keydown", (e) => {
  // ? opens shortcuts (but only when not typing in an input)
  if (e.key === "?" && !e.target.closest("input, textarea")) {
    e.preventDefault();
    if (els.shortcutsDlg?.showModal) els.shortcutsDlg.showModal();
    return;
  }
  // Cmd/Ctrl+K -- focus the first empty input (or input-a)
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    const target = !els.inputA.value ? els.inputA
                : !els.inputB.value ? els.inputB
                : els.inputA;
    target.focus();
    target.select?.();
    return;
  }
  // Enter inside inputs already handled. Escape while at top level closes
  // any open dialog. We don't want Escape to mess with the
  // suggestion-dropdown close which is handled per-input above.
});

// ============================================================
//  result-list keyboard navigation (↑/↓ to move highlight, Enter to focus map)
// ============================================================
els.resultList.addEventListener("keydown", (e) => {
  const rows = [...els.resultList.querySelectorAll(".result")];
  if (!rows.length) return;
  const cur = rows.findIndex((r) => r === document.activeElement);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const dir = e.key === "ArrowDown" ? 1 : -1;
    const next = (cur + dir + rows.length) % rows.length;
    rows[next].focus();
    rows[next].click();
  } else if (e.key === "Home") {
    e.preventDefault();
    rows[0].focus();
  } else if (e.key === "End") {
    e.preventDefault();
    rows[rows.length - 1].focus();
  }
});

// Trigger the share-restore on first load -- but only if we landed here
// with both addresses already in the URL. We do this on a short delay so
// the geocoder / map / DOM are all ready to react.
if (readShareUrl().a && readShareUrl().b) {
  // wait for Leaflet + DOM, then restore
  setTimeout(restoreFromShareUrl, 100);
}

// ============================================================
//  third-person toggle ("meet in the middle of A and B" -- if anyone
//  else is invited, the midpoint shifts toward them too).
// ============================================================
// Hooked up here in case a future design adds a third input -- the data
// structures above already accommodate it (ranker takes a & b, we could
// pass c too). For now this is a no-op reserved hook so we don't break
// the URL/share flow.
