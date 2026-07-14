// ============================================================
//  i18n.js  --  translations + auto-detection + manual toggle
//
//  Usage:
//    import { t, applyTranslations, setLanguage, getLanguage } from "./i18n.js";
//    t("find")           // -> current translation
//    setLanguage("tr")   // persist + reapply
//    applyTranslations() // walk [data-i18n] in the DOM
//
//  Detection priority:
//    1. localStorage["midpoint.lang"] (manual override)
//    2. navigator.language  -> "tr" if starts with "tr", else "en"
//    3. fallback "tr"
// ============================================================

const STORAGE_KEY = "midpoint.lang";

const TRANSLATIONS = {
  tr: {
    "meta.title":    "midpoint — buluşma noktası bul",
    "tagline":       "iki yer · bir adil buluşma noktası",
    "locate":        "konumum",
    "label.person_a":"kişi a",
    "label.person_b":"kişi b",
    "placeholder.a": "adres, yer veya şehir…",
    "placeholder.b": "adres, yer veya şehir…",
    "cats.label":    "ne tür bir yer?",
    "cat.cafe":      "cafe",
    "cat.restaurant":"restoran",
    "cat.bar":       "bar",
    "cat.park":      "park",
    "cat.generic":   "hepsi",
    "find":          "ortayı bul",
    "hint.start":    "başlamak için iki yer gir.",
    "hint.a_need":   "kişi a için bir yer yaz.",
    "hint.b_need":   "kişi b için bir yer yaz.",
    "hint.cats_need":"en az bir kategori seç.",
    "hint.ready":    "hazır — adil bir orta nokta bul.",
    "hint.geocode":  "arama yapılıyor…",
    "hint.places":   "yakındaki yerler aranıyor…",
    "hint.routing":  "sürüş süreleri hesaplanıyor…",
    "hint.done":     (r) => `${(r/1000).toFixed(1)} km yarıçapta yerler listelendi.`,
    "hint.no_places":"bu bölgede yer bulunamadı — farklı kategori veya daha geniş alan dene.",
    "hint.rate":     "oran sınırı — biraz yavaşla.",
    "hint.fail":     "bir şey ters gitti — bağlantını kontrol et.",
    "results.title": "yakındaki en iyi yerler",
    "results.sub":   (n, cats) => `en iyi ${n} · ${cats.join(" · ")}`,
    "sort.midpoint": "en yakın orta nokta",
    "sort.fair":     "en adil",
    "sort.total":    "en kısa toplam",
    "eta.label":     (s) => `${s} dk`,
    "fair":          "adil",
    "unfair":        (d) => `Δ ${d}`,
    "cat.label":     {
      cafe:       "cafe",
      restaurant: "restoran",
      bar:        "bar",
      park:       "park",
      generic:    "genel",
    },
    "geo.no_match":  "eşleşme yok — daha spesifik bir adres dene.",
    "geo.rate":      "oran sınırı — biraz yavaşla.",
    "geo.fail":      "coğrafi kodlayıcıya ulaşılamadı — bağlantını kontrol et.",
    "geo.perm":      "konum izni reddedildi",
    "geo.unavail":   "konum kullanılamıyor",
    "geo.timeout":   "konum zaman aşımına uğradı",
    "geo.fail_btn":  "konum alınamadı",
    "about":         "hakkında",
    "about.p1":      "iki kişi, iki konum, bir adil buluşma noktası.",
    "about.p2":      "sıralama, her iki kişinin yaklaşık aynı sürede seyahat ettiği yerleri tercih eder — sonra toplam süreye göre.",
    "about.p3":      "sürüş tahminleri osrm üzerinden, yerler openstreetmap’ten. tarayıcınızdan çıkan tek şey bu genel servislerle yapılan isteklerdir.",
    "about.foot":    "hesap yok. takip yok. depolama yok.",
    "about.close":   "kapat",
    "toast.cats_one":"en az bir kategori açık olmalı",
    "toast.share_ok": "bağlantı panoya kopyalandı.",
    "toast.share_need": "önce iki konum seç.",
    "toast.share_copy": "bağlantıyı kopyala",
    "share":          "paylaş",
    "shortcuts":      "kısayollar",
    "shortcuts.title":"klavye kısayolları",
    "shortcuts.nav":  "önerilerde gezin",
    "shortcuts.pick": "seçili öneriyi kullan",
    "shortcuts.esc":  "önerileri kapat",
    "shortcuts.this": "bu listeyi göster",
    "shortcuts.focus":"ilk boş girişe odaklan",
    "fromMid":        "ortadan",
    "eta.fromA":      "a",
    "eta.fromB":      "b",
    "maps.google":    "google maps'te aç",
    "maps.apple":     "apple maps'te aç",
  },
  en: {
    "meta.title":    "midpoint — find where to meet",
    "tagline":       "two places · one fair meeting point",
    "locate":        "locate me",
    "label.person_a":"person a",
    "label.person_b":"person b",
    "placeholder.a": "address, place, or city…",
    "placeholder.b": "address, place, or city…",
    "cats.label":    "what kind of place?",
    "cat.cafe":      "cafe",
    "cat.restaurant":"restaurant",
    "cat.bar":       "bar",
    "cat.park":      "park",
    "cat.generic":   "any",
    "find":          "find midpoint",
    "hint.start":    "enter two places to begin.",
    "hint.a_need":   "type a place for person a.",
    "hint.b_need":   "type a place for person b.",
    "hint.cats_need":"pick at least one category.",
    "hint.ready":    "ready — find a fair midpoint.",
    "hint.geocode":  "searching…",
    "hint.places":   "finding nearby places…",
    "hint.routing":  "computing travel times…",
    "hint.done":     (r) => `${(r/1000).toFixed(1)} km circle — places ranked.`,
    "hint.no_places":"no places found in this area — try different categories or wider radius.",
    "hint.rate":     "rate limited — try again in a minute.",
    "hint.fail":     "something went wrong — check your connection.",
    "results.title": "best spots nearby",
    "results.sub":   (n, cats) => `top ${n} · ${cats.join(" · ")}`,
    "sort.midpoint": "closest to midpoint",
    "sort.fair":     "most fair",
    "sort.total":    "shortest total",
    "eta.label":     (s) => `${s} min`,
    "fair":          "fair",
    "unfair":        (d) => `Δ ${d}`,
    "cat.label":     {
      cafe:       "cafe",
      restaurant: "restaurant",
      bar:        "bar",
      park:       "park",
      generic:    "any",
    },
    "geo.no_match":  "no match — try a more specific address.",
    "geo.rate":      "rate limited — slow down for a sec.",
    "geo.fail":      "couldn't reach geocoder — check connection.",
    "geo.perm":      "permission denied",
    "geo.unavail":   "location unavailable",
    "geo.timeout":   "location timed out",
    "geo.fail_btn":  "couldn't get location",
    "about":         "about",
    "about.p1":      "two people, two locations, one fair meeting point.",
    "about.p2":      "ranking favors places where both people travel about the same time — then by shortest total.",
    "about.p3":      "driving estimates via osrm. places via openstreetmap. nothing leaves your browser except requests to those public services.",
    "about.foot":    "no accounts. no tracking. no storage.",
    "about.close":   "close",
    "toast.cats_one":"at least one category must be on",
    "toast.share_ok": "link copied to clipboard.",
    "toast.share_need":"pick two places first.",
    "toast.share_copy":"copy this link",
    "share":          "share",
    "shortcuts":      "shortcuts",
    "shortcuts.title":"keyboard shortcuts",
    "shortcuts.nav":  "navigate suggestions",
    "shortcuts.pick": "pick the focused suggestion",
    "shortcuts.esc":  "close the dropdown",
    "shortcuts.this": "show this list",
    "shortcuts.focus":"focus the first empty input",
    "fromMid":        "from mid",
    "eta.fromA":      "a",
    "eta.fromB":      "b",
    "maps.google":    "open in google maps",
    "maps.apple":     "open in apple maps",
  },
};

