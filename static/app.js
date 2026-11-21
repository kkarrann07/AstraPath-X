const byId = (id) => document.getElementById(id);
const map = byId("map");
const timeline = byId("timeline");
const policies = {
  shortest: { name: "Fastest / Shortest", color: "#7de2fa" },
  safest: { name: "Safest", color: "#baacf3" },
  energy: { name: "Energy-efficient", color: "#83e4ae" },
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
let layer = "terrain";
let picker, timer, operation = 0, busy = false, stoppedAtPnr = false;
let preferredRoute = "shortest";
let view = "plan", analysis = "routes", events = [], judgeTimer;
let datasetMessage = "";
const coreNames = new Set(["initial_pct", "reserve", "max_slope"]);
const parameterHelp = {
  initial_pct: "Starting battery as a percentage of total capacity.",
  reserve: "Minimum charge retained during the modeled mission.",
  max_slope: "Reject cells whose steepest neighboring slope exceeds this angle.",
  solar_rate: "Illustrative charging power on illuminated moves when Solar Survival is enabled.",
  azimuth: "Direction of the fixed modeled sun, measured clockwise from grid north.",
  altitude: "Elevation of the modeled sun above the horizon.",
  uncertainty: "Standard deviation of the elevation error used in seeded stress tests.",
};

for (const [name, [title, min, max, step]] of Object.entries(parameters)) {
  const label = document.createElement("label");
  label.textContent = title;
  const input = document.createElement("input");
  Object.assign(input, { name, type: "number", required: true, min, max, step });
  if (parameterHelp[name]) {
    label.title = parameterHelp[name];
    input.setAttribute("aria-description", parameterHelp[name]);
  }
  label.append(input);
  document.querySelector(coreNames.has(name) ? ".core-parameters" : ".advanced-parameters").append(label);
}

function fillParameters() {
  for (const name of Object.keys(parameters)) byId("parameters").elements[name].value = settings[name];
  byId("solar").checked = settings.solar;
  byId("round-trip").checked = settings.round_trip;
  byId("optimization").value = preferredRoute;
}

async function api(url, options) {
  let response;
  try {
    response = await fetch(url.replace(/^\//, ""), options);
  } catch {
    throw new Error("The mission server is unreachable. Check the launcher and retry.");
  }
  const data = await response.json().catch(() => ({}));
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
  byId("plan-mission").disabled = true;
  byId("config-feedback").textContent = "";
  render();
  const request = payload();
  try {
    const nextPlan = await post("/api/plan", request);
    if (serial !== operation) return;
    plan = nextPlan;
    selected = plan.routes[preferredRoute] ? preferredRoute
      : Object.keys(policies).find((name) => plan.routes[name]?.feasible)
      || Object.keys(policies).find((name) => plan.routes[name]);
    busy = false;
    byId("plan-mission").disabled = false;
    resetFlight("Mission planned");
    if (settings.uncertainty && Object.values(plan.routes).some(Boolean)) {
      byId("robustness").textContent = "Running 20 seeded elevation stress tests…";
      try {
        const results = await post("/api/robustness", request);
        if (plan !== nextPlan) return;
        scores = results;
        byId("robustness").textContent = `20 fixed-route trials · σ ${scores.sigma} m · seed ${scores.seed}. Trial counts describe modeled feasibility.`;
        renderRoutes();
        renderIntelligence();
      } catch (error) {
        if (plan === nextPlan) byId("robustness").textContent = error.message;
      }
    } else {
      byId("robustness").textContent = settings.uncertainty ? "Select connected endpoints to run stress tests." : "Elevation uncertainty is off.";
    }
  } catch (error) {
    if (serial !== operation) return;
    busy = false;
    byId("plan-mission").disabled = false;
    plan = { message: error.message, routes: {} };
    render();
  }
}

function halt() {
  clearInterval(timer);
  timer = undefined;
}

function resetFlight(eventTitle = "Simulation reset") {
  halt();
  guidance = undefined;
  stoppedAtPnr = false;
  const route = plan?.routes[selected];
  flight = route?.feasible ? { route, index: 0, battery: plan.initial, position: terrain.start, time: 0 } : undefined;
  events = [];
  logEvent(eventTitle, route?.feasible
    ? `${policies[selected].name} · ${route.end.toFixed(1)} Wh at the destination.`
    : route?.reason || plan?.message || "No route has been planned.");
  render();
}

function logEvent(title, detail) {
  const item = document.createElement("li");
  const time = document.createElement("time");
  const seconds = Math.floor(flight?.time || 0);
  time.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const body = document.createElement("div");
  const heading = document.createElement("strong");
  const description = document.createElement("span");
  heading.textContent = title;
  description.textContent = detail;
  body.append(heading, description);
  item.append(time, body);
  events.unshift(item);
  events = events.slice(0, 32);
  byId("events").replaceChildren(...events);
}

function summary() {
  if (!terrain) return;
  const battery = flight?.battery ?? plan?.initial ?? settings.capacity * settings.initial_pct / 100;
  const percent = Math.round(battery / settings.capacity * 100);
  byId("active-terrain").textContent = terrain.name;
  byId("terrain-origin").textContent = terrain.origin;
  const source = terrain.lunar ? terrain.id : terrain.study ? "ladakh" : terrain.id === "demo" ? "demo" : "upload";
  byId("dataset-select").querySelector('[value="upload"]').hidden = source !== "upload";
  byId("dataset-select").value = source;
  byId("data-status").textContent = datasetMessage || (terrain.lunar
    ? "NASA LOLA grid active. Drive and solar outputs are simulations."
    : terrain.study
    ? (terrain.study.id === "installed" ? "Installed Tso Kar terrain active." : "Imported Tso Kar terrain active for this session.")
    : terrain.id === "demo"
      ? startupDataError || (installedStudy ? "Synthetic demo active. Installed Tso Kar terrain is available."
        : "No Tso Kar dataset installed. Synthetic demo active.")
      : "Uploaded GeoTIFF active for this session.");
  byId("terrain-detail").textContent = terrain.detail;
  byId("map-source").textContent = terrain.lunar ? "MOON · NASA LOLA ELEVATION" : terrain.study ? "TSO KAR · UPLOADED ELEVATION"
    : terrain.id === "demo" ? "SYNTHETIC ELEVATION" : "UPLOADED ELEVATION";
  byId("study-source").hidden = !(terrain.study || terrain.lunar);
  document.querySelector('[data-layer="imagery"]').hidden = !terrain.imagery;
  if (terrain.lunar) {
    byId("study-provenance").textContent = terrain.lunar.provenance;
    byId("study-manifest").href = terrain.lunar.source;
    byId("study-manifest").textContent = "Open NASA elevation product";
  } else if (terrain.study) {
    const products = terrain.study.dem.map(({ product_id, version, acquired }) =>
      `${product_id} · ${version} · ${acquired || "acquisition date unspecified"}`).join(" / ");
    const coverage = `${(100 * terrain.study.coverage).toFixed(1)}% study-area DEM coverage`;
    const image = terrain.study.imagery
      ? `${terrain.study.imagery.display} acquired ${terrain.study.imagery.acquired}` : "No 2025 imagery loaded";
    byId("study-provenance").textContent = `Declared CartoDEM provenance · ${products} · ${coverage} · ${image}`;
    byId("study-manifest").href = `api/tsokar/${terrain.study.id}/manifest`;
    byId("study-manifest").textContent = "Open provenance manifest";
  }
  byId("battery-top").textContent = `${percent}%`;
  byId("battery-detail").textContent = `${battery.toFixed(1)} / ${settings.capacity} Wh`;
  const meter = byId("battery-meter-fill");
  meter.style.width = `${percent}%`;
  meter.classList.toggle("low", battery < (plan?.floor ?? settings.reserve));
  const status = busy ? "PLANNING" : guidance?.status || (flight?.index ? "CONTINUE" : flight ? "READY" : "BLOCKED");
  byId("status-top").dataset.status = status;
  byId("status-top").textContent = status;
  byId("status-detail").textContent = ({
    "STOP/HOLD": "Rover stationary", RETURN: "Modeled path to base", CONTINUE: "Modeled path to target",
    READY: settings.round_trip ? "Return required" : "Outbound mission",
    BLOCKED: "Review mission limits", PLANNING: "Evaluating terrain",
  })[status];
}

function renderIntelligence() {
  const route = guidance ? guidance.route : flight?.route || plan?.routes[selected];
  const point = flight?.route?.timeline[flight.index];
  const target = route?.timeline.at(-1);
  const wh = (value) => value == null ? "—" : `${value.toFixed(1)} Wh`;
  const progress = view === "simulation" && point && point.gross != null;
  const required = progress ? point.required : target?.required;
  byId("drive-label").textContent = progress ? "Energy remaining" : "Drive energy";
  byId("metric-drive").textContent = wh(route && (progress ? Math.max(0, route.gross - point.gross) : route.gross));
  byId("metric-return").textContent = required == null ? (route ? "Unavailable" : "—") : wh(required);
  byId("metric-arrival").textContent = wh(route?.end);
  byId("metric-distance").textContent = route ? `${(route.distance / 1000).toFixed(2)} km` : "—";
  byId("metric-slope").textContent = route ? `${route.max_slope.toFixed(1)}°` : "—";
  byId("metric-solar").textContent = wh(route?.solar);
  const passes = scores?.passes[selected];
  byId("metric-robust").textContent = guidance?.route ? "Original plan only" : passes == null ? "—" : `${passes}/${scores.trials} trials`;
  byId("metric-feasible").textContent = guidance?.status === "STOP/HOLD" ? "On hold" : route ? (route.feasible ? "Feasible" : "Rejected") : "—";
  const action = busy ? "PLANNING" : guidance?.status || (route?.feasible ? "CONTINUE" : "STOP/HOLD");
  byId("recommendation").dataset.action = action;
  byId("recommendation-action").textContent = action === "PLANNING" ? "Planning" : action;
  byId("open-simulation").disabled = !flight || busy;
  byId("judge-simulate").disabled = !flight || busy;
  const feasible = Object.values(plan?.routes || {}).filter((candidate) => candidate?.feasible).length;
  byId("judge-result").textContent = busy ? "Evaluating the revised mission…"
    : route ? `${feasible} of 3 routes feasible. ${policies[selected].name} projects ${route.end.toFixed(1)} Wh at arrival. ${route.reason || ""}`
      : plan?.message || "Choose valid mission conditions.";
}

function renderRoutes() {
  const container = byId("routes");
  const focus = document.activeElement?.dataset.route;
  container.replaceChildren();
  if (!Object.values(plan?.routes || {}).some(Boolean)) {
    const empty = document.createElement("div");
    empty.className = "placeholder";
    empty.textContent = plan?.message || "Calculating terrain and battery constraints…";
    container.append(empty);
    return;
  }
  const head = document.createElement("div");
  head.className = "route-head";
  for (const label of ["Route", "Distance", "Energy", "Slope", "Arrival", "Feasibility"]) {
    const cell = document.createElement("span");
    cell.textContent = label;
    head.append(cell);
  }
  container.append(head);
  for (const [name, meta] of Object.entries(policies)) {
    const route = plan.routes[name];
    if (!route) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.disabled = busy;
    button.className = "route-row";
    button.dataset.route = name;
    button.style.setProperty("--route", meta.color);
    button.setAttribute("aria-pressed", String(name === selected));
    button.title = route.feasible ? "Select route and reset simulation" : route.reason;
    button.innerHTML = `<span class="route-name"><i aria-hidden="true"></i>${meta.name}</span>
      <span class="route-value" data-label="Distance">${(route.distance / 1000).toFixed(2)} km</span>
      <span class="route-value" data-label="Energy">${route.gross.toFixed(1)} Wh</span>
      <span class="route-value" data-label="Slope">${route.max_slope.toFixed(1)}°</span>
      <span class="route-value" data-label="Arrival">${route.end.toFixed(1)} Wh</span>
      <span class="route-state ${route.feasible ? "" : "rejected"}">${route.feasible ? "Feasible" : "Rejected"}</span>`;
    if (!route.feasible) {
      const reason = document.createElement("span");
      reason.className = "route-reason";
      reason.textContent = route.reason;
      button.append(reason);
    }
    button.addEventListener("click", () => {
      if (selected === name) return;
      selected = preferredRoute = name;
      byId("optimization").value = name;
      resetFlight("Route selected");
    });
    container.append(button);
  }
  if (focus) container.querySelector(`[data-route="${focus}"]`)?.focus({ preventScroll: true });
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
  byId("play").textContent = timer ? "Pause" : "Play";
  byId("sim-progress").textContent = point
    ? `${(point.distance / 1000).toFixed(2)} / ${(route.distance / 1000).toFixed(2)} km · ${(flight.time / 60).toFixed(1)} min elapsed`
    : "Choose a feasible route to begin";
  const decision = byId("decision");
  decision.textContent = arrived
    ? (guidance?.status === "RETURN" ? "Base reached." : settings.round_trip ? "Target reached. Modeled return is available from here." : "Target reached.")
    : busy ? "Evaluating battery, terrain and return constraints…"
      : guidance?.reason || (route?.feasible
        ? `The selected route reaches the target with ${route.end.toFixed(1)} Wh. The mission floor is ${plan.floor.toFixed(1)} Wh.`
        : route?.reason || plan?.message || "Choose valid waypoints and plan a mission.");
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
  renderIntelligence();
  drawMap();
  drawTimeline();
}

function advance(cells) {
  if (busy || !flight?.route) return;
  const route = flight.route;
  const previousIndex = flight.index;
  const previousPoint = route.timeline[previousIndex];
  let pause = false;
  let next = Math.min(flight.index + cells, route.path.length - 1);
  if (!stoppedAtPnr && route.pnr != null && route.pnr > flight.index && next >= route.pnr) {
    next = route.pnr - 1;
    stoppedAtPnr = true;
    pause = true;
    halt();
  }
  const point = route.timeline[next];
  flight.time += point.seconds - route.timeline[flight.index].seconds;
  Object.assign(flight, { index: next, position: route.path[next], battery: point.battery });
  for (let index = previousIndex + 1; index <= next; index += 1) {
    const current = route.timeline[index];
    if (route.timeline[index - 1].lit !== current.lit) {
      logEvent(current.lit ? "Entered sunlight" : "Entered shadow",
        current.lit && settings.solar ? "Modeled charging is available on illuminated moves." : "No charging on this segment.");
    }
  }
  if (pause) logEvent("Point of No Return", "Rover paused before the first modeled return deficit.");
  if (route.pnr != null && previousIndex < route.pnr && next >= route.pnr) {
    logEvent("Passed return threshold", "Current modeled charge at the crossing was below the return requirement.");
  }
  if (next === route.path.length - 1) {
    halt();
    logEvent(guidance?.status === "RETURN" ? "Base reached" : "Target reached", `${point.battery.toFixed(1)} Wh remaining.`);
  } else if (!timer && !pause && next > previousIndex) {
    const solar = point.solar != null ? ` Received ${Math.max(0, point.solar - previousPoint.solar).toFixed(1)} Wh from solar.` : "";
    logEvent("Rover advanced", `${point.battery.toFixed(1)} Wh remaining.${solar}`);
  }
  summary();
  renderFlight();
  renderIntelligence();
  drawMap();
  drawTimeline();
}

async function perturb(action) {
  if (!flight || busy) return;
  halt();
  const position = flight.position;
  const before = flight.battery;
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
  logEvent(({ idle: "Waited 10 minutes", loss: "Battery fault injected", return: "Return requested" })[action],
    `Charge ${before.toFixed(1)} → ${flight.battery.toFixed(1)} Wh. Replanning from row ${position[0]}, column ${position[1]}.`);
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
    logEvent(guidance.status, guidance.reason);
  } catch (error) {
    if (serial !== operation) return;
    guidance = { status: "STOP/HOLD", reason: error.message };
    flight.route = undefined;
    logEvent("Replan unavailable", error.message);
  }
  busy = false;
  render();
}

byId("parameters").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!terrain || !readPoints()) return;
  for (const name of Object.keys(parameters)) settings[name] = Number(event.currentTarget.elements[name].value);
  preferredRoute = byId("optimization").value;
  if (terrain) calculate();
});
for (const [id, name] of [["solar", "solar"], ["round-trip", "round_trip"]]) {
  byId(id).addEventListener("change", (event) => {
    settings[name] = event.target.checked;
    if (terrain) calculate();
  });
}

