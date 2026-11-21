import * as THREE from "./vendor/three.module.min.js";

const radians = Math.PI / 180;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const position = (lat, lon) => {
  const phi = lat * radians;
  const theta = lon * radians;
  return new THREE.Vector3(Math.cos(phi) * Math.cos(theta), Math.sin(phi), -Math.cos(phi) * Math.sin(theta));
};

export async function createMoon(host) {
  const status = host.querySelector("#globe-status");
  const spinButton = host.querySelector("#globe-rotation");
  const screenButton = host.querySelector("#globe-fullscreen");
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let rotating = !reduceMotion.matches;
  let lat = -57, lon = 18, distance = 3.85;
  let goalLat = lat, goalLon = lon, goalDistance = distance;
  let home = { lat, lon };
  let pointer, previousTime, frame = 0, ready = false;
  const imageUrl = new URL("./lroc-color-2k.jpg", import.meta.url).href;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(37, 1, .1, 40);
  const canvas = document.createElement("canvas");
  canvas.tabIndex = 0;
  canvas.setAttribute("aria-label", "NASA lunar imagery on a 3D globe. Use arrow keys to rotate, plus or minus to zoom, and Home to reset.");
  const context = canvas.getContext("webgl2", { antialias: true });
  if (!context) {
    const image = new Image();
    image.src = imageUrl;
    image.alt = "NASA LROC global lunar color mosaic in a flat equirectangular projection";
    image.className = "moon-fallback";
    host.prepend(image);
    spinButton.disabled = screenButton.disabled = true;
    status.textContent = "WebGL 2 unavailable. Showing the flat NASA mosaic.";
    image.onerror = () => { status.textContent = "Lunar imagery could not load. Regional DEM layers are still available."; };
    return { focusRegion() {}, reset() {} };
  }
  const renderer = new THREE.WebGLRenderer({ canvas, context, antialias: true });
  renderer.setClearColor("#090f1b");
  const texture = await new THREE.TextureLoader().loadAsync(imageUrl);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), new THREE.MeshStandardMaterial({
    map: texture, roughness: 1, metalness: 0,
  }));
  scene.add(sphere, new THREE.HemisphereLight("#f5f5ff", "#b2bbd5", 1.45));
  const key = new THREE.DirectionalLight("#faf3e8", 2);
  scene.add(key);
  const marker = new THREE.Mesh(new THREE.SphereGeometry(.022, 12, 8),
    new THREE.MeshBasicMaterial({ color: "#bca8ff" }));
  scene.add(marker);
  host.prepend(canvas);
  status.hidden = true;

  function draw(time) {
    frame = 0;
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (!ready || !width || !height || document.hidden) { previousTime = undefined; return; }
    const dt = previousTime === undefined ? 16 : Math.min(40, time - previousTime);
    previousTime = time;
    if (rotating && !pointer) goalLon += dt * .0025;
    const easing = 1 - Math.exp(-dt / 85);
    lat += (goalLat - lat) * easing;
    lon += (goalLon - lon) * easing;
    distance += (goalDistance - distance) * easing;
    camera.position.copy(position(lat, lon)).multiplyScalar(distance);
    camera.lookAt(0, 0, 0);
    key.position.copy(camera.position).add(new THREE.Vector3(-1.7, 2.4, 1));
    renderer.render(scene, camera);
    if (rotating || Math.abs(lat - goalLat) + Math.abs(lon - goalLon) > .01 || Math.abs(distance - goalDistance) > .001) redraw();
    else previousTime = undefined;
  }

  function redraw() {
    if (!frame) frame = requestAnimationFrame(draw);
  }

  function resize() {
    if (host.clientWidth && host.clientHeight) {
      renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
      renderer.setSize(host.clientWidth, host.clientHeight, false);
      camera.aspect = host.clientWidth / host.clientHeight;
      camera.updateProjectionMatrix();
      redraw();
    }
  }

  function updateSpin(next) {
    rotating = next;
    spinButton.textContent = rotating ? "Pause rotation" : "Resume rotation";
    spinButton.setAttribute("aria-pressed", String(!rotating));
    redraw();
  }

  function centre(point) {
    goalLat = clamp(point.lat, -88, 88);
    goalLon = lon + ((((point.lon - lon) % 360) + 540) % 360 - 180);
    redraw();
  }

  function reset() {
    centre(home);
    goalDistance = 3.85;
  }

  function focusRegion(point) {
    marker.position.copy(position(point.lat, point.lon)).multiplyScalar(1.009);
    home = { lat: point.lat < -85 ? -60 : point.lat, lon: point.lon };
    reset();
  }

  function zoom(factor) {
    goalDistance = clamp(goalDistance * factor, 1.38, 12);
    redraw();
  }

  canvas.addEventListener("pointerdown", (event) => {
    pointer = [event.clientX, event.clientY];
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!pointer) return;
    goalLon -= (event.clientX - pointer[0]) * .36;
    goalLat = clamp(goalLat + (event.clientY - pointer[1]) * .36, -88, 88);
    pointer = [event.clientX, event.clientY];
    redraw();
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    canvas.addEventListener(type, () => { pointer = undefined; redraw(); });
  }
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    zoom(event.deltaY > 0 ? 1.14 : 1 / 1.14);
  }, { passive: false });
  canvas.addEventListener("keydown", (event) => {
    const actions = {
      ArrowLeft: () => { goalLon -= 12; }, ArrowRight: () => { goalLon += 12; },
      ArrowUp: () => { goalLat = clamp(goalLat + 8, -88, 88); },
      ArrowDown: () => { goalLat = clamp(goalLat - 8, -88, 88); },
      "+": () => zoom(1 / 1.2), "=": () => zoom(1 / 1.2), "-": () => zoom(1.2), Home: reset,
    };
    if (actions[event.key]) { event.preventDefault(); actions[event.key](); redraw(); }
  });
  spinButton.addEventListener("click", () => updateSpin(!rotating));
  reduceMotion.addEventListener("change", (event) => { if (event.matches) updateSpin(false); });
  screenButton.disabled = !document.fullscreenEnabled;
  screenButton.addEventListener("click", async () => {
    try {
      if (document.fullscreenElement === host) await document.exitFullscreen();
      else await host.requestFullscreen();
    } catch {
      status.hidden = false;
      status.textContent = "Fullscreen is unavailable in this browser.";
    }
  });
  document.addEventListener("fullscreenchange", () => {
    const enabled = document.fullscreenElement === host;
    screenButton.textContent = enabled ? "Exit fullscreen" : "Fullscreen";
    screenButton.setAttribute("aria-pressed", String(enabled));
    resize();
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) redraw(); });
  new ResizeObserver(resize).observe(host);
  ready = true;
  updateSpin(rotating);
  resize();
  return { focusRegion, reset };
}
