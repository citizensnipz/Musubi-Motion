# Polygon modeling guide

Choose the **Modeling** workspace or open **Modeling → Mesh Tools**. The panel
provides polygon primitives, component selection, transform gizmos, numeric position edits,
connected face extrusion, vertex merging, edge/face deletion, shell-normal
reversal, and basic appearance settings.

## Create and select a mesh

Expand **Create Primitive**, choose Cube, Plane, Sphere, or Cylinder, enter a Name
and Size, then click **Create mesh primitive**. Creation places the object at
the origin and selects it. The creation section starts open for an empty mesh
scene and folds when the first mesh arrives, leaving the editing tools in view.
Size is the overall width; for a sphere it is the
diameter, and for a cylinder it is both diameter and height. The plane lies in
the XZ plane. The panel accepts sizes from 0.000001 to 1,000,000 scene units.

Each mesh has a normal scene transform and an editable polygon shape. Adjacent
faces share vertices. Cube faces are quads; the plane is one quad; the cylinder
has quad sides and polygon caps; the sphere uses triangles. Vertices and faces
have stable IDs, and edges are identified by their endpoint IDs. Display labels
such as “Vertex 1” are conveniences, not persistent array-index selections.

Choose a **Mesh object** in the panel or select one in the Outliner. In
**Components → Mode**, choose Object, Vertex, Edge, or Face. Object mode uses
the normal object selection and transform gizmos. Component modes select parts
of the current mesh and highlight them in the viewport.

| Gesture | Component selection |
| --- | --- |
| Vertex click | Nearest projected vertex within eight CSS pixels |
| Edge click | Nearest projected edge segment within eight CSS pixels |
| Face click | Nearest actual triangle hit on the selected mesh, mapped back to its authored polygon face |
| Drag a box | X-ray selection of vertex positions, edge midpoints, or face centers inside the box |
| Shift + click/drag | Add to the existing selection |
| Ctrl/Cmd + click/drag | Subtract from the existing selection |

Vertex/edge clicks and boxes do not perform scene occlusion tests. Face clicks
intersect the selected mesh, so a different object in front does not act as a
selection blocker. Face box centers are the average of their vertex positions;
a box does not select a face merely because it intersects part of its surface.
Selections are limited to 20,000 components; an oversized selection or addition
leaves the previous set unchanged. View or scene changes cancel an unfinished
selection gesture. Outside a numeric field, **Escape** cancels an active component
gizmo drag while keeping the selection. Press it again, or press it while no
gizmo drag is active, to return to Object mode and clear component selection.

The **Component** menu provides an alternative to viewport picking. Choose an
entry and click **Select component** to replace the selection or **Add component**
to extend it. **Clear component selection** keeps the current mode with an empty
selection. Expand **Component IDs** to view the exact current IDs. The menu shows
at most 5,000 entries; viewport picking can select components beyond that menu.
Selection is temporary editor state, not saved scene data. Edits and undo keep
the current mode and prune IDs that no longer exist; they do not restore an old
component selection. Opening a scene resets this state explicitly.

## Move components

Select vertices, edges, or faces, then press **W** for Move, **E** for Rotate,
or **R** for Scale. The component gizmo uses world-aligned axes and the center of
the selected unique vertices. Edges and faces expand to their shared vertices,
so each selected vertex participates only once. Rotation and scaling operate
around this common center.

Dragging previews the changed mesh without modifying the saved document. Release
to commit the whole gesture as one undo step. **Escape** during the drag restores
the starting geometry and retains component mode and selection; Escape again
exits to Object mode. Panel editing controls disable during the drag, while the
active component mode stays in place. Invalid geometry is rejected by the shared
validation when committed. Previews reuse the starting triangulation; release
validates and triangulates the edited polygons again. A temporarily folded or
collapsed face can therefore appear during a drag, but an invalid final edit
restores the starting mesh and leaves undo history unchanged. Rotation and scale
work through nonuniformly scaled or sheared parents by converting the world-space
gesture back into mesh-local vertex positions.

