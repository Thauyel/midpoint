// ============================================================
//  app.js  --  entry point. Inputs, suggestion dropdowns, map,
//              pipeline, and i18n glue.
// ============================================================

import { geocode, reverse as reverseGeocode } from "./geocode.js?v=12";
import { findPlaces, findPlacesAlong } from "./places.js?v=12";
import { osrmTable } from "./routing.js?v=12";
import { midpoint, rankByFairness, rankByFairnessFirst, fmtEta, fmtDist, isFair, haversine, haversineEta, sampleAlongLine, corridorAnchors, offsetPoint, bearing } from "./midpoint.js?v=12";
import { MidpointMap } from "./map.js?v=12";
import { t, applyTranslations, getLanguage } from "./i18n.js?v=12";

const RADIUS_M = 800;            // per-anchor POI search radius
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
  mid: null,
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
    list.appendChild(li);
  }
  list.hidden = false;
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

// Keyboard nav inside the input — Escape closes the dropdown
els.inputA.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideSuggestions("a");
  if (e.key === "Enter") { hideSuggestions("a"); onInputA(); }
});
els.inputB.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideSuggestions("b");
  if (e.key === "Enter") { hideSuggestions("b"); onInputB(); }
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

    const allPlaces = await findPlacesAlong(anchors, [...state.categories], RADIUS_M);
    if (allPlaces.length === 0) {
      setHint(t("hint.no_places"), "warn");
      return;
    }

    // Drop places whose straight-line distance from BOTH endpoints exceeds
    // candidateFilterM -- those would never be fair no matter what traffic
    // does. This is a hard pre-filter before the expensive OSRM call.
    const candidates = allPlaces
      .filter((p) => haversine(a, p) <= candidateFilterM && haversine(b, p) <= candidateFilterM)
      .slice(0, MAX_CANDIDATES);

    if (candidates.length === 0) {
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

    // Rank fairness-first: smallest |Δ| wins, total is the tiebreaker.
    const ranked = rankByFairnessFirst(enriched).slice(0, MAX_RESULTS);
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
    if (directM >= 5000) {
      const brg = bearing(a, b);
      out.push(offsetPoint(p,  Math.min(800, fairRadius * 0.5), brg + 90));
      out.push(offsetPoint(p, -Math.min(800, fairRadius * 0.5), brg + 90));
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

  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i];
    const li = document.createElement("li");
    li.className = "result" + (i === 0 ? " is-top" : "");
    li.dataset.idx = i;

    const fair = isFair(r);
    const fairHtml = fair
      ? `<span class="fair-badge">${t("fair")}</span>`
      : `<span class="fair-badge unfair">${t("unfair", fmtEta(Math.abs((r.eta_a_s ?? 0) - (r.eta_b_s ?? 0))))}</span>`;

    const catName = t("cat.label")[r.category] || r.category;
    li.innerHTML = `
      <span class="result-rank">${i + 1}</span>
      <div class="result-main">
        <p class="result-name">${escapeHtml(r.name)}</p>
        <span class="result-cat">${escapeHtml(catName)} · ${fmtDist(haversineFromMidpoint(r))}</span>
      </div>
      <div class="result-etas">
        <span class="eta eta-a"><span class="eta-dot"></span><strong>${fmtEta(r.eta_a_s)}</strong></span>
        <span class="eta eta-b"><span class="eta-dot"></span><strong>${fmtEta(r.eta_b_s)}</strong></span>
        ${fairHtml}
      </div>
    `;

    li.addEventListener("click", () => {
      map.flyTo({ lat: r.lat, lon: r.lon }, 16);
      document.querySelectorAll(".place-marker").forEach((m) => m.classList.remove("is-top"));
      const m = map.markers.places[i];
      if (m && m.getElement) {
        const el = m.getElement();
        const inner = el.querySelector(".place-marker");
        if (inner) inner.classList.add("is-top");
      }
    });

    els.resultList.appendChild(li);
  }
}

function renderMapPlaces(ranked) {
  map.clearPlaces();
  ranked.forEach((r, i) => map.addPlace(r, i, { isTop: i === 0 }));
}

function haversineFromMidpoint(p) {
  if (!state.mid) return 0;
  const R = 6371008.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const phi1 = toRad(state.mid.lat);
  const phi2 = toRad(p.lat);
  const dPhi = toRad(p.lat - state.mid.lat);
  const dLam = toRad(p.lon - state.mid.lon);
  const h =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLam / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
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