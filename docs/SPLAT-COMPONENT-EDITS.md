# Hide, delete, and restore individual splats

Select one splat object and press **F8** or choose **Select → Splat Components**.
Click a splat or select a region, then use the Splat Components panel, menu, or shortcut:

| Operation | Menu | Shortcut |
| --- | --- | --- |
| Hide selected splats | Display → Hide Selected Splats | H |
| Show hidden splats on the active object | Display → Show Hidden Splats | Shift+H |
| Delete selected splats | Edit → Delete Selected Splats | Delete or Backspace |
| Restore deleted splats on the active object | Edit → Restore Deleted Splats | — |

Hidden and deleted are separate states. Show only reveals hidden splats; Restore
only brings back deleted splats. Each completed command is one undo step. Undo
and redo restore the authored edits; component selection is transient. A command
with no eligible splats leaves history unchanged. Fully removed objects can
still be selected in the Outliner for restoration. Exiting component mode
returns the usual object-level commands.

The panel shows how many original splats are active, hidden, and deleted. A
transparent original can still be active in the edit data and unavailable for
selection under the existing opacity threshold. Hidden/deleted originals are
skipped by component selection, object picking, and framing. Edited unbound
objects use a two-sigma ellipsoid for object ray picking, matching the existing
posed CPU picking convention; component clicks still use projected centers.
Elastic fill and stretch are evaluated only from eligible original endpoints.

The editable scene [splat-edit-regions.msb](../examples/splat-edit-regions.msb)
contains two instances of one original asset. Select **Edited Regions** in the
Outliner to show its hidden red region or restore its deleted blue region. The
upper **Original Instance** remains unchanged. Regenerate the fixture with
`node scripts/generate-splat-edit-fixture.mjs`. It uses the repository's
original procedural selection fixture and requires no external source data.

Edit data belongs to a shape instance and stores versioned ranges of stable
original indices. A contiguous deletion uses two numbers regardless of its
size. The total is capped at 16,384 disjoint ranges per shape across hide and
delete, and a command that exceeds the limit leaves the previous scene intact.
The selection limit remains 1,000,000 IDs per action. Editing supports up to
134,217,728 originals per shape. The transient GPU mask uses one bit per source
index plus texture row padding; edits use the original order and suspend
automatic LoD for that shape until all edits are cleared. Consequently masking
is not a means of compacting the source or accelerating the renderer's source
iteration. Original asset bytes, binding IDs/weights, and spherical harmonics
are unchanged in the archive.

The placement and keys follow [Maya 2026 component visibility](https://help.autodesk.com/cloudhelp/2026/ENU/Maya-Basics/files/GUID-EBB179AA-9F3A-4386-8D25-B22881E27CD0.htm)
and the [Maya component delete shortcut](https://help.autodesk.com/cloudhelp/2023/ENU/Maya-Modeling/files/GUID-70583D4F-EAB5-440D-B72D-C87D295FFB7D.htm).
H avoids the browser history shortcut Ctrl+H. Native inputs keep their text keys;
component mode uses no transform gizmo, numeric values, or new icon artwork.
Explicit restoration is available because Musubi's component delete is a
reversible authored edit on the current instance.
