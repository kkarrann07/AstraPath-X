const root = document.querySelector("#comparison");
const threshold = root.querySelector("#compare-threshold");
const apollo = {
  apollo11: { name: "Apollo 11", lat: .67416, lon: 23.47314 },
  apollo15: { name: "Apollo 15", lat: 26.13239, lon: 3.63330 },
};
const exposure = {
  earth: [[20, 43, 57], [101, 170, 159], [227, 222, 173]],
  moon: [[36, 31, 62], [122, 112, 166], [234, 226, 238]],
  slope: [[34, 62, 91], [229, 167, 99], [224, 83, 92]],
};
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function ramp(palette, t) {
  const scaled = clamp(t, 0, 1) * 2;
  const segment = Math.min(1, Math.floor(scaled));
  return palette[segment].map((start, i) => Math.round(start + (palette[segment + 1][i] - start) * (scaled - segment)));
}

function statistics(grid) {
  const slopes = grid?.slope.flat().filter(Number.isFinite) || [];
  const elevation = grid?.elevation.flat().filter(Number.isFinite) || [];
  return {
    relief: elevation.length ? Math.max(...elevation) - Math.min(...elevation) : null,
    mean: slopes.length ? slopes.reduce((sum, value) => sum + value, 0) / slopes.length : null,
    screened: slopes.length ? 100 * slopes.filter((value) => value > Number(threshold.value)).length / slopes.length : null,
  };
}

class TerrainPanel {
  constructor(element, body) {
    this.element = element;
    this.body = body;
    this.layer = body === "moon" ? "globe" : "elevation";
    this.canvas = this.get(".compare-raster");
    this.context = this.canvas.getContext("2d");
    this.stage = this.get(".compare-stage");
    this.inspector = this.get("[data-inspect]");
    this.scale = this.get("[data-scale]");
    this.reset();
    new ResizeObserver(() => this.draw()).observe(this.stage);
    this.canvas.addEventListener("pointerdown", (event) => {
      this.pan = [event.clientX, event.clientY];
      this.canvas.setPointerCapture(event.pointerId);
    });
    this.canvas.addEventListener("pointermove", (event) => {
      if (this.pan) {
        this.x += event.clientX - this.pan[0];
        this.y += event.clientY - this.pan[1];
        this.pan = [event.clientX, event.clientY];
        this.draw();
      }
      const rect = this.canvas.getBoundingClientRect();
      this.inspect(event.clientX - rect.left, event.clientY - rect.top);
    });
    for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) {
      this.canvas.addEventListener(event, () => { this.pan = undefined; });
    }
    this.canvas.addEventListener("pointerleave", () => { this.inspector.hidden = true; });
    this.canvas.addEventListener("wheel", (event) => {
      if (!this.grid) return;
      event.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      this.zoomBy(event.deltaY > 0 ? 1 / 1.22 : 1.22, event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });
    this.canvas.addEventListener("keydown", (event) => {
      const arrows = { ArrowLeft: [30, 0], ArrowRight: [-30, 0], ArrowUp: [0, 30], ArrowDown: [0, -30] };
      if (arrows[event.key]) {
        this.x += arrows[event.key][0];
        this.y += arrows[event.key][1];
        this.draw();
      } else if (event.key === "+" || event.key === "=") this.zoomBy(1.22);
      else if (event.key === "-") this.zoomBy(1 / 1.22);
      else if (event.key === "Home") this.reset();
      else if (event.key === "Enter") this.inspect(this.canvas.clientWidth / 2, this.canvas.clientHeight / 2);
      else return;
      event.preventDefault();
    });
    for (const button of element.querySelectorAll("[data-terrain-layer]")) {
      button.addEventListener("click", () => this.showLayer(button.dataset.terrainLayer));
    }
    this.get("[data-reset-terrain]").addEventListener("click", () => {
      if (this.layer === "globe") this.globe?.reset();
      else this.reset();
    });
  }

  get(selector) { return this.element.querySelector(selector); }

