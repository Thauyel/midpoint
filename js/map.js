// ============================================================
//  map.js  --  Leaflet wrapper with custom div markers
// ============================================================

const ICON_SIZES = { sideA: 26, sideB: 26, midpoint: 30, place: 22 };

function divIcon(html, className, size) {
  return L.divIcon({
    html,
    className: "",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

const PLACE_GLYPH = {
  cafe:       "c",
  restaurant: "r",
  bar:        "b",
  park:       "p",
  generic:    "·",
};

export class MidpointMap {
  constructor(elementId, center = { lat: 41.0082, lon: 28.9784 }, zoom = 6) {
    // Istanbul default; auto-fits on first result
    this.map = L.map(elementId, {
      center: [center.lat, center.lon],
      zoom,
      zoomControl: true,
      worldCopyJump: true,
      attributionControl: true,
    });
    // CARTO Dark Matter matches the pure-black UI and stays readable in
    // both light and dim rooms. Free for <75k tile requests/day, sufficient
    // for personal use.
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 19,
      minZoom: 3,
      attribution: "© OpenStreetMap contributors © CARTO",
      crossOrigin: true,
      subdomains: "abcd",
    }).addTo(this.map);

    this.markers = { a: null, b: null, mid: null, places: [] };
    this.lines = [];
  }

  setSide(side, point) {
    const cls = side === "a" ? "side-a" : "side-b";
    const label = side.toUpperCase();
    const html = `<div class="side-marker ${cls}">${label}</div>`;
    const icon = divIcon(html, cls, ICON_SIZES[`side${label}`]);
    if (this.markers[side]) {
      this.markers[side].setLatLng([point.lat, point.lon]);
    } else {
      this.markers[side] = L.marker([point.lat, point.lon], { icon, keyboard: false })
        .bindTooltip(side === "a" ? "Person A" : "Person B", { direction: "top", offset: [0, -10] })
        .addTo(this.map);
    }
  }

  setMidpoint(point) {
    const html = `<div class="midpoint-marker">M</div>`;
    const icon = divIcon(html, "midpoint-marker", ICON_SIZES.midpoint);
    if (this.markers.mid) {
      this.markers.mid.setLatLng([point.lat, point.lon]);
    } else {
      this.markers.mid = L.marker([point.lat, point.lon], { icon, keyboard: false })
        .bindTooltip("midpoint", { direction: "top", offset: [0, -12] })
        .addTo(this.map);
    }
  }

  clearPlaces() {
    for (const m of this.markers.places) this.map.removeLayer(m);
    this.markers.places = [];
  }

  /**
   * Highlight a single place marker. Used when the user hovers a result row
   * or focuses it via keyboard. `on=true` adds the `is-pulse` class for a
   * brief attention-grab; `on=false` removes it.
   */
  focusPlace(idx, on) {
    const m = this.markers.places[idx];
    if (!m || !m.getElement) return;
    const inner = m.getElement().querySelector(".place-marker");
    if (!inner) return;
    inner.classList.toggle("is-pulse", !!on);
    inner.classList.toggle("is-hover", !!on);
  }

  addPlace(place, idx, opts = {}) {
    const isTop = !!opts.isTop;
    const glyph = PLACE_GLYPH[place.category] || "·";
    const html = `<div class="place-marker${isTop ? " is-top" : ""}">${glyph}</div>`;
    const icon = divIcon(html, "place-marker-icon", ICON_SIZES.place);
    const m = L.marker([place.lat, place.lon], { icon, keyboard: true })
      .bindTooltip(
        `${place.name} &middot; ${formatEta(place.eta_a_s)} / ${formatEta(place.eta_b_s)}`,
        { direction: "top", offset: [0, -10], opacity: 0.95 }
      )
      .addTo(this.map);
    this.markers.places.push(m);
    return m;
  }

  clearLines() {
    for (const l of this.lines) this.map.removeLayer(l);
    this.lines = [];
  }

  clearCircles() {
    if (this.circles) {
      for (const c of this.circles) this.map.removeLayer(c);
    }
    this.circles = [];
  }

  /**
   * Draw a translucent circle around `center` with `radiusM` metres.
   * Used to visualise each person's "fair zone" so the user can see
   * why certain meeting points are possible and others aren't.
   */
  drawFairCircle(center, radiusM, opts = {}) {
    if (!this.circles) this.circles = [];
    const circle = L.circle([center.lat, center.lon], {
      radius: radiusM,
      color: opts.color || "#f5b5c5",
      weight: 1,
      fillColor: opts.fillColor || opts.color || "#f5b5c5",
      fillOpacity: opts.fillOpacity ?? 0.06,
      interactive: false,
    }).addTo(this.map);
    this.circles.push(circle);
    return circle;
  }

  /**
   * Draw (or redraw) the v4 "circle from the midpoint" — the single
   * circle whose contents the algorithm is searching. `midRadiusM` is
   * the radius in metres. We clear any prior mid-circles first so
   * each redraw replaces the previous one cleanly.
   */
  drawMidCircle(center, midRadiusM, opts = {}) {
    if (!this.midCircles) this.midCircles = [];
    for (const c of this.midCircles) this.map.removeLayer(c);
    this.midCircles = [];
    const circle = L.circle([center.lat, center.lon], {
      radius: midRadiusM,
      color: opts.color || "#f5b5c5",
      weight: 2,
      fillColor: opts.fillColor || opts.color || "#f5b5c5",
      fillOpacity: opts.fillOpacity ?? 0.04,
      dashArray: opts.dashArray || "6 8",
      interactive: false,
    }).addTo(this.map);
    this.midCircles.push(circle);
    return circle;
  }

  drawLine(a, b, opts = {}) {
    const line = L.polyline([[a.lat, a.lon], [b.lat, b.lon]], {
      color: opts.color || "#f5b5c5",
      weight: opts.weight || 2,
      opacity: opts.opacity ?? 0.6,
      dashArray: opts.dashArray || "4 6",
      interactive: false,
    }).addTo(this.map);
    this.lines.push(line);
  }

  fitTo(points, padding = [40, 40]) {
    if (!points.length) return;
    const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lon]));
    this.map.fitBounds(bounds, { padding, maxZoom: 15 });
  }

  flyTo(point, zoom = 14) {
    this.map.flyTo([point.lat, point.lon], zoom, { duration: 0.8 });
  }

  invalidate() {
    // Leaflet needs this when the container resizes after becoming visible.
    setTimeout(() => this.map.invalidateSize(), 100);
  }

  destroy() {
    this.map.remove();
  }
}

function formatEta(seconds) {
  if (seconds == null || !isFinite(seconds)) return "—";
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h${rem}` : `${h}h`;
}