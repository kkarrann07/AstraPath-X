const byId = (id) => document.getElementById(id);
const map = byId("map");
const timeline = byId("timeline");
const policies = {
  shortest: { name: "Shortest", color: "#68ddfb" },
  safest: { name: "Safest", color: "#beaaff" },
  energy: { name: "Energy-efficient", color: "#6df0b9" },
};
const defaultSettings = {
  capacity: 120, initial_pct: 82, budget: 100, reserve: 18, max_slope: 19,
  speed: 0.85, traction: 18, hotel: 15, solar_rate: 36, azimuth: 112, altitude: 7,
  solar: true, round_trip: false, uncertainty: 1,
};
const parameters = {
  capacity: ["Battery capacity (Wh)", 1, 5000, 1],
  initial_pct: ["Initial battery (%)", 0, 100, 1],
  budget: ["Energy draw budget (Wh)", 0, 5000, 1],
  reserve: ["Safety reserve (Wh)", 0, 5000, 1],
  max_slope: ["Maximum terrain slope (°)", 1, 60, 0.5],
  speed: ["Level travel speed (m/s)", 0.05, 10, 0.05],
  traction: ["Level drive energy (Wh/km)", 0, 500, 1],
  hotel: ["Onboard power (W)", 0, 1000, 1],
  solar_rate: ["Illuminated charging rate (W)", 0, 1000, 1],
  azimuth: ["Sun azimuth from north (°)", 0, 360, 1],
  altitude: ["Sun altitude (°)", 0, 90, 0.5],
  uncertainty: ["Elevation uncertainty σ (m)", 0, 30, 0.1],
};
let settings = { ...defaultSettings };
let terrain, plan, scores, selected, flight, guidance, fit, raster, study;
let installedStudy = false;
let startupDataError = "";
let layer = "solar";
let picker, timer, operation = 0, busy = false, stoppedAtPnr = false;

for (const [name, [title, min, max, step]] of Object.entries(parameters)) {
  const label = document.createElement("label");
  label.textContent = title;
  const input = document.createElement("input");
  Object.assign(input, { name, type: "number", required: true, min, max, step });
  label.append(input);
  document.querySelector(".parameter-grid").append(label);
}

function fillParameters() {
  for (const name of Object.keys(parameters)) byId("parameters").elements[name].value = settings[name];
  byId("solar").checked = settings.solar;
  byId("round-trip").checked = settings.round_trip;
}