byId("play").addEventListener("click", () => {
  if (timer) {
    halt();
    logEvent("Simulation paused", `${flight.battery.toFixed(1)} Wh remaining.`);
  } else {
    timer = setInterval(() => advance(2), 165);
    logEvent("Simulation running", `${flight.battery.toFixed(1)} Wh at departure from this cell.`);
  }
  renderFlight();
});
byId("step").addEventListener("click", () => advance(5));
byId("reset").addEventListener("click", () => resetFlight());
byId("drop").addEventListener("click", () => perturb("loss"));
byId("wait").addEventListener("click", () => perturb("idle"));
byId("return").addEventListener("click", () => perturb("return"));
byId("loss").addEventListener("input", (event) => { byId("loss-value").value = `${event.target.value}%`; });

function setAnalysis(choice) {
  analysis = choice;
  for (const button of document.querySelectorAll("[data-analysis]")) {
    button.setAttribute("aria-pressed", String(button.dataset.analysis === analysis));
  }
  byId("route-pane").hidden = analysis !== "routes";
  byId("battery-pane").hidden = analysis !== "battery";
  if (analysis === "battery") drawTimeline();
}

let comparison;

function setView(choice) {
  if (choice !== "simulation" && timer) {
    halt();
    logEvent("Simulation paused", "Left the simulation workspace.");
  }
  view = choice;
  document.body.dataset.view = view;
  for (const button of document.querySelectorAll("[data-view-choice]")) {
    button.setAttribute("aria-pressed", String(button.dataset.viewChoice === view));
  }
  byId("mission-heading").hidden = byId("mission-workspace").hidden = choice === "compare";
  byId("comparison").hidden = choice !== "compare";
  byId("skip-terrain").href = choice === "compare" ? "#compare-title" : "#map-title";
  if (choice === "compare") {
    comparison ??= import("./compare.js").then(({ initComparison }) => initComparison({
      api, currentTerrain: () => terrain, currentStudy: () => study,
      openISRO: () => byId("real-mode").click(),
      openPlanner: (grid, slope) => {
        setView("plan");
        settings.max_slope = slope;
        fillParameters();
        return activateTerrain(grid);
      },
    })).catch(() => {
      byId("globe-status").textContent = "Comparison could not load. Reload the dashboard and try again.";
      comparison = undefined;
    });
    comparison.then((workspace) => { if (view === "compare") workspace?.open(); });
    return;
  }
  byId("mode-description").textContent = view === "simulation"
    ? "Follow the rover, inject a fault and inspect the replan."
    : "Plan a traverse and check its modeled energy and return margins.";
  setAnalysis(view === "simulation" ? "battery" : "routes");
  renderFlight();
  renderIntelligence();
}

