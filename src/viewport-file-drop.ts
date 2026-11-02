/** Shares the file-picker path, including its busy and unsaved-project checks. */
export function mountViewportFileDrop(viewport: HTMLElement, onFiles: (files: File[]) => void) {
  let depth = 0;
  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
  const clear = () => { depth = 0; viewport.classList.remove("file-drop-active"); };
  viewport.addEventListener("dragenter", event => {
    if (!hasFiles(event)) return;
    event.preventDefault(); depth++; viewport.classList.add("file-drop-active");
  });
  viewport.addEventListener("dragover", event => {
    if (!hasFiles(event)) return;
    event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });
  viewport.addEventListener("dragleave", event => {
    if (!hasFiles(event)) return;
    if (--depth <= 0) clear();
  });
  viewport.addEventListener("drop", event => {
    if (!hasFiles(event)) return;
    event.preventDefault(); event.stopPropagation(); clear();
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length) onFiles(files);
  });
  // A file released outside the viewport must not navigate away from the scene.
  window.addEventListener("dragover", event => { if (hasFiles(event)) event.preventDefault(); });
  window.addEventListener("drop", event => { if (hasFiles(event)) { event.preventDefault(); clear(); } });
  window.addEventListener("dragend", clear);
}