async function api(url, options) {
  const response = await fetch(url.replace(/^\//, ""), options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(typeof data.detail === "string" ? data.detail : "Check the mission parameters and coordinates.");
  }
  return data;
}

function post(url, payload) {
  return api(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
}

function payload() {
  return { terrain: terrain.id, start: terrain.start, target: terrain.target, settings: { ...settings } };
}

function setPoints() {
  byId("coordinates").elements.base.value = terrain.start.join(",");
  byId("coordinates").elements.target.value = terrain.target.join(",");
}

async function calculate() {
  const serial = ++operation;
  halt();
  busy = true;
  plan = scores = flight = guidance = raster = undefined;
  stoppedAtPnr = false;
  render();
  const request = payload();
  try {
    const nextPlan = await post("/api/plan", request);
    if (serial !== operation) return;
    plan = nextPlan;
    selected = [selected, ...Object.keys(policies)].find((name) => plan.routes[name]?.feasible)
      || Object.keys(policies).find((name) => plan.routes[name]);
    busy = false;
    resetFlight();
    if (settings.uncertainty && Object.values(plan.routes).some(Boolean)) {
      byId("robustness").textContent = "Running 20 seeded elevation stress tests…";
      try {
        const results = await post("/api/robustness", request);
        if (plan !== nextPlan) return;
        scores = results;
        byId("robustness").textContent = `20 fixed-route trials · σ ${scores.sigma} m · seed ${scores.seed}. Trial counts describe modeled feasibility.`;
        renderRoutes();
      } catch (error) {
        if (plan === nextPlan) byId("robustness").textContent = error.message;
      }
    } else {
      byId("robustness").textContent = settings.uncertainty ? "Select connected endpoints to run stress tests." : "Elevation uncertainty is off.";
    }
  } catch (error) {
    if (serial !== operation) return;
    busy = false;
    plan = { message: error.message, routes: {} };
    render();
  }
}

function halt() {
  clearInterval(timer);
  timer = undefined;
}

function resetFlight() {
  halt();
  guidance = undefined;
  stoppedAtPnr = false;
  const route = plan?.routes[selected];
  flight = route?.feasible ? { route, index: 0, battery: plan.initial, position: terrain.start, time: 0 } : undefined;
  render();
}

function summary() {
  if (!terrain) return;
  const battery = flight?.battery ?? plan?.initial ?? settings.capacity * settings.initial_pct / 100;
  const percent = Math.round(battery / settings.capacity * 100);
  byId("active-terrain").textContent = terrain.name;
  byId("terrain-origin").textContent = terrain.origin;
  byId("data-status").textContent = terrain.study
    ? (terrain.study.id === "installed" ? "Installed Tso Kar terrain active." : "Imported Tso Kar terrain active for this session.")
    : terrain.id === "demo"
      ? startupDataError || (installedStudy ? "Synthetic demo active. Installed Tso Kar terrain is available."
        : "No Tso Kar dataset installed. Synthetic demo active.")
      : "Uploaded GeoTIFF active for this session.";
  byId("terrain-detail").textContent = terrain.detail;
  byId("map-source").textContent = terrain.study ? "TSO KAR · UPLOADED ELEVATION"
    : terrain.id === "demo" ? "SYNTHETIC ELEVATION" : "UPLOADED ELEVATION";
  byId("study-source").hidden = !terrain.study;
  document.querySelector('[data-layer="imagery"]').hidden = !terrain.imagery;
  if (terrain.study) {
    const products = terrain.study.dem.map(({ product_id, version, acquired }) =>
      `${product_id} · ${version} · ${acquired || "acquisition date unspecified"}`).join(" / ");
    const coverage = `${(100 * terrain.study.coverage).toFixed(1)}% study-area DEM coverage`;
    const image = terrain.study.imagery
      ? `${terrain.study.imagery.display} acquired ${terrain.study.imagery.acquired}` : "No 2025 imagery loaded";
    byId("study-provenance").textContent = `Declared CartoDEM provenance · ${products} · ${coverage} · ${image}`;
    byId("study-manifest").href = `api/tsokar/${terrain.study.id}/manifest`;
  }
  byId("battery-top").textContent = `${percent}%`;
  byId("battery-detail").textContent = `${battery.toFixed(1)} / ${settings.capacity} Wh`;
  const meter = byId("battery-meter-fill");
  meter.style.width = `${percent}%`;
  meter.classList.toggle("low", battery < (plan?.floor ?? settings.reserve));
  byId("sun-top").textContent = `${settings.altitude}°`;
  byId("sun-detail").textContent = `Azimuth ${settings.azimuth}° · Solar ${settings.solar ? "on" : "off"}`;
  const status = busy ? "PLANNING" : guidance?.status || (flight?.index ? "CONTINUE" : flight ? "READY" : "BLOCKED");
  byId("status-top").dataset.status = status;
  byId("status-top").textContent = status;
  byId("status-detail").textContent = ({
    "STOP/HOLD": "Rover stationary", RETURN: "Modeled path to base", CONTINUE: "Modeled path to target",
    READY: settings.round_trip ? "Return required" : "Outbound mission",
    BLOCKED: "Review mission limits", PLANNING: "Evaluating terrain",
  })[status];
}

function renderRoutes() {
  const container = byId("routes");
  container.replaceChildren();
  if (!Object.values(plan?.routes || {}).some(Boolean)) {
    const empty = document.createElement("div");
    empty.className = "placeholder";
    empty.textContent = plan?.message || "Calculating terrain and battery constraints…";
    container.append(empty);
    return;
  }
  for (const [name, meta] of Object.entries(policies)) {
    const route = plan.routes[name];
    if (!route) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.disabled = busy;
    button.className = "route-card";
    button.style.setProperty("--route", meta.color);
    button.setAttribute("aria-pressed", String(name === selected));
    button.title = route.feasible ? "Select route and reset simulation" : route.reason;
    button.innerHTML = `<span class="route-head"><span><span aria-hidden="true" class="route-swatch">●</span>${meta.name}</span>
      <span class="route-badge ${route.feasible ? "" : "rejected"}">${route.feasible ? (name === selected ? "Selected" : "Feasible") : "Rejected"}</span></span>
      <span class="route-stats"><span><strong>${(route.distance / 1000).toFixed(2)}</strong> km</span>
      <span><strong>${route.max_slope.toFixed(1)}°</strong> max</span>
      <span><strong>${route.gross.toFixed(1)}</strong> Wh used</span>
      <span><strong>${route.solar.toFixed(1)}</strong> Wh solar</span>
      <span><strong>${route.end.toFixed(1)}</strong> Wh ${route.feasible ? "at target" : "projected end"}</span>
      <span><strong>${route.lit_pct}%</strong> lit</span>
      ${scores?.passes[name] !== undefined ? `<span><strong>${scores.passes[name]}/${scores.trials}</strong> trials pass</span>` : ""}
      ${route.feasible ? "" : `<span>${route.reason}</span>`}</span>`;
    button.addEventListener("click", () => { selected = name; resetFlight(); });
    container.append(button);
  }
}

function renderFlight() {
  const route = flight?.route || plan?.routes[selected];
  const point = flight?.route?.timeline[flight.index];
  const progress = flight?.route ? (flight.index / Math.max(1, flight.route.path.length - 1) * 100) : 0;
  byId("progress-fill").style.width = `${progress}%`;
  byId("progress-fill").parentElement.setAttribute("aria-valuenow", String(Math.round(progress)));
  const arrived = flight?.route && flight.index === flight.route.path.length - 1;
  const canAdvance = !busy && flight?.route && !arrived;
  byId("play").disabled = !canAdvance;
  byId("step").disabled = !canAdvance;
  byId("reset").disabled = busy || !plan?.routes[selected]?.feasible;
  byId("return").hidden = !flight || guidance?.status === "RETURN"
    || (flight.position[0] === terrain.start[0] && flight.position[1] === terrain.start[1]);
  byId("return").disabled = busy;
  byId("drop").disabled = busy || !flight;
  byId("wait").disabled = busy || !flight;
  byId("play").textContent = timer ? "Ⅱ Pause" : "▶ Play";
  byId("sim-progress").textContent = point
    ? `${(point.distance / 1000).toFixed(2)} / ${(route.distance / 1000).toFixed(2)} km · ${(flight.time / 60).toFixed(1)} min elapsed`
    : "Choose a feasible route to begin";
  const decision = byId("decision");
  decision.classList.toggle("alert", guidance?.status === "STOP/HOLD" || guidance?.status === "RETURN");
  decision.textContent = arrived
    ? (guidance?.status === "RETURN" ? "Base reached." : settings.round_trip ? "Target reached. Modeled return is available from here." : "Target reached.")
    : guidance?.reason || plan?.message || (busy ? "Evaluating mission constraints…" : "Advance the rover, then inject battery loss to replan from its current cell.");
  byId("lit-stat").textContent = route ? `${route.lit_pct}%` : "—";
  byId("shadow-stat").textContent = route ? `${(route.shadow_seconds / 60).toFixed(1)} min` : "—";
  const warning = byId("warning");
  let warningText = route ? "Modeled return threshold is met along this trajectory." : "";
  let alert = false;
  if (route?.pnr != null) {
    const critical = route.timeline[route.pnr];
    const location = `${(critical.distance / 1000).toFixed(2)} km`;
    warningText = flight && flight.index >= route.pnr
      ? `First point of no return crossed at ${location}. Return feasibility can change farther along the route.`
      : `Point of no return projected at ${location}. Charge there is ${critical.battery.toFixed(1)} Wh${critical.required == null ? " and no modeled return fits capacity" : ` versus ${critical.required.toFixed(1)} Wh required`}.`;
    alert = true;
  }
  const shadowFailure = route?.failure_index != null ? route.timeline[route.failure_index] : undefined;
  if (shadowFailure?.shadow_seconds >= 120) {
    alert = true;
    warningText += ` A ${(shadowFailure.shadow_seconds / 60).toFixed(1)} min shadow segment breaches a mission constraint.`;
  } else if (route?.shadow_seconds >= 120 && route.min_battery < (plan.floor || 0) + 10) {
    alert = true;
    warningText += " Extended shadow and a projected charge margin below 10 Wh warrant caution.";
  }
  if (stoppedAtPnr && flight?.index === route?.pnr - 1) warningText += " Rover paused before crossing. Resume to accept crossing.";
  if (guidance?.status === "STOP/HOLD" && flight) {
    alert = true;
    warningText = "Movement suspended. Reassess stationary power and available paths.";
  }
  warning.textContent = warningText.trim();
  warning.classList.toggle("alert", alert);
}

function render() {
  summary();
  renderRoutes();
  renderFlight();
  drawMap();
  drawTimeline();
}

function advance(cells) {
  if (busy || !flight?.route) return;
  const route = flight.route;
  let next = Math.min(flight.index + cells, route.path.length - 1);
  if (!stoppedAtPnr && route.pnr != null && route.pnr > flight.index && next >= route.pnr) {
    next = route.pnr - 1;
    stoppedAtPnr = true;
    halt();
  }
  const point = route.timeline[next];
  flight.time += point.seconds - route.timeline[flight.index].seconds;
  Object.assign(flight, { index: next, position: route.path[next], battery: point.battery });
  if (next === route.path.length - 1) halt();
  summary();
  renderFlight();
  drawMap();
  drawTimeline();
}

async function perturb(action) {
  if (!flight || busy) return;
  halt();
  const position = flight.position;
  const wasReturning = flight.returning || action === "return";
  flight.returning = wasReturning;
  if (action === "idle") {
    const hasSun = settings.solar && plan.illuminated[position[0]][position[1]];
    flight.battery = Math.max(0, Math.min(settings.capacity,
      flight.battery + ((hasSun ? settings.solar_rate : 0) - settings.hotel) / 6));
    flight.time += 600;
  } else if (action === "loss") {
    flight.battery *= 1 - Number(byId("loss").value) / 100;
  }
  const serial = ++operation;
  busy = true;
  render();
  try {
    guidance = await post("/api/emergency", {
      ...payload(), position, battery: flight.battery, returning: wasReturning,
    });
    if (serial !== operation) return;
    flight.returning = flight.returning || guidance.status === "RETURN";
    flight.route = guidance.route;
    flight.index = 0;
    stoppedAtPnr = false;
  } catch (error) {
    if (serial !== operation) return;
    guidance = { status: "STOP/HOLD", reason: error.message };
    flight.route = undefined;
  }
  busy = false;
  render();
}

byId("parameters").addEventListener("submit", (event) => {
  event.preventDefault();
  for (const name of Object.keys(parameters)) settings[name] = Number(event.currentTarget.elements[name].value);
  if (terrain) calculate();
});
for (const [id, name] of [["solar", "solar"], ["round-trip", "round_trip"]]) {
  byId(id).addEventListener("change", (event) => {
    settings[name] = event.target.checked;
    if (terrain) calculate();
  });
}

byId("play").addEventListener("click", () => {
  if (timer) halt();
  else timer = setInterval(() => advance(2), 165);
  renderFlight();
});
byId("step").addEventListener("click", () => advance(5));
byId("reset").addEventListener("click", resetFlight);
byId("drop").addEventListener("click", () => perturb("loss"));
byId("wait").addEventListener("click", () => perturb("idle"));
byId("return").addEventListener("click", () => perturb("return"));
byId("loss").addEventListener("input", (event) => { byId("loss-value").value = `${event.target.value}%`; });

async function loadDemo(challenge) {
  try {
    terrain = await api("/api/terrain/demo");
    changeLayer("solar");
    settings = { ...defaultSettings };
    selected = "shortest";
    fillParameters();
    setPoints();
    choosePicker(undefined);
    calculate();
    if (challenge) byId("decision-title").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) {
    byId("decision").textContent = error.message;
  }
}
byId("demo").addEventListener("click", () => loadDemo(true));

const dialog = byId("upload-dialog");
byId("load-dem").addEventListener("click", () => dialog.showModal());
byId("cancel-upload").addEventListener("click", () => dialog.close());
byId("upload-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector("[type=submit]");
  const feedback = byId("upload-feedback");
  const file = form.elements.file.files[0];
  if (file.size > 32 * 1024 * 1024) {
    feedback.textContent = "This file exceeds 32 MiB. Crop or compress it before uploading.";
    return;
  }
  const query = new URLSearchParams({ name: file.name.slice(0, 100), x: form.elements.x.value, y: form.elements.y.value });
  submit.disabled = true;
  feedback.textContent = "Reading elevations and projecting to metres…";
  try {
    terrain = await api(`/api/terrain/upload?${query}`, { method: "POST", body: file });
    changeLayer("solar");
    dialog.close();
    form.elements.file.value = "";
    feedback.textContent = "";
    setPoints();
    choosePicker(undefined);
    calculate();
  } catch (error) {
    feedback.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

const studyDialog = byId("study-dialog");
const studyForm = byId("study-form");
const studyFeedback = byId("study-feedback");
const studyLoad = byId("study-load");
const tileList = byId("dem-tiles");
const addTile = byId("add-tile");
let studyBusy = false;
let importMode = "guided";

function refreshTiles() {
  const tiles = [...tileList.children];
  tiles.forEach((tile, index) => {
    tile.querySelector("h3").textContent = `CartoDEM tile ${index + 1}`;
    const remove = tile.querySelector(".remove-tile");
    remove.hidden = tiles.length === 1;
    remove.setAttribute("aria-label", `Remove CartoDEM tile ${index + 1}`);
  });
  addTile.disabled = tiles.length >= 8;
}

function appendTile() {
  const tile = byId("dem-tile-template").content.firstElementChild.cloneNode(true);
  tile.querySelector(".remove-tile").addEventListener("click", () => {
    const next = tile.nextElementSibling || tile.previousElementSibling;
    tile.remove();
    refreshTiles();
    next.querySelector('input[type="file"]').focus();
  });
  tileList.append(tile);
  refreshTiles();
  return tile;
}

appendTile();
addTile.addEventListener("click", () => appendTile().querySelector('input[type="file"]').focus());

for (const button of studyForm.querySelectorAll("[data-import-mode]")) {
  button.addEventListener("click", () => {
    importMode = button.dataset.importMode;
    for (const field of ["guided", "manifest"]) {
      const fieldset = byId(`${field}-import`);
      fieldset.hidden = fieldset.disabled = field !== importMode;
      studyForm.querySelector(`[data-import-mode="${field}"]`).setAttribute("aria-pressed", String(field === importMode));
    }
    studyFeedback.textContent = "";
  });
}

function studyAvailability(message) {
  byId("study-availability").textContent = message || (study?.id
    ? `${study.dem.length} DEM product(s) · ${(100 * study.coverage).toFixed(1)}% AOI coverage · ${study.imagery ? "2025 imagery attached" : "No imagery attached"}`
    : "No Tso Kar dataset loaded. Import official files or prepare a local study.");
  studyLoad.disabled = studyBusy || !study?.id;
  studyForm.querySelector('[type="submit"]').disabled = studyBusy;
  byId("study-cancel").disabled = studyBusy;
  byId("study-save-option").hidden = !study?.can_save_locally;
  studyForm.elements.save_local.disabled = studyBusy || !study?.can_save_locally;
}

byId("real-mode").addEventListener("click", async () => {
  studyFeedback.textContent = "";
  studyDialog.showModal();
  if (study?.id) {
    studyAvailability();
    return;
  }
  studyAvailability("Checking for a prepared study…");
  try {
    study = await api("/api/tsokar");
    studyAvailability();
  } catch (error) {
    studyAvailability(error.message);
  }
});
byId("study-cancel").addEventListener("click", () => studyDialog.close());
studyDialog.addEventListener("cancel", (event) => { if (studyBusy) event.preventDefault(); });

async function loadStudyWindow(automatic = false) {
  const query = automatic ? "" : `?${new URLSearchParams({ x: studyForm.elements.x.value, y: studyForm.elements.y.value })}`;
  terrain = await api(`/api/tsokar/${study.id}/window${query}`);
  if (terrain.window) {
    studyForm.elements.x.value = terrain.window.x.toFixed(2);
    studyForm.elements.y.value = terrain.window.y.toFixed(2);
  }
  changeLayer(terrain.imagery ? "imagery" : "solar");
  setPoints();
  choosePicker(undefined);
  studyDialog.close();
  calculate();
}

async function runStudyAction(action, progress) {
  if (studyBusy) return;
  for (const axis of [studyForm.elements.x, studyForm.elements.y]) {
    if (!axis.validity.valid) {
      byId("study-window").open = true;
      axis.reportValidity();
      return;
    }
  }
  studyBusy = true;
  studyAvailability();
  studyFeedback.textContent = progress;
  try {
    await action();
  } catch (error) {
    studyFeedback.textContent = error.message;
  } finally {
    studyBusy = false;
    studyAvailability();
  }
}

studyLoad.addEventListener("click", () => runStudyAction(
  () => loadStudyWindow(!byId("study-window").open), "Loading the aligned routing grid…",
));

function guidedStudy() {
  const files = [];
  const dem = [...tileList.children].map((tile) => {
    const values = {};
    for (const field of tile.querySelectorAll("[data-field]")) {
      if (!field.validity.valid) {
        const details = field.closest("details");
        if (details) details.open = true;
        field.reportValidity();
        throw new Error("Complete the highlighted CartoDEM field.");
      }
      if (field.type === "file") {
        files.push(field.files[0]);
        values.file = field.files[0].name;
      } else if (field.value.trim()) {
        values[field.dataset.field] = field.type === "number" ? field.valueAsNumber : field.value.trim();
      }
    }
    return values;
  });
  let imagery = null;
  const scene = studyForm.elements.scene.files[0];
  if (scene) {
    const value = (name) => studyForm.elements[`scene_${name}`].value.trim();
    const date = studyForm.elements.scene_date;
    if (!value("id") || !value("version") || !value("license") || !date.value || !date.validity.valid) {
      byId("optical-import").open = true;
      throw new Error("Enter the optical product ID, version, license and a valid 2025 acquisition date.");
    }
    imagery = {
      file: scene.name, product_id: value("id"), version: value("version"), license: value("license"),
      family: value("family"), acquired: date.value,
    };
    files.push(scene);
  }
  return { spec: JSON.stringify({ dem, imagery }), files };
}

async function manifestStudy() {
  const manifest = studyForm.elements.spec.files[0];
  const files = [...studyForm.elements.files.files];
  if (!manifest || !files.length) throw new Error("Select the JSON manifest and all of its referenced files.");
  return { spec: await manifest.text(), files };
}

studyForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const saveLocally = study?.can_save_locally && studyForm.elements.save_local.checked;
  runStudyAction(async () => {
    const { spec, files } = await (importMode === "guided" ? guidedStudy() : manifestStudy());
    if (files.reduce((sum, file) => sum + file.size, 0) >= 96 * 1024 * 1024) {
      throw new Error("These files exceed the browser limit. Use the local importer for larger downloads.");
    }
    const body = new FormData();
    body.append("spec", spec);
    for (const file of files) body.append("files", file);
    study = await api(`/api/tsokar/import${saveLocally ? "?save_local=true" : ""}`, { method: "POST", body });
    if (saveLocally) installedStudy = true;
    const { x, y } = studyForm.elements;
    const [windowX, windowY] = [x.value, y.value];
    studyForm.reset();
    x.value = windowX;
    y.value = windowY;
    tileList.replaceChildren();
    appendTile();
    await loadStudyWindow(!byId("study-window").open);
  }, "Validating source metadata and aligning rasters…");
});

function choosePicker(mode) {
  picker = mode;
  byId("pick-base").setAttribute("aria-pressed", String(mode === "start"));
  byId("pick-target").setAttribute("aria-pressed", String(mode === "target"));
  map.classList.toggle("picking", Boolean(mode));
  byId("map-coordinate").textContent = mode ? `Select ${mode === "start" ? "base" : "target"} cell` : "Row, column";
}

byId("pick-base").addEventListener("click", () => choosePicker(picker === "start" ? undefined : "start"));
byId("pick-target").addEventListener("click", () => choosePicker(picker === "target" ? undefined : "target"));
byId("coordinates").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!terrain) return;
  const form = event.currentTarget;
  const parse = (value) => value.split(",").map(Number);
  const start = parse(form.elements.base.value);
  const target = parse(form.elements.target.value);
  if ([start, target].some(([r, c]) => r >= terrain.height || c >= terrain.width)) {
    byId("map-coordinate").textContent = "Point outside map";
    return;
  }
  Object.assign(terrain, { start, target });
  choosePicker(undefined);
  calculate();
});