  setDataset(grid, heading, status, provenance) {
    this.grid = grid;
    this.get("h2").textContent = heading;
    this.get("[data-status]").textContent = status;
    this.get("[data-provenance]").textContent = provenance;
    const badge = this.get("[data-dataset-badge]");
    badge.textContent = grid?.id === "demo" ? "SYNTHETIC DEMO" : grid?.study ? "CARTODEM" : grid?.lunar ? "NASA LOLA DEM" : "UPLOADED DEM";
    this.get("[data-open-planner]").disabled = !grid;
    for (const button of this.element.querySelectorAll("[data-terrain-layer]")) {
      const layer = button.dataset.terrainLayer;
      button.disabled = layer !== "globe" && (!grid || (layer === "imagery" && !grid.imagery));
    }
    if (this.layer === "imagery" && !grid?.imagery) this.layer = "elevation";
    if (this.body === "moon" && !grid) this.layer = "globe";
    this.reset();
    this.showLayer(this.layer);
    this.updateMetrics();
  }

  updateMetrics() {
    const { relief, mean, screened } = statistics(this.grid);
    const dx = this.grid?.dx, dy = this.grid?.dy;
    const posting = this.grid ? (dx === dy ? dx.toFixed(0) : `${dx.toFixed(1)} × ${dy.toFixed(1)}`) + " m" : "—";
    const metrics = [
      ["Grid posting", posting],
      ["Local relief", relief === null ? "—" : `${relief.toFixed(0)} m`],
      ["Mean slope", mean === null ? "—" : `${mean.toFixed(1)}°`],
      [`Slope > ${threshold.value}°`, screened === null ? "—" : `${screened.toFixed(1)}%`],
    ];
    this.get("[data-metrics]").replaceChildren(...metrics.map(([label, value]) => {
      const cell = document.createElement("div");
      const term = document.createElement("dt");
      const reading = document.createElement("dd");
      term.textContent = label;
      reading.textContent = value;
      cell.append(term, reading);
      return cell;
    }));
  }

  showLayer(layer) {
    this.layer = layer;
    this.inspect();
    const globe = this.get("#moon-globe");
    if (globe) globe.hidden = layer !== "globe";
    this.canvas.hidden = layer === "globe" || !this.grid;
    this.scale.hidden = this.canvas.hidden;
    this.get("[data-dataset-badge]").hidden = this.canvas.hidden;
    this.get("[data-empty]").hidden = Boolean(this.grid) || layer === "globe";
    for (const button of this.element.querySelectorAll("[data-terrain-layer]")) {
      button.setAttribute("aria-pressed", String(button.dataset.terrainLayer === layer));
    }
    const key = this.get("[data-palette]");
    const legend = {
      elevation: this.grid ? `${this.grid.min_elevation.toFixed(0)}–${this.grid.max_elevation.toFixed(0)} m` : "",
      slope: "0°, 17.5°, ≥35°",
      hazard: `Slope > ${threshold.value}°`,
    };
    key.hidden = this.canvas.hidden || !legend[layer];
    key.dataset.layer = layer;
    key.textContent = legend[layer] || "";
    this.paint();
  }

  reset() {
    this.zoom = 1;
    this.x = this.y = 0;
    this.inspect();
    this.draw();
  }

  zoomBy(factor, x = this.canvas.clientWidth / 2, y = this.canvas.clientHeight / 2) {
    const scale = clamp(this.zoom * factor, 1, 9);
    if (scale === 1) return this.reset();
    this.x = (this.x + this.canvas.clientWidth / 2 - x) * scale / this.zoom + x - this.canvas.clientWidth / 2;
    this.y = (this.y + this.canvas.clientHeight / 2 - y) * scale / this.zoom + y - this.canvas.clientHeight / 2;
    this.zoom = scale;
    this.draw();
  }

  paint() {
    if (this.canvas.hidden || !this.grid) return;
    const grid = this.grid;
    const raster = document.createElement("canvas");
    raster.width = grid.width;
    raster.height = grid.height;
    const context = raster.getContext("2d");
    const image = context.createImageData(grid.width, grid.height);
    const range = grid.max_elevation - grid.min_elevation || 1;
    for (let row = 0; row < grid.height; row++) {
      for (let col = 0; col < grid.width; col++) {
        const z = grid.elevation[row][col];
        const slope = grid.slope[row][col];
        let rgb = [19, 28, 44];
        if (Number.isFinite(z)) {
          if (this.layer === "imagery") rgb = grid.imagery[row][col];
          else if (this.layer === "slope") rgb = Number.isFinite(slope) ? ramp(exposure.slope, slope / 35) : rgb;
          else {
            const level = (z - grid.min_elevation) / range;
            const east = grid.elevation[row][Math.min(col + 1, grid.width - 1)] ?? z;
            const south = grid.elevation[Math.min(row + 1, grid.height - 1)][col] ?? z;
            const shade = clamp(1 + 1.3 * ((east - z) / grid.dx + (south - z) / grid.dy), .58, 1.28);
            const interval = range > 100 ? 20 : 10;
            const contour = Math.floor(z / interval) !== Math.floor(east / interval)
              || Math.floor(z / interval) !== Math.floor(south / interval);
            rgb = this.layer === "hazard" && slope > Number(threshold.value)
              ? [232, 116, 123] : ramp(exposure[this.body], level).map((value) => value * shade * (contour ? .8 : 1));
          }
        }
        image.data.set([rgb[0], rgb[1], rgb[2], 255], 4 * (row * grid.width + col));
      }
    }
    context.putImageData(image, 0, 0);
    this.raster = raster;
    this.draw();
  }

