import { strFromU8, strToU8, unzip, zip } from "fflate";
import { validateJoints } from "./skeleton.ts";
import { validateElasticity } from "./elasticity";
import { validateAnimation } from "./animation.ts";
import { validateDrivenKeys } from "./driven-keys.ts";
import { validateIKHandles } from "./ik.ts";
import { validateConstraints } from "./constraints.ts";
import type { SceneDocument, Vec3 } from "./scene-document.ts";

export const MAX_PROJECT_BYTES = 512 * 1024 * 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_NODES = 10000;
export type EditorSnapshot = {
  camera: {
    position: Vec3;
    target: Vec3;
    fov: number;
    near: number;
    far: number;
    view?: import("./viewport-tools").ViewName;
    height?: number;
  };
  time: number;
};
type Manifest = {
  format: "musubi-project";
  version: 1;
  scene: SceneDocument;
  editor: EditorSnapshot;
  files: Record<string, { path: string; sha256: string }>;
};
const fail = (message: string): never => {
  throw new Error(message);
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("Invalid project data.");
  return value as Record<string, unknown>;
}
function id(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(value) ||
    ["__proto__", "constructor", "prototype"].includes(value)
  )
    fail("Invalid object or asset ID.");
}
function vector(value: unknown): asserts value is Vec3 {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every((n) => typeof n === "number" && Number.isFinite(n))
  )
    fail("Invalid transform or camera values.");
}
function finite(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value))
    fail("Invalid numeric value.");
}
export function validateScene(value: unknown): SceneDocument {
  const doc = record(value);
  if (doc.joints !== undefined) validateJoints(doc.joints as import("./skeleton.ts").Joint[]);
  if (doc.format !== "musubi-scene" || doc.version !== 1)
    fail("Unsupported scene format or version.");
  if (doc.upAxis !== "Y" || doc.units !== "unitless")
    fail("Unsupported scene units or axis.");
  const nodes = record(doc.nodes),
    assets = record(doc.assets);
  for (const joint of (doc.joints ?? []) as import("./skeleton.ts").Joint[]) {
    id(joint.id);
    if (Object.hasOwn(nodes, joint.id)) fail("Joint IDs must not collide with scene node IDs.");
  }
  if (
    Object.keys(nodes).length > MAX_NODES ||
    Object.keys(assets).length > MAX_NODES
  )
    fail("Too many scene objects.");
  const parents = new Map<string, string | null>(),
    shapeCounts = new Map<string, number>();
  const siblingNames = new Set<string>();
  for (const [key, value] of Object.entries(assets)) {
    id(key);
    const asset = record(value);
    if (asset.id !== key) fail("Asset ID mismatch.");
    if (asset.kind === "procedural") {
      if (asset.generator !== "knot-v1") fail("Unsupported procedural asset.");
    } else if (asset.kind === "file") {
      if (
        typeof asset.fileName !== "string" ||
        asset.fileName.length > 255 ||
        /[\\/\x00]/.test(asset.fileName) ||
        !/\.(ply|spz|splat|ksplat|sog)$/i.test(asset.fileName)
      )
        fail("Unsupported splat filename.");
      if (
        !Number.isSafeInteger(asset.byteLength) ||
        (asset.byteLength as number) <= 0 ||
        (asset.byteLength as number) > MAX_PROJECT_BYTES
      )
        fail("Invalid asset size.");
    } else fail("Unsupported asset type.");
  }
  for (const [key, value] of Object.entries(nodes)) {
    id(key);
    const node = record(value);
    if (
      node.id !== key ||
      typeof node.name !== "string" ||
      !node.name.trim() ||
      node.name.length > 256
    )
      fail("Invalid scene node.");
    const parent = node.parentId;
    if (parent !== null) {
      id(parent);
      if (record(nodes[parent]).type !== "transform")
        fail("Missing transform parent.");
    }
    const sibling = JSON.stringify([parent, node.name]);
    if (siblingNames.has(sibling)) fail("Duplicate sibling names.");
    siblingNames.add(sibling);
    if (node.type === "transform") {
      vector(node.position);
      vector(node.rotation);
      vector(node.scale);
      if (node.rotationOrder !== "XYZ" || node.scale.some((n) => n < 0.001))
        fail("Unsupported rotation order or scale.");
      parents.set(key, parent as string | null);
    } else if (node.type === "splatShape") {
      if (node.elasticity !== undefined) {
        validateElasticity(node.elasticity);
        if (!node.binding) fail("Elasticity requires a binding.");
      }
      if (node.binding !== undefined) {
        const binding = record(node.binding);
        if (!Array.isArray(binding.jointIds) || !binding.jointIds.length || binding.jointIds.length > 256 ||
          new Set(binding.jointIds).size !== binding.jointIds.length || !Array.isArray(binding.restMatrices) ||
          binding.restMatrices.length !== binding.jointIds.length) fail("Invalid splat binding.");
        for (const jointId of binding.jointIds as unknown[]) id(jointId);
        for (const matrix of binding.restMatrices as unknown[]) {
          if (!Array.isArray(matrix) || matrix.length !== 16 || !matrix.every(n => typeof n === "number" && Number.isFinite(n))) fail("Invalid bind matrix.");
        }
      }
      if (parent === null) fail("Shape has no transform.");
      id(node.assetId);
      if (!Object.hasOwn(assets, node.assetId))
        fail("Missing asset reference.");
      vector(node.offset);
      shapeCounts.set(
        parent as string,
        (shapeCounts.get(parent as string) ?? 0) + 1,
      );
    } else fail("Unsupported node type.");
  }
  const visited = new Set<string>();
  for (const key of parents.keys()) {
    if (shapeCounts.get(key) !== 1)
      fail("Each transform must have exactly one splat shape in this version.");
    const path = new Set<string>();
    let current: string | null = key;
    while (current !== null && !visited.has(current)) {
      if (path.has(current)) fail("Scene hierarchy contains a cycle.");
      path.add(current);
      current = parents.get(current) ?? null;
    }
    path.forEach((node) => visited.add(node));
  }
  if (
    !Array.isArray(doc.rootIds) ||
    doc.rootIds.some(
      (key) =>
        typeof key !== "string" ||
        !parents.has(key) ||
        parents.get(key) !== null,
    ) ||
    new Set(doc.rootIds).size !== doc.rootIds.length ||
    doc.rootIds.length !==
      [...parents.values()].filter((p) => p === null).length
  )
    fail("Invalid scene roots.");
  if (doc.animation !== undefined) validateAnimation(doc.animation, value as SceneDocument);
  if (doc.drivenKeys !== undefined) validateDrivenKeys(doc.drivenKeys, value as SceneDocument);
  if (doc.ikHandles !== undefined) validateIKHandles(doc.ikHandles, value as SceneDocument);
  if (doc.constraints !== undefined) validateConstraints(doc.constraints, value as SceneDocument);
  return value as SceneDocument;
}
function validateEditor(value: unknown): EditorSnapshot {
  const editor = record(value),
    camera = record(editor.camera);
  vector(camera.position);
  vector(camera.target);
  finite(camera.fov);
  finite(camera.near);
  finite(camera.far);
  if(camera.view!==undefined&&!["perspective","front","back","left","right","top","bottom"].includes(camera.view as string))fail("Invalid saved camera view.");
  if(camera.height!==undefined&&(typeof camera.height!=="number"||!Number.isFinite(camera.height)||camera.height<=0))fail("Invalid orthographic height.");
  finite(editor.time);
  if (
    camera.fov < 1 ||
    camera.fov > 179 ||
    camera.near <= 0 ||
    camera.far <= camera.near ||
    Math.abs(editor.time) > 1000000 ||
    camera.position.every((n, i) => n === (camera.target as Vec3)[i])
  )
    fail("Invalid saved viewport.");
  return value as EditorSnapshot;
}
async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer,
  );
  return Array.from(new Uint8Array(hash), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}
