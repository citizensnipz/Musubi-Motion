import type { AnimationData } from "./animation.ts";

/** Frame-based playback keeps authored frame numbers unchanged when FPS changes. */
export function advanceFrame(frame: number, seconds: number, settings: AnimationData) {
  const next = frame + Math.max(0, seconds) * settings.fps;
  if (next <= settings.end) return { frame: Math.max(settings.start, next), stopped: false };
  if (!settings.loop) return { frame: settings.end, stopped: true };
  const span = settings.end - settings.start;
  return { frame: settings.start + ((next - settings.start) % span), stopped: false };
}
