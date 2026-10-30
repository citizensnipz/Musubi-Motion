# Non-uniform scale experiment — October 30, 2026

Tested the installed Spark 2.4.0 / Three.js 0.180.0 combination in the local preview browser.

Configuration: SparkRenderer covSplats=true and accumExtSplats=true; SplatMesh covSplats=true and extSplats=true for the procedural demo. All 11,629 splats initialized.

Result: FAIL. The demo did not render even at identity scale (1,1,1), and remained invisible at scale (1.8,0.6,1.3) with object and child rotation. Browser warning: WebGL INVALID_OPERATION: texSubImage3D: no bound PIXEL_UNPACK_BUFFER. No covariance-generator error was reported. Full gizmo handles were visible and pointer drags changed separate scale components, but this is insufficient without visible splats.

The texture warning is an observed symptom, not a proven root cause. Selection accuracy and performance under covariance rendering could not be validated. This does not establish that covariance rendering fails on all browsers or assets.

Restored the prior default rendering and uniform-only gizmo. Production build passes. No dependency upgrade or renderer patch was made. Next investigation should isolate extended-precision texture upload from covariance processing in a minimal upstream reproduction.

## Follow-up: resolved

Root cause isolated to procedural ExtSplats initialization in Spark 2.4.0: CPU arrays contained 11,629 splats, while both GPU textures still referenced empty placeholders with null image data. This also failed with extended accumulation and covariance disabled, isolating the initial failure from non-uniform transform math.

Calling the public ExtSplats.initialize({extArrays, numSplats, extra, lodSplats}) API after construction populated both texture buffers (65,536 words each) and restored rendering. The application now finalizes only nonempty extended sources with missing texture data, before attaching them to the scene. No private APIs, dependency upgrades, or vendor patches are used.

Enabled covariance rendering and extended accumulation, with extended/covariance SplatMesh inputs. Restored full scale handles and updated camera framing to use the largest absolute scale component. Positive scale minimum 0.001 avoids singular selection matrices; negative/mirrored scale is not exposed.

Browser verification:
- Demo visibly renders at identity and (1.8,0.6,1.3), including object rotation (.3,.5,.2) and child rotation .8 radians.
- Actual pointer drags on picked X, Y, and Z handles changed the corresponding independent scale components.
- Box selection selects the transformed demo.
- A generated 256-splat local file loads, visibly stretches under (1.7,.6,1.2) plus rotation, and click selection succeeds.
- No browser warnings/errors after the fix. TypeScript and production build pass.

Limitations: covariance mode remains experimental upstream. Large production captures, SH-heavy assets, other import formats, browser/device coverage, and comparative GPU memory/frame-time benchmarks have not been validated. Extended data increases per-splat storage. The earlier failure is resolved for the tested demo and fixture, not a universal compatibility guarantee.