function activateTerrain(grid) {
  terrain = grid;
  datasetMessage = "";
  resetMap(false);
  changeLayer(terrain.imagery ? "imagery" : "terrain");
  setPoints();
  choosePicker(undefined);
  return calculate();
}

for (const button of document.querySelectorAll("[data-view-choice]")) {
  button.addEventListener("click", () => setView(button.dataset.viewChoice));
}
for (const button of document.querySelectorAll("[data-analysis]")) {
  button.addEventListener("click", () => setAnalysis(button.dataset.analysis));
}
byId("open-simulation").addEventListener("click", () => {
  setView("simulation");
  byId("play").focus();
});
byId("config-toggle").addEventListener("click", (event) => {
  const expanded = event.currentTarget.getAttribute("aria-expanded") === "true";
  event.currentTarget.setAttribute("aria-expanded", String(!expanded));
  event.currentTarget.textContent = expanded ? "Show settings" : "Hide settings";
});
for (const form of [byId("parameters"), byId("coordinates")]) {
  form.addEventListener("input", (event) => {
    if (event.target.id === "solar" || event.target.id === "round-trip") return;
    byId("config-feedback").textContent = "Changes pending. Plan mission to apply.";
  });
}

async function loadDemo() {
  try {
    terrain = await api("/api/terrain/demo");
    datasetMessage = "";
    resetMap(false);
    changeLayer("terrain");
    settings = { ...defaultSettings };
    selected = preferredRoute = "shortest";
    fillParameters();
    setPoints();
    choosePicker(undefined);
    return calculate();
  } catch (error) {
    byId("decision").textContent = error.message;
  }
}