function locate(event) {
  if (!fit) return;
  const rect = map.getBoundingClientRect();
  const col = Math.floor((event.clientX - rect.left - fit.x) / fit.cellX);
  const row = Math.floor((event.clientY - rect.top - fit.y) / fit.cellY);
  if (row >= 0 && col >= 0 && row < terrain.height && col < terrain.width) return [row, col];
}

map.addEventListener("pointermove", (event) => {
  const cell = locate(event);
  if (!cell) return;
  const [row, col] = cell;
  const z = terrain.elevation[row][col];
  const slope = plan?.slope?.[row][col];
  byId("map-coordinate").textContent = `R${row} C${col} · ${z == null ? "No data" : `${Math.round(z)} m`}${slope == null ? "" : ` · ${slope.toFixed(1)}°`}`;
});
map.addEventListener("click", (event) => {
  const cell = locate(event);
  if (!cell || !picker) return;
  terrain[picker] = cell;
  setPoints();
  choosePicker(undefined);
  calculate();
});

function changeLayer(value) {
  layer = value;
  raster = undefined;
  for (const control of document.querySelectorAll("[data-layer]")) {
    control.setAttribute("aria-pressed", String(control.dataset.layer === layer));
  }
  byId("layer-key").innerHTML = ({
    solar: '<i class="legend-dot shadow"></i> Modeled shadow',
    hazard: '<i class="legend-dot warn"></i> Steep / unknown',
    terrain: '<i class="legend-dot shadow"></i> Elevation contours',
    imagery: '<i class="legend-dot mint"></i> 2025 imagery overlay',
  })[layer];
}

