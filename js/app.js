// ============================================================
//  app.js  --  entry point. Wires inputs, map, and pipelines.
// ============================================================

import { geocode, reverse as reverseGeocode } from "./geocode.js";
import { findPlaces } from "./places.js";
import { osrmTable } from "./routing.js";
import { midpoint, rankByFairness, fmtEta, fmtDist, isFair } from "./midpoint.js";
import { MidpointMap } from "./map.js";

const RADIUS_M = 2000;
const DEBOUNCE_MS = 350;
const DEFAULT_CATEGORIES = ["cafe", "restaurant", "bar"];

// ----- state -----
const state = {
  sides: {
    a: { input: null, meta: null, point: null, busy: false },
    b: { input: null, meta: null, point: null, busy: false },
  },
  categories: new Set(DEFAULT_CATEGORIES),
  finding: false,
  results: [],
  mid: null,
};

// ----- dom -----
const $ = (sel) => document.querySelector(sel);
const els = {
  inputA:    $("#input-a"),
  inputB:    $("#input-b"),
  metaA:     document.querySelector('[data-meta="a"]'),
  metaB:     document.querySelector('[data-meta="b"]'),
  findBtn:   $("#find-btn"),
  hint:      $("#hint"),
  chips:     document.querySelectorAll(".chip"),
  resultList:$("#result-list"),
  results:   $("#results"),
  resultsSub:$("#results-sub"),
  mapEl:     $("#map"),
  aboutBtn:  $("#about-btn"),
  aboutDlg:  $("#about-dlg"),
  locateBtns: document.querySelectorAll(".locate-btn"),
};

// ----- map -----
const map = new MidpointMap("map");

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

const onInputA = debounce(() => resolveInput("a"), DEBOUNCE_MS);
const onInputB = debounce(() => resolveInput("b"), DEBOUNCE_MS);

async function resolveInput(side) {
  const s = state.sides[side];
  const el = els[`input${side.toUpperCase()}`];
  const metaEl = els[`meta${side.toUpperCase()}`];
  const q = el.value.trim();

  if (!q) {
    s.point = null;
    metaEl.textContent = "";
    metaEl.className = "loc-meta";
    updateFindBtn();
    return;
  }

  if (s.busy) return;
  s.busy = true;
  el.classList.add("is-loading");
  metaEl.textContent = "searching…";
  metaEl.className = "loc-meta";

  try {
    const result = await geocode(q);
    s.point = result;
    metaEl.textContent = truncate(result.display_name, 90);
    metaEl.className = "loc-meta ok";
    // live-drop a marker so the user can see what they typed
    map.setSide(side, { lat: result.lat, lon: result.lon });
    map.flyTo({ lat: result.lat, lon: result.lon }, 11);
  } catch (e) {
    s.point = null;
    if (e.code === "ZERO_RESULTS") {
      metaEl.textContent = "no match — try a more specific address";
    } else if (e.code === "RATE_LIMITED") {
      metaEl.textContent = "rate limited — slow down for a sec";
    } else if (e.name === "AbortError") {
      return; // user typed again, ignore
    } else {
      metaEl.textContent = "couldn't reach geocoder — check connection";
    }
    metaEl.className = "loc-meta err";
  } finally {
    s.busy = false;
    el.classList.remove("is-loading");
    updateFindBtn();
  }
}