const judge = byId("judge-dialog");
byId("demo").addEventListener("click", () => {
  judge.returnValue = "";
  byId("judge-form").reset();
  byId("judge-battery-value").value = "82%";
  byId("judge-slope-value").value = "19°";
  byId("judge-result").textContent = "Preparing the challenge…";
  byId("judge-simulate").disabled = true;
  setView("plan");
  judge.showModal();
  loadDemo();
});
byId("judge-form").addEventListener("input", () => {
  const battery = Number(byId("judge-battery").value);
  const slope = Number(byId("judge-slope").value);
  byId("judge-battery-value").value = `${battery}%`;
  byId("judge-slope-value").value = `${slope}°`;
  byId("judge-result").textContent = "Updating mission constraints…";
  byId("judge-simulate").disabled = true;
  clearTimeout(judgeTimer);
  judgeTimer = setTimeout(() => {
    if (!terrain) return;
    Object.assign(settings, { initial_pct: battery, max_slope: slope, solar: byId("judge-solar").checked,
      round_trip: byId("judge-return").checked });
    fillParameters();
    calculate();
  }, 220);
});
judge.addEventListener("close", () => {
  if (judge.returnValue === "simulation") {
    setView("simulation");
    byId("play").focus();
  }
});

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
    datasetMessage = "";
    resetMap(false);
    changeLayer("terrain");
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
  const size = study?.upload_limit_mib > 96 ? "2 GiB" : "96 MiB";
  byId("study-upload-limit").textContent = `Browser imports support up to ${size} per request. Session-only imports expire when the server restarts.`;
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
  const grid = await api(`/api/tsokar/${study.id}/window${query}`);
  if (grid.window) {
    studyForm.elements.x.value = grid.window.x.toFixed(2);
    studyForm.elements.y.value = grid.window.y.toFixed(2);
  }
  studyDialog.close();
  activateTerrain(grid);
  if (view === "compare") comparison?.then((workspace) => workspace?.open({ preferLadakh: true }));
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
    const limit = study?.upload_limit_mib ?? 96;
    if (files.reduce((sum, file) => sum + file.size, 0) >= limit * 1024 * 1024) {
      throw new Error(limit > 96 ? "These files exceed the 2 GiB browser limit."
        : "These files exceed 96 MiB. Open the app with Start_AstraPath.bat to import larger downloads.");
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

for (const [button, mode] of [["pick-base", "start"], ["pick-target", "target"]]) {
  byId(button).addEventListener("click", () => {
    choosePicker(picker === mode ? undefined : mode);
    if (picker) map.focus();
  });
}
byId("coordinates").addEventListener("submit", (event) => {
  event.preventDefault();
  byId("parameters").requestSubmit();
});
byId("coordinates").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target.tagName === "INPUT") {
    event.preventDefault();
    byId("parameters").requestSubmit();
  }
});