  draw() {
    const grid = this.grid;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (!grid || !this.raster || this.canvas.hidden || !width || !height) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const bufferWidth = Math.round(width * dpr), bufferHeight = Math.round(height * dpr);
    if (this.canvas.width !== bufferWidth || this.canvas.height !== bufferHeight) {
      this.canvas.width = bufferWidth;
      this.canvas.height = bufferHeight;
    }
    const ctx = this.context;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const fit = Math.min((width - 2) / (grid.width * grid.dx), (height - 2) / (grid.height * grid.dy)) * this.zoom;
    const cellX = grid.dx * fit, cellY = grid.dy * fit;
    const w = cellX * grid.width, h = cellY * grid.height;
    const shiftX = Math.max(0, (width + w) / 2 - 48);
    const shiftY = Math.max(0, (height + h) / 2 - 48);
    this.x = clamp(this.x, -shiftX, shiftX);
    this.y = clamp(this.y, -shiftY, shiftY);
    const left = (width - w) / 2 + this.x, top = (height - h) / 2 + this.y;
    this.fit = { left, top, cellX, cellY };
    ctx.imageSmoothingEnabled = this.layer === "elevation" || this.layer === "imagery";
    ctx.drawImage(this.raster, left, top, w, h);
    const targetDistance = 75 / fit;
    const power = 10 ** Math.floor(Math.log10(targetDistance));
    const metres = (targetDistance / power >= 5 ? 5 : targetDistance / power >= 2 ? 2 : 1) * power;
    this.scale.textContent = metres >= 1000 ? `${metres / 1000} km` : `${metres} m`;
    this.scale.style.setProperty("--scale-width", `${metres * fit}px`);
  }

  inspect(x, y) {
    if (!this.fit || x === undefined || !this.grid) { this.inspector.hidden = true; return; }
    const row = Math.floor((y - this.fit.top) / this.fit.cellY);
    const col = Math.floor((x - this.fit.left) / this.fit.cellX);
    const z = this.grid.elevation[row]?.[col];
    const slope = this.grid.slope[row]?.[col];
    this.inspector.hidden = z === undefined;
    const reading = Number.isFinite(z) ? `${z.toFixed(1)} m · ${slope === null ? "slope unavailable" : slope.toFixed(1) + "°"}` : "No DEM data";
    this.inspector.textContent = `Row ${row}, col ${col} · ${reading}`;
  }
}