export async function encodeProject(
  scene: SceneDocument,
  sources: ReadonlyMap<string, Blob>,
  editor: EditorSnapshot,
): Promise<Uint8Array> {
  validateScene(scene);
  validateEditor(editor);
  const entries: Record<string, Uint8Array> = Object.create(null);
  const files: Manifest["files"] = Object.create(null);
  let total = 0;
  for (const asset of Object.values(scene.assets)) {
    if (asset.kind !== "file") continue;
    const source = sources.get(asset.id);
    if (!source || source.size !== asset.byteLength)
      fail(`Missing source file: ${asset.fileName}`);
    total += source!.size;
    if (total > MAX_PROJECT_BYTES)
      fail("This version supports projects up to 512 MiB.");
    const bytes = new Uint8Array(await source!.arrayBuffer());
    const path = `assets/${asset.id}`;
    entries[path] = bytes;
    files[asset.id] = { path, sha256: await digest(bytes) };
  }
  const manifest: Manifest = {
    format: "musubi-project",
    version: 1,
    scene,
    editor,
    files,
  };
  entries["scene.json"] = strToU8(JSON.stringify(manifest));
  if (
    entries["scene.json"].length > MAX_JSON_BYTES ||
    total + entries["scene.json"].length > MAX_PROJECT_BYTES
  )
    fail("Project exceeds the supported size.");
  // Splats are frequently already compressed. STORE avoids expensive recompression.
  const output = await new Promise<Uint8Array>((resolve, reject) =>
    zip(entries, { level: 0 }, (error, data) =>
      error ? reject(error) : resolve(data),
    ),
  );
  if (output.length > MAX_PROJECT_BYTES)
    fail("This version supports projects up to 512 MiB.");
  return output;
}
export async function decodeProject(
  bytes: Uint8Array,
): Promise<{
  scene: SceneDocument;
  editor: EditorSnapshot;
  files: Map<string, File>;
}> {
  if (bytes.length > MAX_PROJECT_BYTES)
    fail("This version supports projects up to 512 MiB.");
  const sizes = new Map<string, number>();
  let total = 0;
  // Inspect every ZIP entry before allocating asset outputs. Only extract metadata here.
  const metadata = await new Promise<Record<string, Uint8Array>>(
    (resolve, reject) => {
      unzip(
        bytes,
        {
          filter(entry) {
            if (
              sizes.has(entry.name) ||
              (entry.name !== "scene.json" &&
                !/^assets\/[a-zA-Z0-9_-]{1,100}$/.test(entry.name))
            )
              fail("Invalid or duplicate archive entry.");
            sizes.set(entry.name, entry.originalSize);
            total += entry.originalSize;
            if (
              total > MAX_PROJECT_BYTES ||
              sizes.size > MAX_NODES + 1 ||
              (entry.name === "scene.json" &&
                entry.originalSize > MAX_JSON_BYTES)
            )
              fail("Project exceeds the supported size.");
            return entry.name === "scene.json";
          },
        },
        (error, data) => (error ? reject(error) : resolve(data)),
      );
    },
  );
  if (!metadata["scene.json"])
    fail("This is not an MSB scene: scene.json is missing.");
  const manifest = record(JSON.parse(strFromU8(metadata["scene.json"])));
  if (manifest.format !== "musubi-project" || manifest.version !== 1)
    fail("Unsupported MSB project version.");
  const scene = validateScene(manifest.scene),
    editor = validateEditor(manifest.editor),
    refs = record(manifest.files);
  const fileAssets = Object.values(scene.assets).filter(
    (asset) => asset.kind === "file",
  );
  if (
    Object.keys(refs).length !== fileAssets.length ||
    sizes.size !== fileAssets.length + 1
  )
    fail("Asset inventory does not match the scene.");
  for (const asset of fileAssets) {
    const ref = record(refs[asset.id]);
    if (
      ref.path !== `assets/${asset.id}` ||
      sizes.get(ref.path as string) !== asset.byteLength ||
      typeof ref.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(ref.sha256)
    )
      fail(`Missing or invalid asset: ${asset.fileName}`);
  }
  const entries = await new Promise<Record<string, Uint8Array>>(
    (resolve, reject) =>
      unzip(bytes, { filter: (e) => e.name !== "scene.json" }, (error, data) =>
        error ? reject(error) : resolve(data),
      ),
  );
  const files = new Map<string, File>();
  for (const asset of fileAssets) {
    const ref = record(refs[asset.id]),
      data = entries[ref.path as string];
    if (
      !data ||
      data.length !== asset.byteLength ||
      (await digest(data)) !== ref.sha256
    )
      fail(`Asset integrity check failed: ${asset.fileName}`);
    files.set(
      asset.id,
      new File([new Uint8Array(data).buffer], asset.fileName),
    );
  }
  return { scene, editor, files };
}