function readPoints() {
  const form = byId("coordinates");
  if (!form.reportValidity()) return false;
  const parse = (value) => value.trim().split(",").map(Number);
  const start = parse(form.elements.base.value);
  const target = parse(form.elements.target.value);
  if ([start, target].some(([r, c]) => r >= terrain.height || c >= terrain.width)) {
    byId("config-feedback").textContent = "One of the coordinates falls outside this terrain grid.";
    return false;
  }
  Object.assign(terrain, { start, target });
  choosePicker(undefined);
  return true;
}

byId("dataset-select").addEventListener("change", async (event) => {
  const choice = event.target.value;
  if (choice.startsWith("lunar-")) {
    try { await activateTerrain(await api(`/api/terrain/${choice}/comparison`)); }
    catch (error) { datasetMessage = error.message; summary(); }
  } else if (choice === "ladakh") {
    if (study?.id) {
      try { await loadStudyWindow(true); }
      catch (error) { datasetMessage = error.message; summary(); }
    } else {
      summary();
      byId("real-mode").click();
    }
  } else if (choice === "demo" && terrain?.id !== "demo") {
    await loadDemo();
  }
});

let zoom = 1;
let shiftX = 0, shiftY = 0;
let drag;
const tooltip = byId("map-tooltip");

function resetMap(redraw = true) {
  zoom = 1;
  shiftX = shiftY = 0;
  tooltip.hidden = true;
  if (redraw) drawMap();
}