export function initComparison({ api, currentTerrain, currentStudy, openISRO, openPlanner }) {
  const earth = new TerrainPanel(root.querySelector("#compare-earth"), "earth");
  const moon = new TerrainPanel(root.querySelector("#compare-moon"), "moon");
  const earthSelect = earth.get("select");
  const lunarSelect = moon.get("select");
  const globeStatus = moon.get("#globe-status");
  let globe, region, uploadedEarth, moonRequest = 0, earthRequest = 0, initialized = false, earthChosen = false;
  const nasaCredit = "NASA Scientific Visualization Studio · LROC/LOLA color mosaic, December 2025 release · 2048 × 1024 texture pixels.";

  function focusGlobe() {
    if (!region) return;
    const coordinate = (value, pole) => `${Math.abs(value).toFixed(4)}° ${pole}`;
    moon.get("#globe-coordinates").textContent = `${coordinate(region.lat, region.lat < 0 ? "S" : "N")} · ${coordinate(region.lon, region.lon < 0 ? "W" : "E")}`;
    globe?.focusRegion(region);
  }

  async function loadMoon() {
    const request = ++moonRequest;
    const id = lunarSelect.value;
    region = apollo[id];
    moon.get("#globe-coordinates").textContent = "";
    moon.setDataset(null, lunarSelect.selectedOptions[0].label.split(" · ")[0],
      region ? "Imagery only. No regional elevation grid is installed for this site." : "Loading the NASA LOLA elevation grid…", nasaCredit);
    focusGlobe();
    if (region) return;
    try {
      const grid = await api(`/api/terrain/${id}/comparison`);
      if (request !== moonRequest) return;
      region = grid.lunar;
      moon.setDataset(grid, region.name, "NASA LOLA DEM · Regional slope and elevation layers available.",
        `${region.provenance} ${nasaCredit}`);
      focusGlobe();
    } catch (error) {
      if (request === moonRequest) moon.setDataset(null, "Lunar survey", error.message, nasaCredit);
    }
  }

  async function loadEarth() {
    const request = ++earthRequest;
    const choice = earthSelect.value;
    const current = currentTerrain();
    earth.setDataset(null, choice === "ladakh" ? "Ladakh · Tso Kar" : "Earth", "Loading elevation…", "");
    try {
      let grid, caption, provenance;
      if (choice === "ladakh") {
        const study = currentStudy() || await api("/api/tsokar");
        if (request !== earthRequest) return;
        if (!study?.id) {
          earth.setDataset(null, "Ladakh · Tso Kar", "CartoDEM has not been installed.", "ISRO Bhuvan / Bhoonidhi · CartoDEM 1 arc-second requested.");
          return;
        }
        grid = current?.study?.id === study.id ? current : await api(`/api/tsokar/${study.id}/window`);
        caption = "Tso Kar study window · User-declared CartoDEM provenance";
        provenance = grid.study.dem.map((item) => `${item.product_id} · ${item.version} · ${item.acquired || "acquisition date unspecified"}`).join(" / ");
        if (grid.study.imagery) provenance += ` · ${grid.study.imagery.display}, acquired ${grid.study.imagery.acquired}`;
      } else if (choice === "upload" && uploadedEarth) {
        grid = uploadedEarth;
        caption = "User-supplied Earth GeoTIFF · Provenance unverified";
        provenance = grid.detail;
      } else {
        grid = { id: "demo" };
        caption = "Synthetic Earth demo · Tso Kar terrain requires CartoDEM";
        provenance = "Procedural elevation, no geographic location or acquisition date.";
      }
      const analysis = Object.hasOwn(grid, "slope") ? grid : { ...grid, ...await api(`/api/terrain/${grid.id}/comparison`) };
      if (request === earthRequest) earth.setDataset(analysis, analysis.name, caption, provenance);
    } catch (error) {
      if (request === earthRequest) earth.setDataset(null, "Earth terrain", error.message, "");
    }
  }

  async function open({ preferLadakh = false } = {}) {
    const current = currentTerrain();
    if (current && !current.lunar && !current.study && current.id !== "demo") uploadedEarth = current;
    earthSelect.querySelector("[value=upload]").hidden = !uploadedEarth;
    if (preferLadakh) earthSelect.value = "ladakh";
    else if (!earthChosen) {
      earthSelect.value = current?.study || currentStudy()?.id ? "ladakh" : uploadedEarth ? "upload" : "demo";
    }
    loadEarth();
    if (initialized) return;
    initialized = true;
    loadMoon();
    try {
      const { createMoon } = await import("./moon.js");
      moon.globe = globe = await createMoon(moon.get("#moon-globe"));
      focusGlobe();
    } catch {
      globeStatus.textContent = "The lunar globe could not load. Regional DEM layers remain available.";
      moon.get("#globe-rotation").disabled = moon.get("#globe-fullscreen").disabled = true;
    }
  }

  earthSelect.addEventListener("change", () => { earthChosen = true; loadEarth(); });
  lunarSelect.addEventListener("change", loadMoon);
  for (const button of root.querySelectorAll("[data-open-isro]")) button.addEventListener("click", openISRO);
  threshold.addEventListener("change", () => {
    for (const panel of [earth, moon]) {
      panel.updateMetrics();
      if (panel.layer === "hazard") panel.showLayer("hazard");
    }
  });
  for (const panel of [earth, moon]) {
    panel.get("[data-open-planner]").addEventListener("click", () => {
      if (panel.grid) openPlanner(panel.grid, Number(threshold.value));
    });
  }
  return { open };
}
