import type { CubeSplatSettings } from "./cube-to-splats";
import { defaultCubeSplatSettings } from "./cube-to-splats";

export function createCubeSplatDialog(convert: (settings: CubeSplatSettings, moveAside: boolean, budget: number) => Promise<string>) {
  const dialog = document.createElement("wa-dialog"); dialog.label = "Convert to splats"; dialog.id = "cube-splat-dialog";
  dialog.innerHTML = `<div class="cube-splat-settings">
    <p>Select one cube or mesh part. Creates a separate splat object. Rigged parts share the original skeleton and stay in place. Hide the source in the Outliner to compare.</p>
    <label>Samples per face<select aria-label="Samples per face"><option value="16">16 × 16</option><option value="32" selected>32 × 32</option><option value="64">64 × 64</option></select></label>
    <p class="cube-splat-count"></p><label>Splats per mesh part<input aria-label="Splats per mesh part" type="number" min="256" max="100000" step="1" value="24576"></label><small>Face grid density applies to simple cubes. The mesh budget counts surface samples; invisible and cutout samples are skipped.</small>
    <label>Overlap<input aria-label="Splat overlap" type="number" min="0.3" max="1.2" step="0.05" value="0.65"></label>
    <small>Higher values fill gaps but soften edges.</small>
    <label>Thickness<input aria-label="Splat thickness" type="number" min="0.01" max="0.5" step="0.01" value="0.05"></label>
    <small>Relative to the spacing between samples.</small>
    <label>Opacity<input aria-label="Splat opacity" type="number" min="0.1" max="1" step="0.01" value="0.98"></label>
    <label class="cube-splat-check"><input type="checkbox" aria-label="Bake simple shading" checked> Bake simple shading</label>
    <small>Lighting is baked into the splat colors.</small>
    <label class="cube-splat-check"><input type="checkbox" aria-label="Move copy aside"> Move unrigged copy aside for comparison</label>
    <p role="status" aria-live="polite"></p>
    </div><wa-button slot="footer" class="cube-splat-close" variant="neutral">Close</wa-button><wa-button slot="footer" class="cube-splat-convert" variant="brand">Convert</wa-button>`;
  const select = dialog.querySelector("select")!, inputs = dialog.querySelectorAll<HTMLInputElement>('input[type="number"]:not([aria-label="Splats per mesh part"])'), checks = dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  const status = dialog.querySelector<HTMLElement>('[role="status"]')!, button = dialog.querySelector<HTMLButtonElement>(".cube-splat-convert")!;
  const count = () => { dialog.querySelector(".cube-splat-count")!.textContent = `${(6 * Number(select.value) ** 2).toLocaleString()} splats total`; };
  select.onchange = count; count();
  dialog.querySelector<HTMLButtonElement>(".cube-splat-close")!.onclick = () => { dialog.open = false; };
  button.onclick = async () => {
    if (Array.from(dialog.querySelectorAll<HTMLInputElement>('input[type="number"]')).some(input => !input.reportValidity())) return;
    button.disabled = true; status.textContent = "Converting…";
    try { status.textContent = await convert({ ...defaultCubeSplatSettings, resolution: Number(select.value), overlap: Number(inputs[0].value), thickness: Number(inputs[1].value), opacity: Number(inputs[2].value), shading: checks[0].checked }, checks[1].checked, Number(dialog.querySelector<HTMLInputElement>('[aria-label="Splats per mesh part"]')!.value)); }
    catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
    finally { button.disabled = false; }
  };
  document.body.append(dialog);
  return { open() { status.textContent = ""; dialog.open = true; } };
}

