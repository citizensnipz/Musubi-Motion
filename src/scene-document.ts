export type Vec3 = [number, number, number];
export type TransformChannels = {
  position: Vec3;
  rotation: Vec3; // Euler degrees; XYZ order, local to parent.
  scale: Vec3;
};
export type TransformNode = TransformChannels & {
  id: string;
  type: "transform";
  name: string;
  parentId: string | null;
  rotationOrder: "XYZ";
};
export type SplatShapeNode = {
  elasticity?: import("./elasticity").Elasticity;
  binding?: { jointIds: string[]; restMatrices: number[][] };
  id: string;
  type: "splatShape";
  name: string;
  parentId: string;
  assetId: string;
  offset: Vec3;
};
export type AssetRecord = { id: string } & (
  | { kind: "procedural"; generator: "knot-v1" }
  | { kind: "file"; fileName: string; byteLength: number }
);
export type SceneDocument = {
  joints?: import("./skeleton.ts").Joint[];
  format: "musubi-scene";
  version: 1;
  upAxis: "Y";
  units: "unitless";
  rootIds: string[];
  nodes: Record<string, TransformNode | SplatShapeNode>;
  assets: Record<string, AssetRecord>;
};

export function emptyScene(): SceneDocument {
  return {
    format: "musubi-scene",
    version: 1,
    upAxis: "Y",
    units: "unitless",
    rootIds: [],
    nodes: {},
    assets: {},
  };
}

export function transformNodes(doc: SceneDocument): TransformNode[] {
  return Object.values(doc.nodes).filter(
    (node): node is TransformNode => node.type === "transform",
  );
}

export function uniqueName(
  doc: SceneDocument,
  requested: string,
  parentId: string | null = null,
  exceptId?: string,
): string {
  const base = requested.trim().replace(/[|:]/g, "_").slice(0, 80) || "splat";
  const names = new Set(
    Object.values(doc.nodes)
      .filter((n) => n.parentId === parentId && n.id !== exceptId)
      .map((n) => n.name),
  );
  let name = base,
    suffix = 1;
  while (names.has(name)) name = `${base}${suffix++}`;
  return name;
}

export function normalizedChannels(
  channels: TransformChannels,
): TransformChannels {
  for (const values of [channels.position, channels.rotation, channels.scale]) {
    if (values.length !== 3 || !values.every(Number.isFinite))
      throw new Error("Transform values must be finite numbers.");
  }
  return {
    position: [...channels.position],
    rotation: [...channels.rotation],
    scale: channels.scale.map((value) => Math.max(0.001, value)) as Vec3,
  };
}

export function addSplat(
  doc: SceneDocument,
  asset: AssetRecord,
  requestedName: string,
  offset: Vec3,
  id = crypto.randomUUID(),
  shapeId = crypto.randomUUID(),
): { document: SceneDocument; id: string } {
  const name = uniqueName(doc, requestedName);
  const node: TransformNode = {
    id,
    type: "transform",
    name,
    parentId: null,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    rotationOrder: "XYZ",
  };
  const shape: SplatShapeNode = {
    id: shapeId,
    type: "splatShape",
    name: `${name}Shape`,
    parentId: id,
    assetId: asset.id,
    offset: [...offset],
  };
  return {
    id,
    document: {
      ...doc,
      rootIds: [...doc.rootIds, id],
      nodes: { ...doc.nodes, [id]: node, [shapeId]: shape },
      assets: { ...doc.assets, [asset.id]: asset },
    },
  };
}

// Scene metadata is renderer-independent. Asset bytes are intentionally external.
export function deleteSceneItems(doc: SceneDocument, ids: Iterable<string>): SceneDocument {
  const removed = new Set(ids);
  const all = [...Object.values(doc.nodes), ...(doc.joints ?? [])];
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of all) if (node.parentId && removed.has(node.parentId) && !removed.has(node.id)) {
      removed.add(node.id); changed = true;
    }
  }
  const nodes = Object.fromEntries(Object.entries(doc.nodes).filter(([id]) => !removed.has(id)));
  const retainedAssets = new Set(Object.values(nodes).filter(n => n.type === "splatShape").map(n => n.assetId));
  return { ...doc, nodes, rootIds: doc.rootIds.filter(id => !removed.has(id)),
    assets: Object.fromEntries(Object.entries(doc.assets).filter(([id]) => retainedAssets.has(id))),
    ...(doc.joints ? { joints: doc.joints.filter(j => !removed.has(j.id)) } : {}),
  };
}

export function serializeScene(doc: SceneDocument): string {
  return JSON.stringify(doc, null, 2);
}
