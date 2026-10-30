// Optional File System Access API. Fallback browsers use file inputs and downloads.
export type SceneFileHandle = {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{
    write(data: Blob): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  }>;
};
type PickerWindow = Window & {
  showSaveFilePicker?: (options: object) => Promise<SceneFileHandle>;
  showOpenFilePicker?: (options: object) => Promise<SceneFileHandle[]>;
};
const types = [
  {
    description: "Musubi scene",
    accept: { "application/octet-stream": [".msb"] },
  },
];
export function msbName(name: string): string {
  const clean =
    name.trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, "_") || "Untitled";
  return /\.msb$/i.test(clean) ? clean : `${clean}.msb`;
}
export async function pickScene(): Promise<
  { file: File; handle: SceneFileHandle } | undefined
> {
  const picker = (window as PickerWindow).showOpenFilePicker;
  if (!picker) return undefined;
  const [handle] = await picker.call(window, {
    types,
    multiple: false,
    excludeAcceptAllOption: true,
  });
  return { file: await handle.getFile(), handle };
}
export async function saveDestination(
  name: string,
  existing?: SceneFileHandle,
): Promise<{ name: string; handle?: SceneFileHandle } | null> {
  if (existing) return { name: existing.name, handle: existing };
  const picker = (window as PickerWindow).showSaveFilePicker;
  if (picker) {
    const handle = await picker.call(window, {
      types,
      suggestedName: msbName(name),
      excludeAcceptAllOption: true,
    });
    return { name: handle.name, handle };
  }
  const requested = window.prompt("Save scene as", msbName(name));
  return requested === null ? null : { name: msbName(requested) };
}
export async function writeScene(
  bytes: Uint8Array,
  destination: { name: string; handle?: SceneFileHandle },
) {
  const blob = new Blob([new Uint8Array(bytes).buffer], {
    type: "application/octet-stream",
  });
  if (destination.handle) {
    const writable = await destination.handle.createWritable();
    try {
      await writable.write(blob);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }
  } else {
    const url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download = destination.name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}