for (const button of document.querySelectorAll("[data-layer]")) {
  button.addEventListener("click", () => {
    changeLayer(button.dataset.layer);
    drawMap();
  });
}

function surface(canvas) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const ratio = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  return { context, width, height };
}

function paintTerrain() {
  const { elevation, min_elevation: low, max_elevation: high, width, height } = terrain;
  const image = document.createElement("canvas");
  const supersample = 4;
  image.width = width * supersample;
  image.height = height * supersample;
  const ctx = image.getContext("2d");
  const pixels = ctx.createImageData(image.width, image.height);
  const startContour = Math.max(2, Math.ceil((high - low) / 24));
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const row = Math.min(height - 1, Math.floor(y / supersample));
      const col = Math.min(width - 1, Math.floor(x / supersample));
      const z = elevation[row][col];
      const index = (y * image.width + x) * 4;
      let color = [12, 18, 32];
      if (z !== null) {
        const nextX = elevation[row][Math.min(col + 1, width - 1)] ?? z;
        const nextY = elevation[Math.min(row + 1, height - 1)][col] ?? z;
        const fx = (x % supersample) / supersample;
        const fy = (y % supersample) / supersample;
        const nextBoth = elevation[Math.min(row + 1, height - 1)][Math.min(col + 1, width - 1)] ?? z;
        const sample = z * (1 - fx) * (1 - fy) + nextX * fx * (1 - fy) + nextY * (1 - fx) * fy + nextBoth * fx * fy;
        const normalized = (sample - low) / Math.max(1, high - low);
        const hill = Math.max(-17, Math.min(21, ((z - nextX) + (nextY - z) * 0.65) * 2));
        const level = (sample - low) / startContour;
        const contour = Math.abs(level - Math.round(level)) < .085 ? 19 : 0;
        const grade = normalized * 53 + hill + contour;
        color = [31 + grade * .88, 47 + grade, 69 + grade * 1.14];
        if (layer === "solar" && plan?.illuminated && !plan.illuminated[row][col]) {
          color = [color[0] * .92 + 11, color[1] * .66 + 1, color[2] * .94 + 30];
        }
        if (layer === "hazard" && plan?.restricted?.[row][col]) color = [123 + hill, 63 + hill, 76 + hill];
      }
      if (z === null && layer === "hazard") color = (x + y) % 9 < 3 ? [101, 54, 68] : [29, 21, 35];
      if (layer === "imagery" && terrain.imagery?.[row][col][3]) {
        const [red, green, blue] = terrain.imagery[row][col];
        color = [red * .71 + 17, green * .71 + 19, blue * .71 + 23];
      }
      pixels.data.set([...color, 255], index);
    }
  }
  ctx.putImageData(pixels, 0, 0);
  return image;
}

