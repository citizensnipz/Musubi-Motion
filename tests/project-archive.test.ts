import { describe, it, expect, vi, afterEach } from "vitest";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { addSplat, emptyScene } from "../src/scene-document.ts";
import {
  encodeProject,
  decodeProject,
  validateScene,
} from "../src/project-archive.ts";
import { msbName, saveDestination, writeScene } from "../src/scene-files.ts";
const editor = {
  camera: {
    position: [3, 2, 8] as [number, number, number],
    target: [0, 0, 0] as [number, number, number],
    fov: 42,
    near: 0.01,
    far: 1000,
  },
  time: 4.5,
};
function fixture() {
  const file = new File([new Uint8Array([1, 2, 3, 4])], "capture.splat");
  const first = addSplat(
    emptyScene(),
    {
      id: "asset-one",
      kind: "file",
      fileName: file.name,
      byteLength: file.size,
    },
    "Hero",
    [-1, 2, 3],
  );
  const second = addSplat(
    first.document,
    { id: "asset-two", kind: "procedural", generator: "knot-v1" },
    "Demo",
    [0, 0, 0],
  );
  const node = second.document.nodes[first.id];
  if (node.type === "transform") {
    node.position = [4, 5, 6];
    node.rotation = [20, 30, 40];
    node.scale = [1.8, 0.6, 1.3];
  }
  return {
    scene: second.document,
    files: new Map([["asset-one", file]]),
    first: first.id,
  };
}
async function altered(change: (data: Record<string, Uint8Array>) => void) {
  const { scene, files } = fixture(),
    entries = unzipSync(await encodeProject(scene, files, editor));
  change(entries);
  return zipSync(entries);
}
function changeManifest(
  entries: Record<string, Uint8Array>,
  change: (manifest: any) => void,
) {
  const manifest = JSON.parse(strFromU8(entries["scene.json"]));
  change(manifest);
  entries["scene.json"] = strToU8(JSON.stringify(manifest));
}
describe("portable MSB archives", () => {
  it("round trips all IDs, shape offsets, transforms, editor state and original bytes", async () => {
    const { scene, files } = fixture();
    const packed = await encodeProject(scene, files, editor);
    const opened = await decodeProject(packed);
    expect(opened.scene).toEqual(scene);
    expect(opened.editor).toEqual(editor);
    expect(opened.files.get("asset-one")!.name).toBe("capture.splat");
    expect(
      new Uint8Array(await opened.files.get("asset-one")!.arrayBuffer()),
    ).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(Object.keys(unzipSync(packed)).sort()).toEqual([
      "assets/asset-one",
      "scene.json",
    ]);
  });
  it("supports empty scenes and refuses saves with missing source files", async () => {
    expect(
      (
        await decodeProject(
          await encodeProject(emptyScene(), new Map(), editor),
        )
      ).scene,
    ).toEqual(emptyScene());
    await expect(
      encodeProject(fixture().scene, new Map(), editor),
    ).rejects.toThrow("Missing source");
  });
  it("rejects corrupt, incomplete, unsupported, and unexpected archive contents", async () => {
    await expect(decodeProject(new Uint8Array([1, 2, 3]))).rejects.toThrow();
    await expect(
      decodeProject(await altered((e) => delete e["assets/asset-one"])),
    ).rejects.toThrow();
    await expect(
      decodeProject(
        await altered((e) => {
          e["assets/asset-one"][0] ^= 1;
        }),
      ),
    ).rejects.toThrow("integrity");
    await expect(
      decodeProject(
        await altered((e) => changeManifest(e, (m) => (m.version = 999))),
      ),
    ).rejects.toThrow("version");
    await expect(
      decodeProject(
        await altered((e) => {
          e["../outside"] = strToU8("bad");
        }),
      ),
    ).rejects.toThrow("archive entry");
    await expect(
      decodeProject(
        await altered((e) =>
          changeManifest(
            e,
            (m) => (m.scene.assets["asset-two"].generator = "unknown"),
          ),
        ),
      ),
    ).rejects.toThrow("procedural");
  });
  it("rejects broken references, cycles, sibling names, roots and invalid transforms", () => {
    const mutate = (fn: (doc: any) => void) => {
      const f = fixture();
      fn(f.scene);
      return () => validateScene(f.scene);
    };
    expect(mutate((doc) => doc.rootIds.push("missing"))).toThrow("roots");
    expect(
      mutate((doc) => {
        const n = Object.values(doc.nodes).filter(
          (n: any) => n.type === "transform",
        ) as any[];
        n[0].parentId = n[1].id;
        n[1].parentId = n[0].id;
        doc.rootIds = [];
      }),
    ).toThrow("cycle");
    expect(
      mutate((doc) => {
        const n = Object.values(doc.nodes).filter(
          (n: any) => n.type === "transform",
        ) as any[];
        n[1].name = n[0].name;
      }),
    ).toThrow("sibling");
    expect(
      mutate((doc) => {
        const n = Object.values(doc.nodes).find(
          (n: any) => n.type === "transform",
        ) as any;
        n.scale[0] = 0;
      }),
    ).toThrow("scale");
    expect(
      mutate((doc) => {
        const n = Object.values(doc.nodes).find(
          (n: any) => n.type === "transform",
        ) as any;
        n.rotation[0] = Infinity;
      }),
    ).toThrow("values");
    expect(
      mutate((doc) => {
        const n = Object.values(doc.nodes).find(
          (n: any) => n.type === "splatShape",
        ) as any;
        n.assetId = "absent";
      }),
    ).toThrow("asset");
  });
});
describe("file destination behavior", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("uses .msb and lets fallback Save As cancel", async () => {
    expect(msbName("shot")).toBe("shot.msb");
    expect(msbName("shot.MSB")).toBe("shot.MSB");
    vi.stubGlobal("window", { prompt: () => null });
    expect(await saveDestination("Untitled")).toBeNull();
  });
  it("uses the asynchronous UI filename dialog for download fallback", async () => {
    vi.stubGlobal("window", {});
    const requestName = vi.fn(async () => "take-02");
    expect(await saveDestination("shot", undefined, requestName)).toEqual({
      name: "take-02.msb",
    });
    expect(requestName).toHaveBeenCalledWith("shot.msb");
    expect(
      await saveDestination("shot", undefined, async () => null),
    ).toBeNull();
  });
  it("reuses a native handle for Save and closes writes before reporting completion", async () => {
    const events: string[] = [];
    const handle = {
      name: "shot.msb",
      getFile: async () => new File([], "shot.msb"),
      createWritable: async () => ({
        write: async () => {
          events.push("write");
        },
        close: async () => {
          events.push("close");
        },
        abort: async () => {
          events.push("abort");
        },
      }),
    };
    expect((await saveDestination("other", handle))!.handle).toBe(handle);
    await writeScene(new Uint8Array([1]), { name: handle.name, handle });
    expect(events).toEqual(["write", "close"]);
  });
  it("aborts a failed native write and propagates the error", async () => {
    const abort = vi.fn(async () => {});
    const handle = {
      name: "shot.msb",
      getFile: async () => new File([], "shot.msb"),
      createWritable: async () => ({
        write: async () => {
          throw Error("Disk full");
        },
        close: async () => {},
        abort,
      }),
    };
    await expect(
      writeScene(new Uint8Array([1]), { name: handle.name, handle }),
    ).rejects.toThrow("Disk full");
    expect(abort).toHaveBeenCalledOnce();
  });
});