function detectLanguage() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "tr" || saved === "en") return saved;
  } catch (_) { /* localStorage may be blocked */ }
  const langs = (navigator.languages || [navigator.language || ""]).map((l) => l.toLowerCase());
  for (const l of langs) {
    if (l.startsWith("tr")) return "tr";
  }
  return "en";
}

let _lang = detectLanguage();

export function getLanguage() { return _lang; }

export function setLanguage(lang, { persist = true } = {}) {
  if (lang !== "tr" && lang !== "en") return;
  _lang = lang;
  if (persist) {
    try { localStorage.setItem(STORAGE_KEY, lang); } catch (_) {}
  }
  applyTranslations();
  // notify listeners (the toggle UI, the app state)
  window.dispatchEvent(new CustomEvent("langchange", { detail: { lang } }));
}

/**
 * Resolve a translation key for the current language.
 *   t("find")          -> string
 *   t("results.sub", 10, ["cafe","bar"])  -> function form
 *   t("cat.label.cafe") is NOT supported; use t("cat.label").cafe
 */
export function t(key, ...args) {
  const dict = TRANSLATIONS[_lang] || TRANSLATIONS.tr;
  const val = dict[key];
  if (val == null) return key;
  if (typeof val === "function") return val(...args);
  return val;
}

/**
 * Walk the document and replace text content of every [data-i18n]
 * element with the current translation.
 */
export function applyTranslations() {
  const html = document.documentElement;
  if (html) html.lang = _lang;

  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    const val = t(key);
    if (typeof val === "string") {
      // For elements with HTML entities like &middot; we set textContent
      // and the entity will display correctly because it lives in the
      // source markup. But textContent doesn't decode entities — so we
      // just use the entity-decoded string from a hidden test element.
      el.textContent = decodeEntities(val);
    }
  });

  // Update placeholders that are not [data-i18n] (kept in attribute only)
  const inputA = document.getElementById("input-a");
  const inputB = document.getElementById("input-b");
  if (inputA) inputA.placeholder = decodeEntities(t("placeholder.a"));
  if (inputB) inputB.placeholder = decodeEntities(t("placeholder.b"));

  // Update <title>
  const titleEl = document.querySelector("title[data-i18n]");
  if (titleEl) titleEl.textContent = decodeEntities(t("meta.title"));

  // Update the description meta
  const desc = document.querySelector('meta[name="description"]');
  if (desc && _lang === "tr") {
    desc.setAttribute("content", "İki kişi için adil bir buluşma noktası bulun. Cafe, restoran, bar veya park — eşit sürüş süresine göre sıralanmış.");
  } else if (desc) {
    desc.setAttribute("content", "Find a fair meeting point between two locations. Cafe, restaurant, bar, or park — ranked by equal travel time.");
  }

  // Toggle button pressed-state
  document.querySelectorAll(".lang-btn").forEach((b) => {
    const on = b.dataset.lang === _lang;
    b.classList.toggle("is-on", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

function decodeEntities(s) {
  // tiny entity decoder — covers the entities we actually use
  return s
    .replace(/&middot;/g, "·")
    .replace(/&mdash;/g, "—")
    .replace(/&hellip;/g, "…")
    .replace(/&times;/g, "×")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

// Auto-wire the language toggle buttons
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".lang-btn").forEach((btn) => {
    btn.addEventListener("click", () => setLanguage(btn.dataset.lang));
  });
  applyTranslations();
});