function marker(context, x, y, color, label, direction = 1, radius = 5, labelOffset = 0) {
  context.beginPath();
  context.arc(x, y, radius + 4, 0, Math.PI * 2);
  context.fillStyle = "#11192ccd";
  context.fill();
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.strokeStyle = color;
  context.lineWidth = 2;
  context.stroke();
  if (!label) return;
  context.font = "700 11px Segoe UI, sans-serif";
  const length = context.measureText(label).width + 12;
  const origin = x + (direction > 0 ? 9 : -length - 9);
  context.fillStyle = "#0d1427ec";
  context.fillRect(origin, y - 9 + labelOffset, length, 18);
  context.fillStyle = color;
  context.fillText(label, origin + 6, y + 4 + labelOffset);
}

function drawMap() {
  if (!terrain) return;
  const { context, width, height } = surface(map);
  const { dx, dy } = terrain;
  const scale = Math.min(width / (terrain.width * dx), height / (terrain.height * dy));
  const cellX = dx * scale;
  const cellY = dy * scale;
  const w = cellX * terrain.width;
  const h = cellY * terrain.height;
  fit = { x: (width - w) / 2, y: (height - h) / 2, cellX, cellY };
  const xy = ([row, col]) => [fit.x + (col + .5) * cellX, fit.y + (row + .5) * cellY];
  raster ||= paintTerrain();
  context.drawImage(raster, fit.x, fit.y, w, h);
  context.fillStyle = "#aabefc55";
  const spacing = Math.max(1, Math.round(240 / dx));
  for (let c = spacing; c < terrain.width; c += spacing) {
    for (let r = spacing; r < terrain.height; r += spacing) {
      const [x, y] = xy([r, c]);
      context.fillRect(x - 3, y, 6, 1);
      context.fillRect(x, y - 3, 1, 6);
    }
  }
  const bar = scale * 250 < 26 ? Math.round(42 / scale / 10) * 10 : 250;
  const scaleLabel = byId("scale");
  scaleLabel.textContent = `${bar} m`;
  scaleLabel.style.minWidth = `${Math.max(36, bar * scale)}px`;
  function traceRoute(route, color, active, dashed) {
    if (!route?.path?.length) return;
    context.beginPath();
    route.path.forEach((position, index) => {
      const [x, y] = xy(position);
      if (index) context.lineTo(x, y);
      else context.moveTo(x, y);
    });
    context.lineJoin = context.lineCap = "round";
    context.setLineDash(dashed ? [5, 5] : []);
    context.strokeStyle = "#0a1227";
    context.lineWidth = active ? 7 : 4;
    context.stroke();
    context.strokeStyle = color;
    context.lineWidth = active ? 3.4 : 2;
    context.stroke();
    context.setLineDash([]);
  }
  for (const [name, meta] of Object.entries(policies)) {
    if (name !== selected) {
      const route = plan?.routes[name];
      traceRoute(route, meta.color + "af", false, !route?.feasible);
    }
  }
  const active = plan?.routes[selected];
  if (active) traceRoute(active, policies[selected].color, !guidance, !active.feasible);
  if (guidance?.route) traceRoute(guidance.route, "#ffd29e", true, false);
  const relevant = guidance?.route || active;
  const [bx, by] = xy(terrain.start);
  const [tx, ty] = xy(terrain.target);
  marker(context, bx, by, "#c3aaff", "BASE", bx > width * .75 ? -1 : 1);
  marker(context, tx, ty, "#73efbc", "TARGET", tx > width * .65 ? -1 : 1);
  if (relevant?.pnr != null) {
    const [x, y] = xy(relevant.path[relevant.pnr]);
    marker(context, x, y, "#ff9f77", "PNR", x > width * .68 ? -1 : 1, 6, 21);
  }
  if (flight && (flight.index || guidance)) {
    const [x, y] = xy(flight.position);
    marker(context, x, y, "#ffffff", "ROVER", x > width * .70 ? -1 : 1, 5);
  }
}