function truncate(s, n) {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function updateFindBtn() {
  const ready = state.sides.a.point && state.sides.b.point && !state.finding;
  els.findBtn.disabled = !ready;
  if (state.finding) {
    els.findBtn.classList.add("is-loading");
    els.hint.textContent = "searching the area…";
    els.hint.className = "hint";
  } else if (!state.sides.a.point && !state.sides.b.point) {
    els.findBtn.classList.remove("is-loading");
    els.hint.textContent = "enter two places to begin.";
    els.hint.className = "hint";
  } else if (!state.sides.a.point) {
    els.findBtn.classList.remove("is-loading");
    els.hint.textContent = "type a place for Person A.";
    els.hint.className = "hint warn";
  } else if (!state.sides.b.point) {
    els.findBtn.classList.remove("is-loading");
    els.hint.textContent = "type a place for Person B.";
    els.hint.className = "hint warn";
  } else if (state.categories.size === 0) {
    els.findBtn.classList.remove("is-loading");
    els.hint.textContent = "pick at least one category.";
    els.hint.className = "hint warn";
  } else {
    els.findBtn.classList.remove("is-loading");
    els.hint.textContent = "ready — find a fair midpoint.";
    els.hint.className = "hint ok";
  }
}

// ============================================================
//  category chips
// ============================================================

els.chips.forEach((chip) => {
  chip.addEventListener("click", () => {
    const cat = chip.dataset.cat;
    if (state.categories.has(cat)) {
      // Don't allow zero selection — keep at least one
      if (state.categories.size === 1) {
        toast("at least one category must be on");
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
    const original = btn.querySelector("span").textContent;
    btn.querySelector("span").textContent = "locating…";
    try {
      const pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: false,
          timeout: 10_000,
          maximumAge: 60_000,
        });
      });
      const { latitude: lat, longitude: lon } = pos.coords;
      // Reverse-geocode so the user sees where they actually are
      const r = await reverseGeocode(lat, lon).catch(() => null);
      const display = r?.display_name || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
      els[`input${side.toUpperCase()}`].value = display;
      state.sides[side].point = { lat, lon, display_name: display };
      els[`meta${side.toUpperCase()}`].textContent = truncate(display, 90);
      els[`meta${side.toUpperCase()}`].className = "loc-meta ok";
      map.setSide(side, { lat, lon });
      map.flyTo({ lat, lon }, 13);
    } catch (e) {
      const msg = e?.code === e?.PERMISSION_DENIED
        ? "permission denied"
        : e?.code === e?.POSITION_UNAVAILABLE
        ? "location unavailable"
        : e?.code === e?.TIMEOUT
        ? "location timed out"
        : "couldn't get location";
      toast(msg);
    } finally {
      btn.disabled = false;
      btn.querySelector("span").textContent = original;
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

  map.setSide("a", a);
  map.setSide("b", b);
  map.setMidpoint(mid);
  map.drawLine(a, mid, { color: "#7ec8ff", opacity: 0.4 });
  map.drawLine(b, mid, { color: "#c8a2ff", opacity: 0.4 });
  map.fitTo([a, b, mid]);
  map.invalidate();

  try {
    els.hint.textContent = "finding nearby places…";
    els.hint.className = "hint";

    const places = await findPlaces(mid, [...state.categories], RADIUS_M);
    if (places.length === 0) {
      els.hint.textContent = "no places found in this area — try different categories or wider radius.";
      els.hint.className = "hint warn";
      return;
    }

    els.hint.textContent = "computing travel times…";
    els.hint.className = "hint";

    const matrix = await osrmTable(
      [a, b],
      places.map((p) => [p.lon, p.lat])
    );

    const enriched = places.map((p, i) => ({
      ...p,
      eta_a_s: matrix.durations[0]?.[i] ?? null,
      eta_b_s: matrix.durations[1]?.[i] ?? null,
      distance_a_m: matrix.distances[0]?.[i] ?? null,
      distance_b_m: matrix.distances[1]?.[i] ?? null,
    }));

    const ranked = rankByFairness(enriched).slice(0, 10);
    state.results = ranked;
    renderResults(ranked);
    renderMapPlaces(ranked);

    els.hint.textContent = `${ranked.length} places ranked by fairness.`;
    els.hint.className = "hint ok";
  } catch (e) {
    const msg =
      e?.code === "RATE_LIMITED" ? "rate limited — try again in a minute" :
      e?.code === "OVERPASS_FAILED" ? "places service unavailable — try again" :
      e?.code === "ZERO_RESULTS" ? "no matches for one of the addresses" :
      "something went wrong — check your connection";
    els.hint.textContent = msg;
    els.hint.className = "hint err";
    console.error(e);
  } finally {
    state.finding = false;
    updateFindBtn();
  }
}

// ============================================================
//  render results
// ============================================================

function renderResults(ranked) {
  els.resultList.innerHTML = "";
  els.results.hidden = false;
  els.resultsSub.textContent = `top ${ranked.length} • ${[...state.categories].join(" · ")}`;

  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i];
    const li = document.createElement("li");
    li.className = "result" + (i === 0 ? " is-top" : "");
    li.dataset.idx = i;

    const fair = isFair(r);
    const fairHtml = fair
      ? `<span class="fair-badge">fair</span>`
      : `<span class="fair-badge unfair">Δ ${fmtEta(Math.abs((r.eta_a_s ?? 0) - (r.eta_b_s ?? 0)))}</span>`;

    li.innerHTML = `
      <span class="result-rank">${i + 1}</span>
      <div class="result-main">
        <p class="result-name">${escapeHtml(r.name)}</p>
        <span class="result-cat">${escapeHtml(r.category)} · ${fmtDist(haversineFromMidpoint(r))}</span>
      </div>
      <div class="result-etas">
        <span class="eta eta-a"><span class="eta-dot"></span><strong>${fmtEta(r.eta_a_s)}</strong></span>
        <span class="eta eta-b"><span class="eta-dot"></span><strong>${fmtEta(r.eta_b_s)}</strong></span>
        ${fairHtml}
      </div>
    `;

    li.addEventListener("click", () => {
      map.flyTo({ lat: r.lat, lon: r.lon }, 16);
      // briefly highlight
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
  ranked.forEach((r, i) => {
    map.addPlace(r, i, { isTop: i === 0 });
  });
}

// tiny inline haversine to avoid an import cycle
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
    alert("midpoint — two places, one fair meeting point.");
  }
});

// ============================================================
//  wire up
// ============================================================

els.inputA.addEventListener("input", onInputA);
els.inputB.addEventListener("input", onInputB);
els.inputA.addEventListener("keydown", (e) => { if (e.key === "Enter") onInputA(); });
els.inputB.addEventListener("keydown", (e) => { if (e.key === "Enter") onInputB(); });

updateFindBtn();

// invalidate map size when results appear (layout shift)
const mo = new MutationObserver(() => map.invalidate());
mo.observe(els.results, { attributes: true, attributeFilter: ["hidden"] });