Select exactly one vertex to reveal **Single vertex · absolute local position**.
Edit its X, Y, or Z coordinate to set that vertex's mesh-local position.

For any nonempty Vertex, Edge, or Face selection, expand **Local component
offset**, enter the offset, and click **Apply offset**. An edge or face selection expands to
its unique vertices, so shared vertices move once. Offsets use mesh-local axes;
the object's rotation and scale still affect the resulting world-space motion.
The offset remains available for another application.

Numeric edits commit on **Enter** or blur. **Escape** cancels the pending field
edit. Positions must be finite and within ±1,000,000 on each local axis. Invalid
geometry rejects the whole command without leaving a partial move. Numeric edits
use local coordinates; the component gizmo uses world-aligned axes. Return to
Object mode for the normal whole-object gizmo. Component animation, customized
pivots, snapping, and soft selection are not implemented.

## Extrude and delete faces

In Face mode, select one edge-connected region, enter **Extrude distance · local
units**, and click **Extrude selected faces**. The command translates the region
along its area-weighted average local normal. Shared top vertices remain shared,
and only the region boundary creates side walls. The new top faces are selected
after the edit. Distance may be positive or negative, must be nonzero, and must
lie within ±1,000,000.

Separate disconnected regions require separate commands. A closed whole-mesh
selection has no boundary to extrude and is rejected. A region whose face normals
cancel has no stable average direction and is also rejected. This is a grouped
region extrusion, without individual-face extrusion, inset, taper, divisions,
or an editable construction-history node. It follows the boundary-wall concept
described by Autodesk's [Extrude workflow](https://help.autodesk.com/cloudhelp/2024/ENU/Maya-Modeling/files/GUID-20202ED3-5EC7-420E-860E-EC29D101A7A8.htm)
and [Keep Faces Together](https://help.autodesk.com/cloudhelp/2023/ENU/Maya-Modeling/files/GUID-2D20D2B8-4B0D-465C-A244-67A9BC608663.htm).

**Delete selected faces** removes those faces and prunes vertices no remaining
face uses. It can leave an open boundary or an empty mesh. A result that violates
the topology rules below is rejected. Each successful position, extrusion, or
deletion command is one undo step.

## Merge to center

In Vertex, Edge, or Face mode, select components and choose **Edit Topology →
Merge to center**. Their unique vertices are welded into one vertex at their
average position. The first selected vertex in the mesh's authored order supplies
the surviving ID; it becomes the selected vertex. This changes shared topology,
not just overlapping positions. It follows Autodesk's
[Merge to Center workflow](https://help.autodesk.com/cloudhelp/2022/ENU/Maya-Modeling/files/GUID-2DF066DD-4C1C-462E-9F8C-FA52FA9D9B16.htm).

Faces reduced below three corners are removed. Unrelated vertices and surviving
face IDs remain intact. A pinched face, duplicate face, disconnected face fan, or
other invalid result rejects the entire edit. Merging a cube's top face makes a
pyramid; merging diagonal corners of a quad is rejected. Merging an entire plane
can leave one isolated editable vertex. Merge by proximity threshold and target
welding are not implemented.

## Delete edges

In Edge mode, select interior edges and choose **Edit Topology → Delete selected
edges**, or press **Delete** / **Backspace**. The surrounding faces become one
n-gon per connected region, retaining the first face's authored ID. The resulting
faces are selected. As in Autodesk's
[Delete Edge workflow](https://help.autodesk.com/cloudhelp/2027/ENU/Maya-Modeling/files/GUID-689C75D9-88C8-4F55-91B9-02E5C60DF6AC.htm),
the endpoint vertices remain; this includes interior vertices that no longer
belong to a face. Delete Edge/Vertex cleanup is not implemented.

Border edges require deleting their adjacent faces. Regions with holes, repeated
boundary vertices, no boundary, duplicate result faces, or more than 64 corners
are rejected. Select all
interior edges of each intended merged region; the command will not silently
remove additional unselected edges. Disconnected regions can be processed in one
undo step. Nonplanar result faces are triangulated again and can change the
surface between their corners. In Face mode, Delete / Backspace removes selected faces instead.
Held-key repeats and Ctrl/Cmd-modified deletion do not delete the newly selected
result or the whole object. Text fields retain their normal editing shortcuts.

## Appearance and scene integration

**Appearance** provides Color, Flat/Smooth Shading, and Wireframe. Smooth shading
changes computed normals, not topology; it is not subdivision. Wireframe draws
authored polygon edges without displaying the internal rendering triangulation.

**Reverse all normals** reverses face winding across the mesh. In Face mode,
**Reverse selected shell normals** expands the selected faces to their complete
edge-connected shells, preserving consistent winding along shared edges. The
original face selection stays selected. This follows Autodesk's
[all-faces-in-shell option](https://help.autodesk.com/cloudhelp/2022/ENU/Maya-Modeling/files/GUID-CFAA1589-3ACA-4140-8FB7-641B74587156.htm).
Vertices and face IDs stay unchanged; computed vertex normals are regenerated.
Double-sided shading may look unchanged after reversal. Custom/locked normals
and hard-edge smoothing groups are not implemented.

Meshes use the shared transform, hierarchy, animation, Set Driven Key, and
constraint systems. Their shape positions and topology are static document data;
per-vertex animation is not implemented. Geometry and appearance edits support
undo/redo and save inside `.msb` scenes without a separate mesh asset. Existing
splat binding and skin-weight tools remain specific to splats; meshes cannot yet
be bound to joints or use splat elasticity.

## Topology limits and remaining work

A mesh supports at most 100,000 vertices and 100,000 faces. Each face references
3–64 distinct existing vertices. Validation requires consistent face winding,
at most two faces per edge, and connected incident face fans around each vertex.
Nonmanifold edges or vertices are rejected.

Nonplanar polygons are allowed when a supported projection remains simple and
can be triangulated without degenerate or folded triangles. The original
dominant-axis projection is retained when valid; an orthonormal frame around the
area-weighted normal is tried if needed, allowing bent n-gons such as two joined
cube faces. Faces that self-cross in both projections, collapse to zero area, or contain unsupported
degeneracy are rejected. Rendering triangulates polygons while retaining their
authored IDs and shared topology. Validation is not a general solid-intersection
test: intersections between separate faces are not automatically repaired, and
there is no automatic self-collision cleanup.

Bevel, inset, subdivision, UV editing, material assignment beyond a single shape
color, mesh import/export, mesh skinning, topology construction history,
component animation, pivot customization, snapping, and soft selection remain
future work. This slice supplies direct polygon edits,
not the complete Maya modeling toolset. See [VALIDATION.md](VALIDATION.md) for
the separate verification record.

## Dependencies and licenses

Open [examples/modeling-study.msb](../examples/modeling-study.msb) for an extruded,
animated cube, a smooth sphere, a ground plane, a curve controller, and a procedural
splat reference in one scene. Rebuild it with
`node scripts/create-modeling-example.mjs`.

Open [examples/mesh-topology-study.msb](../examples/mesh-topology-study.msb) to
compare an original cube, a cube with one dissolved edge and reversed normals,
and a pyramid made by merging the top face. Rebuild it with
`node scripts/create-mesh-topology-example.mjs`.

Primitive generation, vertex welding, rendering, and triangulation reuse the
existing Three.js 0.180 dependency under its [MIT license](https://github.com/mrdoob/three.js/blob/r180/LICENSE).
Three's polygon triangulation uses bundled Earcut 3.0.1; the projection validation
also adapts its segment-intersection predicate with the Mapbox copyright and
[ISC license](https://raw.githubusercontent.com/mapbox/earcut/v3.0.1/LICENSE)
retained in the source and [the distributed notice](../public/licenses/earcut.txt).
No new packages or paid services were added. The workflow
references Autodesk documentation without copying its implementation, branding,
or artwork.