function zoomMap(multiplier, point = [map.clientWidth / 2, map.clientHeight / 2]) {
  const target = Math.min(7, Math.max(1, zoom * multiplier));
  if (target === 1) { resetMap(); return; }
  const ratio = target / zoom;
  shiftX = (shiftX + map.clientWidth / 2 - point[0]) * ratio + point[0] - map.clientWidth / 2;
  shiftY = (shiftY + map.clientHeight / 2 - point[1]) * ratio + point[1] - map.clientHeight / 2;
  zoom = target;
  tooltip.hidden = true;
  drawMap();
}

byId("zoom-in").addEventListener("click", () => zoomMap(1.4));
byId("zoom-out").addEventListener("click", () => zoomMap(1 / 1.4));
byId("zoom-reset").addEventListener("click", () => resetMap());

function mapPoint(event) {
  const bounds = map.getBoundingClientRect();
  return [event.clientX - bounds.left, event.clientY - bounds.top];
}

function locate([x, y]) {
  if (!fit) return;
  const col = Math.floor((x - fit.x) / fit.cellX);
  const row = Math.floor((y - fit.y) / fit.cellY);
  if (row >= 0 && col >= 0 && row < terrain.height && col < terrain.width) return [row, col];
}

function projected([row, col]) {
  return [fit.x + (col + .5) * fit.cellX, fit.y + (row + .5) * fit.cellY];
}

function showRouteTooltip([x, y]) {
  let nearest;
  let limit = 10;
  const options = Object.entries(plan?.routes || {}).filter(([, route]) => route);
  if (guidance?.route) options.unshift(["replan", guidance.route]);
  for (const [name, route] of options) {
    for (let index = 1; index < route.path.length; index += 1) {
      const [x1, y1] = projected(route.path[index - 1]);
      const [x2, y2] = projected(route.path[index]);
      const dx = x2 - x1, dy = y2 - y1;
      const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
      const distance = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
      if (distance < limit || (distance === limit && name === selected)) {
        limit = distance;
        nearest = { name, route, index };
      }
    }
  }
  tooltip.hidden = !nearest;
  if (!nearest) return;
  const { name, route, index } = nearest;
  const point = route.timeline[index];
  const title = document.createElement("strong");
  title.textContent = policies[name]?.name || "Emergency route";
  tooltip.replaceChildren(title, `${(route.distance / 1000).toFixed(2)} km · ${route.gross.toFixed(1)} Wh drive · ${route.max_slope.toFixed(1)}° max`,
    document.createElement("br"), `${point.battery.toFixed(1)} Wh at this cell · ${point.lit ? "Sunlit" : "Shadow"}`);
  tooltip.style.left = `${Math.max(6, Math.min(x + 12, map.clientWidth - tooltip.offsetWidth - 7))}px`;
  tooltip.style.top = `${Math.max(6, Math.min(y + 11, map.clientHeight - tooltip.offsetHeight - 7))}px`;
}

function placeWaypoint(cell) {
  if (!cell || !picker) return;
  terrain[picker] = cell;
  setPoints();
  choosePicker(undefined);
  calculate();
}

map.addEventListener("pointerdown", (event) => {
  if (picker || !terrain || event.button !== 0) return;
  drag = { point: mapPoint(event), moved: false };
  map.setPointerCapture(event.pointerId);
});
map.addEventListener("pointermove", (event) => {
  const point = mapPoint(event);
  if (drag) {
    const dx = point[0] - drag.point[0], dy = point[1] - drag.point[1];
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    shiftX += dx;
    shiftY += dy;
    drag.point = point;
    map.classList.add("dragging");
    tooltip.hidden = true;
    drawMap();
    return;
  }
  const cell = locate(point);
  if (!cell) { tooltip.hidden = true; return; }
  const [row, col] = cell;
  const z = terrain.elevation[row][col];
  const slope = plan?.slope?.[row][col];
  byId("map-coordinate").textContent = `R${row} C${col} · ${z == null ? "No data" : `${Math.round(z)} m`}${slope == null ? "" : ` · ${slope.toFixed(1)}°`}`;
  if (!picker) showRouteTooltip(point);
});
map.addEventListener("pointerleave", () => { tooltip.hidden = true; });
map.addEventListener("lostpointercapture", () => { drag = undefined; map.classList.remove("dragging"); });
map.addEventListener("click", (event) => placeWaypoint(locate(mapPoint(event))));
map.addEventListener("wheel", (event) => {
  if (!terrain) return;
  event.preventDefault();
  zoomMap(event.deltaY > 0 ? 1 / 1.24 : 1.24, mapPoint(event));
}, { passive: false });
map.addEventListener("keydown", (event) => {
  const pan = { ArrowLeft: [32, 0], ArrowRight: [-32, 0], ArrowUp: [0, 32], ArrowDown: [0, -32] }[event.key];
  if (pan) {
    shiftX += pan[0];
    shiftY += pan[1];
    drawMap();
  } else if (event.key === "+" || event.key === "=") zoomMap(1.4);
  else if (event.key === "-") zoomMap(1 / 1.4);
  else if (event.key === "Home") resetMap();
  else if (event.key === "Enter" && picker) placeWaypoint(locate([map.clientWidth / 2, map.clientHeight / 2]));
  else if (event.key === "Escape" && picker) choosePicker(undefined);
  else return;
  event.preventDefault();
});

