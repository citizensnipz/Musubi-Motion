# Procedural textures

Open **View → Texture Graph** to dock the work area, Output Preview and node properties together. Choose **New Graph** for an Output node, or **Create Animated Example** for a wired noise-and-ramp study. The preview shows the graph on a plane. Graph output is available in this panel and in the saved project.

To try a graph with an embedded image, open [animated-noise-ramp.msb](../examples/textures/animated-noise-ramp.msb) and show Texture Graph. Scrub the timeline or edit **Current frame**. Noise multiplies the horizontal gradient, and Texture Sample supplies alpha from the original Musubi checker. Save and reopen the project to keep the graph, layout and image together offline. The example can be regenerated with `node scripts/generate-procedural-example.mjs`.

## Author a graph

1. Choose **Add Node…** or focus the empty work area and press **Tab**. Search by name or select a node from the list.
2. Drag an output socket on the right to an input socket on the left. You can also click the two sockets, or focus each socket and press **Enter**. The label shows its type, for example **Position (vec3)**. Compatible destinations highlight during the gesture. Dropping on an incompatible socket explains the mismatch below the canvas. An input accepts one connection, and a valid replacement is one undo step. **Escape** cancels.
3. Drag an existing wire from either end to reconnect it. A cancelled or invalid drop keeps the original wire. To disconnect, select a wire and press **Delete** or **Backspace**. The same keys delete a selected node and its connections. The toolbar also offers **Delete Selected**.
4. Select a node header for its properties. Drag the header to move the node. Drag the canvas background to pan, scroll to zoom, or choose **Fit View** to frame the whole graph.
5. Type into numeric fields and press **Enter** or leave the field to commit. Middle-drag the field or its label for a live preview. Release to commit one change or press **Escape** to restore its original value. Right-click a numeric field for **Lock** or **Unlock**. Use the editor's Undo and Redo commands for graph changes.

The canvas uses React Flow. Left-to-right ports, drag or click connections, and dimmed incompatible inputs follow [Maya’s Node Editor](https://help.autodesk.com/cloudhelp/2027/ENU/Maya-Basics/files/GUID-C6E5588F-40A4-4B1E-9C02-A29DA9A4650F.htm).

Texture Sample uses a reusable PNG, JPEG or WebP from **View → Texture Assets**. Choose the image in the node's **Image asset** property. Texture Assets lists graph references, protects their images from deletion, and updates graph and material references together when you relink or replace an image.

## Ports and values

| Node | Inputs and behavior | Outputs |
| --- | --- | --- |
| UV | Normalized plane coordinates. The origin is lower left. | UV vector |
| Position | The preview plane supplies `(U, V, 0)`. | XYZ vector |
| Time | Requested animation frame divided by project FPS. Turntable preview uses the animation start frame. | Scalar seconds |
| Noise | Seeded 3D value noise. A UV input supplies Z = 0. Position defaults to the preview plane. Time defaults to zero. Speed multiplies seconds and offsets the Z sample. | Scalar 0–1 |
| Gradient / Ramp | Linear interpolation between two RGB endpoints. Factor clamps to 0–1 and defaults to U. | Linear RGB color |
| Texture Sample | Nearest sampling with clamped UV. Unconnected UV uses the plane. With no image, the sample is black and opaque. | RGB color and separate scalar alpha |
| Add / Multiply | Select Scalar, UV vector, XYZ vector or RGB color. Arithmetic is componentwise and clamps results to ±1,000,000. | Selected type |
| Clamp | Componentwise clamp. The lower and upper bounds are the smaller and larger of the two scalar inputs. | Selected type |
| Output | Color or a scalar grayscale value, with separate opacity. Output clamps and display-encodes RGB. Alpha clamps to 0–1. | Planar preview |

A scalar can broadcast to the components of an arithmetic input. A scalar on Output Color becomes grayscale. Noise accepts UV or XYZ as its position. Other connections require matching types. A texture marked **Color (sRGB)** is decoded to linear RGB before arithmetic. A **Data (Raw)** texture keeps its decoded channel values without the sRGB transfer. Both modes keep alpha linear. The preview displays linear RGB through the sRGB transfer, so raw data is displayed as intensity.

## Preview limits

The graph supports one Output, 48 nodes, 96 connections, and four referenced images totaling up to 8,388,608 pixels. The fixed preview is 256 × 256. Work upstream of Output is evaluated. Frame and FPS determine animated output, so returning to the same frame reproduces the same preview. CPU reference samples and GPU preview values should agree within three levels on the 8-bit display for opaque pixels away from texture sampling boundaries. Canvas compositing can round RGB further at low alpha. A shader or device failure leaves the last successful preview visible while the graph remains editable.
