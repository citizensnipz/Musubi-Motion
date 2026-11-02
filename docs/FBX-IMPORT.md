# FBX import

Choose **File → Import…** and select an `.fbx` file. If its textures are external, select the image files together with it in the same picker (PNG, JPEG, WebP, GIF, or BMP). Embedded images need no extra selection. Missing or ambiguous image names produce an import warning. Import adds to the current scene in one undoable operation. Files are parsed locally, not uploaded. Native meshes, skeletons, skin weights, and timeline animation are saved inside `.msb`; the original FBX is not needed when reopening.

## Supported

- Binary FBX 6400+ and ASCII FBX 7000+ through Three.js FBXLoader.
- Polygon meshes with material slots, per-face assignments, UV sets 0–3, and named joints with parent–child skeleton hierarchy.
- Base color, emissive, roughness, metalness, opacity, transparency, double-sided settings, and diffuse/emissive/normal/roughness/metalness/alpha textures. Texture wrapping and transforms are retained. FBX Phong shininess is approximated as Standard material roughness. Images are embedded in the project; remote texture URLs are never fetched.
- Relative and absolute position blend shapes and sampled blend-shape animation, combined with skinning. Select a mesh and use **Properties → Blend shapes** to adjust weights or key them. Editing an animated weight keys at the current frame; edits support undo.
- Mesh skinning with up to four influences per vertex. Imported meshes deform when their joints move, including during animation and IK evaluation.
- Object and joint animation sampled at the scene's FPS (24 by default), converted to XYZ Euler tracks for the Graph Editor and Dope Sheet. Quaternion rotations are unwrapped before reduction. Linear key reduction preserves each sampled channel within 0.05 degrees for rotation and 0.0001 units for translation/scale. Subframe motion can differ from the original FBX curves.
- All nonempty animation clips, placed consecutively; if the scene already has animation, new clips start after its end frame. Clip names and frame ranges are reported in the Terminal. Clips are timeline ranges, not separate switchable actions.
- Skeleton-only FBX files, repeated imports with unique IDs/names, and `.msb` round trips.

Export using **Y-up** and bake procedural animation/constraints in the source application. Import retains the loader's numeric coordinates; it does not automatically convert centimeters to meters. Non-joint groups are flattened into mesh world transforms and nearest-parent joint transforms, preserving their sampled motion.

## Current limits

- Lights, cameras, and source rig controls/constraints are not imported. Procedural shaders, layered textures, displacement, FBX progressive/in-between morph targets, and animated material properties are not reproduced. Raster textures use the formats listed above; unsupported formats report an error.
- Constant uniform bone scale is baked into positions and bind data. Animated joint scale, nonuniform joint scale, reflected transforms, and shear are rejected with an error rather than silently changing the rig.
- Mesh topology edits that add/remove vertices are blocked for skinned meshes because they would invalidate the weights. Weight-painting tools currently target splats, not imported polygon skins. Deleting a joint used by a polygon skin removes that mesh's binding and restores its rest geometry; undo restores the binding.
- Imported seams are welded only when position, skin weights, UVs, normals, and blend-shape deltas match. Disconnected fans/overlapping edges are separated to meet native mesh topology rules. Imported source normals preserve hard splits; deformed normals are regenerated and smoothed across matching UV seam vertices.
- Maximum input: 128 MiB; 16 MiB per image and 64 million decoded pixels; 128 blend shapes per mesh; 100,000 vertices and faces per mesh; 1,000 joints per scene; 100,000 animation keys across the scene after reduction. Extremely long animations are rejected before sampling more than two million channel values. Export shorter clips or lower the scene FPS if necessary.

Parsing/conversion failures leave the existing document unchanged. No FBX export is provided.

FBX material decoding follows Three.js FBXLoader, which primarily supplies Phong/Lambert materials. Exporter-specific PBR roughness/metalness maps and UV-set routing may not be exposed by that loader; native Standard materials retain those values/maps when supplied. A texture referencing a missing UV set is omitted with a warning. Shared image data is currently repeated in serialized material slots, so highly textured scenes can reach the existing 128 MiB project-JSON limit.

You can also drop one FBX (optionally with its texture images) onto the viewport. Dropping an MSB opens that project, using the existing unsaved-changes prompt before replacing the scene. Drop one model/project at a time.

For exporters that pair an opacity texture with a zero opacity scalar, import normalizes the scalar to keep the texture-driven surface visible and reports a warning. Zero opacity without an opacity-map reference remains unchanged. Truncated embedded PNGs are omitted with a warning; selecting complete images with matching texture names overrides embedded copies.