function changeLayer(value) {
  layer = value;
  raster = undefined;
  for (const control of document.querySelectorAll("[data-layer]")) {
    control.setAttribute("aria-pressed", String(control.dataset.layer === layer));
  }
  byId("layer-key").innerHTML = ({
    solar: '<i class="legend-dot sun"></i> Sunlit <i class="legend-dot shadow"></i> Modeled shadow',
    hazard: '<i class="legend-dot hazard"></i> Restricted slope / NoData',
    terrain: '<i class="legend-ramp"></i> DEM elevation',
    slope: '<i class="legend-ramp slope"></i> 0°–35°+',
    imagery: '<i class="legend-dot target"></i> Registered imagery',
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
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
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
      let color = [12, 20, 31];
      if (z !== null) {
        const nextX = elevation[row][Math.min(col + 1, width - 1)] ?? z;
        const nextY = elevation[Math.min(row + 1, height - 1)][col] ?? z;
        const fx = (x % supersample) / supersample;
        const fy = (y % supersample) / supersample;
        const nextBoth = elevation[Math.min(row + 1, height - 1)][Math.min(col + 1, width - 1)] ?? z;
        const sample = z * (1 - fx) * (1 - fy) + nextX * fx * (1 - fy) + nextY * (1 - fx) * fy + nextBoth * fx * fy;
        const normalized = (sample - low) / Math.max(1, high - low);
        const gradeX = (z - nextX) / terrain.dx;
        const gradeY = (nextY - z) / terrain.dy;
        const hill = Math.max(-20, Math.min(26, (gradeX + gradeY * .7) * 58));
        const level = (sample - low) / startContour;
        const contour = Math.abs(level - Math.round(level)) < .085 ? 15 : 0;
        const value = hill + contour;
        color = [36 + 89 * normalized + value, 60 + 88 * normalized + value, 75 + 64 * normalized + value];
        if (layer === "solar" && plan?.illuminated) {
          color = plan.illuminated[row][col]
            ? [color[0] * .87 + 27, color[1] * .82 + 17, color[2] * .72 + 13]
            : [color[0] * .67 + 18, color[1] * .6 + 8, color[2] * .85 + 26];
        }
        if (layer === "slope" && plan?.slope) {
          const degrees = plan.slope[row][col];
          if (degrees == null) color = [27, 35, 48];
          else {
            const t = Math.min(1, degrees / 35);
            color = [43 + 131 * t + contour, 69 + 57 * Math.sin(t * Math.PI) + contour, 89 - 32 * t + contour];
          }
        }
        if (layer === "hazard" && plan?.restricted?.[row][col]) color = [162 + hill, 65 + hill, 73 + hill];
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
  if (!terrain || !map.clientWidth || !map.clientHeight) return;
  const { context, width, height } = surface(map);
  const { dx, dy } = terrain;
  const scale = Math.min(width / (terrain.width * dx), height / (terrain.height * dy)) * zoom;
  const cellX = dx * scale;
  const cellY = dy * scale;
  const w = cellX * terrain.width;
  const h = cellY * terrain.height;
  const limitX = Math.max(0, (width + w) / 2 - 60);
  const limitY = Math.max(0, (height + h) / 2 - 60);
  shiftX = Math.min(limitX, Math.max(-limitX, shiftX));
  shiftY = Math.min(limitY, Math.max(-limitY, shiftY));
  fit = { x: (width - w) / 2 + shiftX, y: (height - h) / 2 + shiftY, cellX, cellY };
  const xy = projected;
  raster ||= paintTerrain();
  context.drawImage(raster, fit.x, fit.y, w, h);
  context.strokeStyle = "#d6e8f12e";
  context.lineWidth = 1;
  context.strokeRect(fit.x + .5, fit.y + .5, w - 1, h - 1);
  context.fillStyle = "#d8ecf237";
  const spacingX = Math.max(1, Math.round(300 / dx));
  const spacingY = Math.max(1, Math.round(300 / dy));
  for (let c = spacingX; c < terrain.width; c += spacingX) {
    for (let r = spacingY; r < terrain.height; r += spacingY) {
      const [x, y] = xy([r, c]);
      context.fillRect(x - 3, y, 6, 1);
      context.fillRect(x, y - 3, 1, 6);
    }
  }
  const meters = 86 / scale;
  const power = 10 ** Math.floor(Math.log10(meters));
  const bar = [5, 2, 1].find((factor) => factor * power <= meters) * power;
  byId("scale").textContent = bar >= 1000 ? `${bar / 1000} km` : `${Number(bar.toPrecision(2))} m`;
  byId("scale-line").style.width = `${bar * scale}px`;
  byId("zoom-out").disabled = zoom <= 1;
  byId("zoom-in").disabled = zoom >= 7;
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
  if (relevant?.pnr != null) {
    context.beginPath();
    for (let index = 1; index < relevant.timeline.length; index += 1) {
      const point = relevant.timeline[index];
      if (point.required == null || point.battery + .00001 < point.required) {
        context.moveTo(...xy(relevant.path[index - 1]));
        context.lineTo(...xy(relevant.path[index]));
      }
    }
    context.strokeStyle = "#ffa68d";
    context.lineWidth = 3.5;
    context.setLineDash([3, 3]);
    context.stroke();
    context.setLineDash([]);
  }
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
  } else if (flight) {
    context.fillStyle = "#ffffff";
    context.fillRect(bx - 1, by - 1, 2, 2);
  }
}

function drawTimeline() {
  if (analysis !== "battery" || !timeline.clientWidth) return;
  const { context, width, height } = surface(timeline);
  const detail = byId("chart-detail");
  const route = guidance ? guidance.route : plan?.routes[selected];
  if (!route) {
    detail.textContent = guidance?.status === "STOP/HOLD"
      ? `Rover on hold at ${flight.battery.toFixed(1)} Wh. No feasible route forecast is available.`
      : "Plan a route to see a projected battery curve.";
    return;
  }
  const margin = { left: 47, right: 14, top: 14, bottom: 30 };
  const right = width - margin.right;
  const bottom = height - margin.bottom;
  const curves = guidance?.route ? [[selected, route]] : Object.entries(plan.routes).filter(([, candidate]) => candidate);
  const maxDistance = Math.max(1, ...curves.map(([, candidate]) => candidate.distance));
  const x = (m) => margin.left + (right - margin.left) * m / maxDistance;
  const maxWh = Math.max(settings.capacity, Math.ceil(route.gross / 20) * 20);
  const y = (wh) => bottom - (bottom - margin.top) * Math.max(0, Math.min(wh, maxWh)) / maxWh;
  context.font = "11px Segoe UI, sans-serif";
  for (let index = 1; index < route.timeline.length; index += 1) {
    const point = route.timeline[index];
    const previous = route.timeline[index - 1];
    const left = x(previous.distance);
    const patchWidth = x(point.distance) - left + .5;
    context.fillStyle = point.lit ? "#c5a36f16" : "#8e81cb23";
    context.fillRect(left, margin.top, patchWidth, bottom - margin.top);
    context.fillStyle = point.lit ? "#aa8655" : "#7666ab";
    context.fillRect(left, bottom, patchWidth, 3);
  }
  for (let part = 0; part <= 4; part++) {
    const amount = maxWh * part / 4;
    const yy = y(amount);
    context.fillStyle = "#9caecc";
    context.fillText(`${Math.round(amount)} Wh`, 2, yy + 4);
    context.strokeStyle = "#263652";
    context.beginPath();
    context.moveTo(margin.left, yy);
    context.lineTo(right, yy);
    context.stroke();
    const d = maxDistance * part / 4;
    const label = maxDistance < 1000 ? `${Math.round(d)} m` : `${(d / 1000).toFixed(1)} km`;
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
  if (route.timeline.at(-1).gross != null) {
    graph(route.timeline, "gross", "#d0dfec", true, 1.1);
    graph(route.timeline, "solar", "#7ed5a5", true, 1.15);
  }
  graph(route.timeline, "required", "#f8a977", true, 1.5);
  if (flight?.route) {
    const point = flight.route.timeline[flight.index];
    const current = x(point.distance);
    context.strokeStyle = "#dcecf669";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(current, margin.top);
    context.lineTo(current, bottom);
    context.stroke();
    context.fillStyle = "#fff";
    context.beginPath();
    context.arc(current, y(flight.battery), 3.5, 0, Math.PI * 2);
    context.fill();
  }
  detail.textContent = `Projected charge by distance · Drive ${route.gross.toFixed(1)} Wh · Solar ${route.solar.toFixed(1)} Wh · Floor ${plan.floor.toFixed(1)} Wh`;
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
  await loadDemo();
}

startDashboard();