function drawTimeline() {
  const { context, width, height } = surface(timeline);
  const detail = byId("chart-detail");
  const route = guidance?.route || plan?.routes[selected];
  if (!route) {
    detail.textContent = "Plan a route to see a projected battery curve.";
    return;
  }
  const margin = { left: 44, right: 15, top: 13, bottom: 28 };
  const right = width - margin.right;
  const bottom = height - margin.bottom;
  const curves = guidance?.route ? [[selected, route]] : Object.entries(plan.routes).filter(([, candidate]) => candidate);
  const maxDistance = Math.max(1, ...curves.map(([, candidate]) => candidate.distance));
  const x = (m) => margin.left + (right - margin.left) * m / maxDistance;
  const y = (wh) => bottom - (bottom - margin.top) * Math.max(0, Math.min(wh, settings.capacity)) / settings.capacity;
  context.font = "11px Segoe UI, sans-serif";
  for (let part = 0; part <= 4; part++) {
    const amount = settings.capacity * part / 4;
    const yy = y(amount);
    context.fillStyle = "#9caecc";
    context.fillText(`${Math.round(amount)} Wh`, 2, yy + 4);
    context.strokeStyle = "#263652";
    context.beginPath();
    context.moveTo(margin.left, yy);
    context.lineTo(right, yy);
    context.stroke();
    const d = maxDistance * part / 4;
    const label = `${(d / 1000).toFixed(1)} km`;
    context.fillText(label, Math.min(x(d), right - context.measureText(label).width), bottom + 16);
  }
  function graph(points, field, color, dashed, thickness) {
    context.strokeStyle = color;
    context.lineWidth = thickness;
    let previous = false;
    context.setLineDash(dashed ? [5, 4] : []);
    context.beginPath();
    for (const point of points) {
      const value = point[field];
      if (value == null) { previous = false; continue; }
      if (previous) context.lineTo(x(point.distance), y(value));
      else context.moveTo(x(point.distance), y(value));
      previous = true;
    }
    context.stroke();
    context.setLineDash([]);
  }
  graph([{ distance: 0, floor: plan.floor }, { distance: maxDistance, floor: plan.floor }], "floor", "#91756c", true, 1);
  for (const [name, candidate] of curves) {
    graph(candidate.timeline, "battery", name === selected ? policies[name].color : policies[name].color + "80",
      !candidate.feasible, name === selected ? 2.6 : 1.4);
  }
  graph(route.timeline, "required", "#f8a977", true, 1.5);
  if (flight?.route) {
    const point = flight.route.timeline[flight.index];
    context.fillStyle = "#fff";
    context.beginPath();
    context.arc(x(point.distance), y(flight.battery), 3.5, 0, Math.PI * 2);
    context.fill();
  }
  detail.textContent = `Dashed orange · Return charge   /   Dashed brown · Mission floor ${plan.floor.toFixed(1)} Wh`;
}

new ResizeObserver(() => { drawMap(); drawTimeline(); }).observe(map);
new ResizeObserver(drawTimeline).observe(timeline);
fillParameters();

async function startDashboard() {
  try {
    study = await api("/api/tsokar");
    if (study.id) {
      installedStudy = true;
      await loadStudyWindow(true);
      return;
    }
  } catch (error) {
    startupDataError = `Tso Kar terrain could not load. Synthetic demo active. ${error.message}`;
  }
  await loadDemo(false);
}

startDashboard();
