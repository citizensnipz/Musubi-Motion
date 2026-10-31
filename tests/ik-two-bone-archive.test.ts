import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { emptyScene, type Vec3 } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";
import { createIKHandle, evaluateIK, jointWorldMatrices } from "../src/ik.ts";
import { evaluateSceneAnimation } from "../src/animation.ts";
import { decodeProject, encodeProject } from "../src/project-archive.ts";

describe("two-bone project archives", () => {
  it("roundtrips pole settings and solved poses, and rejects malformed solver data before opening", async () => {
    const doc = emptyScene();
    doc.joints = [
      { id: "root", name: "Root", parentId: null, position: [2, 1, 0], rotation: [10, 30, 40] },
      { id: "mid", name: "Middle", parentId: "root", position: [0, 1, 0] },
      { id: "end", name: "End", parentId: "mid", position: [0, 1, 0] },
    ];
    const store = createSceneStore(doc);
    createIKHandle(store, "root", "end", [3, 2, 0], { solver: "two-bone", poleTarget: [2, 3, 2] });
    const saved = store.getState().document;
    const bytes = await encodeProject(saved, new Map(), { camera: {
      position: [3, 2, 8] as Vec3, target: [0, 0, 0] as Vec3, fov: 42, near: .01, far: 1000,
    }, time: 0 });
    const opened = await decodeProject(bytes);
    expect(opened.scene.ikHandles).toEqual(saved.ikHandles);
    const before = evaluateSceneAnimation(saved, 0), after = evaluateSceneAnimation(opened.scene, 0);
    evaluateIK(saved, before); evaluateIK(opened.scene, after);
    expect([...jointWorldMatrices(opened.scene, after)]).toEqual([...jointWorldMatrices(saved, before)]);
    for (const patch of [{ solver: "unknown" }, { poleTarget: null }, { poleTarget: [0, 0] }, { endId: "mid" }]) {
      const files = unzipSync(bytes), data = JSON.parse(strFromU8(files["scene.json"]));
      Object.assign(data.scene.ikHandles[0], patch);
      files["scene.json"] = strToU8(JSON.stringify(data));
      await expect(decodeProject(zipSync(files))).rejects.toThrow(/IK|pole|bone|solver/i);
    }
  });
});
