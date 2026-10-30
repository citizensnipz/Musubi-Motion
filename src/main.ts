import "./style.css";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";

const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const viewport = element<HTMLDivElement>("viewport");
const notice = element<HTMLDivElement>("notice");
const play = element<HTMLButtonElement>("play");
const rewind = element<HTMLButtonElement>("rewind");
const timeline = element<HTMLInputElement>("timeline");
const theme = element<HTMLButtonElement>("theme");
const fileInput = element<HTMLInputElement>("file");
const duration = 12;
let renderer: THREE.WebGLRenderer | undefined;
let scene: THREE.Scene | undefined;
let grid: THREE.GridHelper | undefined;

function applyTheme() {
  const dark = document.documentElement.dataset.theme !== "light";
  theme.setAttribute(
    "aria-label",
    `Switch to ${dark ? "light" : "dark"} theme`,
  );
  theme.title = theme.getAttribute("aria-label")!;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", dark ? "#171717" : "#f2f2f2");
  if (scene) scene.background = new THREE.Color(dark ? "#171717" : "#f2f2f2");
  if (grid) {
    const materials = Array.isArray(grid.material)
      ? grid.material
      : [grid.material];
    materials.forEach((material) => {
      material.opacity = dark ? 0.16 : 0.1;
    });
  }
}
theme.addEventListener("click", () => {
  const next =
    document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("musubi-theme", next);
  } catch {
    /* Storage may be restricted. */
  }
  applyTheme();
});
applyTheme();

