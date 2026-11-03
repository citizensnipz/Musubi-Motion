import { expect, it, vi } from "vitest";
import { BlobReader, BlobWriter, ZipReader, ZipWriter } from "@zip.js/zip.js";
import { addSplat, emptyScene } from "../src/scene-document.ts";
import { decodeProjectBlob, encodeProjectBlob } from "../src/project-archive.ts";
import { writeScene } from "../src/scene-files.ts";

const editor = { camera: { position: [0, 0, 5] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: 45, near: .01, far: 1000 }, time: 0 };

it("round trips an actual 513 MiB file without requesting its complete arrayBuffer", async () => {
  const chunk = new Blob([new Uint8Array(1024 * 1024).fill(37)]), source = new Blob(Array(513).fill(chunk));
  const wholeRead = vi.spyOn(source, "arrayBuffer").mockRejectedValue(Error("Whole-file reads are forbidden"));
  const { document } = addSplat(emptyScene(), { id: "large", kind: "file", fileName: "large.ply", byteLength: source.size }, "Large", [0, 0, 0]);
  const packed = await encodeProjectBlob(document, new Map([["large", source]]), editor);
  expect(packed.size).toBeGreaterThan(512 * 1024 * 1024); expect(wholeRead).not.toHaveBeenCalled();
  const packedWholeRead = vi.spyOn(packed, "arrayBuffer").mockRejectedValue(Error("Whole archive reads are forbidden"));
  const opened = await decodeProjectBlob(packed), file = opened.files.get("large")!;
  expect(opened.scene).toEqual(document); expect(file.size).toBe(source.size); expect(packedWholeRead).not.toHaveBeenCalled();
  expect(Array.from(new Uint8Array(await file.slice(file.size - 8).arrayBuffer()))).toEqual(Array(8).fill(37));
}, 120000);

it("reads ZIP64 archives with the same native manifest and rejects overlapping/extra inventory", async () => {
  const packed = await encodeProjectBlob(emptyScene(), new Map(), editor), reader = new ZipReader(new BlobReader(packed), { useWebWorkers: false });
  const entries = await reader.getEntries(), metadata = await entries[0].getData!(new BlobWriter()); await reader.close();
  const writer = new ZipWriter(new BlobWriter(), { zip64: true, level: 0, useWebWorkers: false });
  await writer.add("scene.json", new BlobReader(metadata as Blob)); const zip64 = await writer.close();
  expect((await decodeProjectBlob(zip64)).scene).toEqual(emptyScene());
  const extra = new ZipWriter(new BlobWriter(), { zip64: true, level: 0, useWebWorkers: false });
  await extra.add("scene.json", new BlobReader(metadata as Blob)); await extra.add("assets/unexpected", new BlobReader(new Blob(["bad"])));
  await expect(decodeProjectBlob(await extra.close())).rejects.toThrow(/inventory/);
});

it("passes the archive Blob directly to native writes", async () => {
  const blob = new Blob(["archive"]), write = vi.fn(async (_data: Blob) => {});
  await writeScene(blob, { name: "large.msb", handle: { name: "large.msb", getFile: async () => new File([], "large.msb"), createWritable: async () => ({ write, close: async () => {}, abort: async () => {} }) } });
  expect(write).toHaveBeenCalledWith(blob);
});

it("retains the metadata limit without requiring a full archive read", async () => {
  const blob = await encodeProjectBlob(emptyScene(), new Map(), editor), data = new Uint8Array(await blob.arrayBuffer()), view = new DataView(data.buffer);
  // Declare an oversized manifest in both ZIP headers; no oversized buffer is allocated.
  view.setUint32(18, 128 * 1024 * 1024 + 1, true); view.setUint32(22, 128 * 1024 * 1024 + 1, true);
  for (let i = 0; i < data.length - 46; i++) if (view.getUint32(i, true) === 0x02014b50) {
    view.setUint32(i + 20, 128 * 1024 * 1024 + 1, true); view.setUint32(i + 24, 128 * 1024 * 1024 + 1, true); break;
  }
  await expect(decodeProjectBlob(new Blob([data]))).rejects.toThrow(/metadata/);
});