async function start() {
  try {
    renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
  } catch {
    notice.textContent =
      "WebGL2 is unavailable. Try a browser with hardware acceleration enabled.";
    element<HTMLParagraphElement>("asset-detail").textContent =
      "Renderer unavailable";
    element<HTMLButtonElement>("open").disabled = true;
    element<HTMLButtonElement>("demo").disabled = true;
    element<HTMLButtonElement>("reset").disabled = true;
    return;
  }
  const webgl = renderer;
  webgl.setPixelRatio(Math.min(devicePixelRatio, 2));
  webgl.domElement.setAttribute(
    "aria-label",
    "Interactive Gaussian splat scene",
  );
  viewport.prepend(webgl.domElement);
  scene = new THREE.Scene();
  const world = scene;
  const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 1000);
  const controls = new OrbitControls(camera, webgl.domElement);
  controls.enableDamping = true;
  const spark = new SparkRenderer({ renderer: webgl });
  world.add(spark);
  const pivot = new THREE.Group();
  world.add(pivot);
  grid = new THREE.GridHelper(20, 40, 0x888888, 0x888888);
  const materials = Array.isArray(grid.material)
    ? grid.material
    : [grid.material];
  materials.forEach((material) => {
    material.transparent = true;
    material.depthWrite = false;
  });
  world.add(grid);
  applyTheme();

  let active: SplatMesh | undefined;
  let radius = 2;
  let time = 0;
  let playing = false;
  let loading = false;
  let previous = 0;
  let loadId = 0;
  const fitView = () => {
    const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
    const limitingFov = Math.min(
      halfFov,
      Math.atan(Math.tan(halfFov) * camera.aspect),
    );
    const distance = (radius / Math.sin(limitingFov)) * 1.15;
    camera.position.set(0.35, 0.2, 1).normalize().multiplyScalar(distance);
    camera.near = Math.max(radius / 1000, 0.0001);
    camera.far = Math.max(distance * 50, 100);
    camera.updateProjectionMatrix();
    controls.target.set(0, 0, 0);
    controls.minDistance = radius * 0.15;
    controls.maxDistance = distance * 10;
    controls.update();
  };
  const resize = () => {
    const { width, height } = viewport.getBoundingClientRect();
    webgl.setSize(width, height);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(viewport);
  resize();

  const updateTime = () => {
    pivot.rotation.y = (time / duration) * Math.PI * 2;
    timeline.value = String(time);
    element<HTMLOutputElement>("time").value =
      `${time.toFixed(2).padStart(5, "0")} / 12.00`;
  };
  const setPlaying = (value: boolean) => {
    playing = value;
    play.textContent = value ? "Ⅱ" : "▶";
    play.setAttribute(
      "aria-label",
      value ? "Pause animation" : "Play animation",
    );
  };
  const setLoading = (value: boolean) => {
    loading = value;
    element<HTMLButtonElement>("open").disabled = value;
    element<HTMLButtonElement>("demo").disabled = value;
    play.disabled = value || !active;
    rewind.disabled = value || !active;
    timeline.disabled = value || !active;
  };

  async function load(
    create: () => SplatMesh | Promise<SplatMesh>,
    name: string,
    demo = false,
  ) {
    const id = ++loadId;
    setPlaying(false);
    setLoading(true);
    notice.textContent = "Loading splats…";
    let candidate: SplatMesh | undefined;
    try {
      candidate = await create();
      await candidate.initialized;
      if (id !== loadId) {
        candidate.dispose();
        return;
      }
      const bounds = candidate.getBoundingBox();
      if (
        bounds.isEmpty() ||
        !Number.isFinite(bounds.min.length() + bounds.max.length())
      ) {
        throw new Error("The file contains no usable splats.");
      }
      const sphere = bounds.getBoundingSphere(new THREE.Sphere());
      radius = Math.max(sphere.radius, 0.01);
      candidate.position.copy(sphere.center).negate();
      if (active) {
        pivot.remove(active);
        active.dispose();
      }
      active = candidate;
      pivot.add(active);
      grid!.position.y = bounds.min.y - sphere.center.y - radius * 0.04;
      grid!.scale.setScalar(radius / 2);
      time = 0;
      updateTime();
      fitView();
      element<HTMLHeadingElement>("asset-name").textContent = name;
      const count =
        active.packedSplats?.numSplats ?? active.extSplats?.numSplats;
      element<HTMLParagraphElement>("asset-detail").textContent =
        `${count?.toLocaleString() ?? "Loaded"} splats · ${demo ? "Procedural demo" : "Local file"}`;
      notice.textContent = "";
    } catch (error) {
      candidate?.dispose();
      notice.textContent = `Could not load this scene. ${error instanceof Error ? error.message : "Try another splat file."}`;
    } finally {
      if (id === loadId) setLoading(false);
    }
  }

  function makeDemo() {
    // Sample a knot surface into real anisotropic Gaussian splats, without fetching an asset.
    const geometry = new THREE.TorusKnotGeometry(1.3, 0.37, 400, 28, 2, 3);
    const positions = geometry.getAttribute("position");
    const normals = geometry.getAttribute("normal");
    const position = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3(0.034, 0.034, 0.012);
    const color = new THREE.Color();
    const light = new THREE.Vector3(-0.4, 0.8, 1).normalize();
    const mesh = new SplatMesh({
      constructSplats(splats) {
        for (let i = 0; i < positions.count; i++) {
          position.fromBufferAttribute(positions, i);
          normal.fromBufferAttribute(normals, i);
          rotation.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
          const shade = 0.19 + 0.65 * Math.max(0, normal.dot(light));
          color.setRGB(shade, shade, shade);
          splats.pushSplat(position, scale, rotation, 0.95, color);
        }
      },
    });
    geometry.dispose();
    return mesh;
  }

  element("open").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file || loading) return;
    void load(
      async () =>
        new SplatMesh({
          fileBytes: await file.arrayBuffer(),
          fileName: file.name,
        }),
      file.name,
    );
  });
  element("demo").addEventListener(
    "click",
    () => void load(makeDemo, "Splat study", true),
  );
  element("reset").addEventListener("click", fitView);
  play.addEventListener("click", () => setPlaying(!playing));
  rewind.addEventListener("click", () => {
    setPlaying(false);
    time = 0;
    updateTime();
  });
  timeline.addEventListener("input", () => {
    setPlaying(false);
    time = Number(timeline.value);
    updateTime();
  });
  webgl.domElement.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    setPlaying(false);
    webgl.setAnimationLoop(null);
    notice.textContent =
      "The graphics context was lost. Reload the page to restore the workspace.";
    setLoading(true);
  });
  webgl.setAnimationLoop((now) => {
    const delta = previous ? Math.min((now - previous) / 1000, 0.1) : 0;
    previous = now;
    if (playing) {
      time = (time + delta) % duration;
      updateTime();
    }
    controls.update();
    webgl.render(world, camera);
  });
  await load(makeDemo, "Splat study", true);
}

void start().catch((error) => {
  renderer?.setAnimationLoop(null);
  notice.textContent = `The viewer could not start. ${error instanceof Error ? error.message : "Please reload the page."}`;
});
