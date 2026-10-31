import type { SceneDocument } from "./scene-document.ts";
import type { ParticleShapeNode } from "./particle-emitter.ts";
import { createParticlePoseSampler } from "./particle-pose-sampler.ts";
import { createParticleSimulation } from "./particle-simulation.ts";
import { createParticleRenderable } from "./particle-renderer.ts";

/** Owns cancellable replay independently of document history and render loops. */
export function createParticleRuntime(shape: ParticleShapeNode) {
  const renderer = createParticleRenderable(); renderer.mesh.name = shape.name;
  let previousDoc: SceneDocument | undefined, simulation: ReturnType<typeof createParticleSimulation> | undefined;
  let requestedFrame = NaN, generation = 0, disposed = false;
  let status: { count: number; pending: boolean; error?: string } = { count: 0, pending: false };
  return {
    ...renderer,
    get status() { return status; },
    request(doc: SceneDocument, next: ParticleShapeNode, frame: number, sampler: ReturnType<typeof createParticlePoseSampler>, changed: () => void) {
      if (disposed || (doc === previousDoc && frame === requestedFrame)) return;
      const ticket = ++generation, previousFrame = requestedFrame; requestedFrame = frame;
      const failed = (error: unknown) => {
        if (disposed || ticket !== generation || (error instanceof Error && error.name === "AbortError")) return;
        renderer.clear(); status = { count: 0, pending: false, error: error instanceof Error ? error.message : String(error) }; changed();
      };
      try {
        if (doc !== previousDoc || !simulation) {
          simulation?.dispose(); simulation = undefined; renderer.clear(); status = { count: 0, pending: false };
          previousDoc = doc; simulation = createParticleSimulation(doc, next, sampler); renderer.mesh.name = next.name;
        } else if (frame < previousFrame) { renderer.clear(); status = { count: 0, pending: false }; }
        status = { ...status, pending: true, error: undefined };
        void simulation.snapshotAt(frame).then(result => {
          if (disposed || ticket !== generation) return;
          renderer.setFrame(result); status = { count: result.count, pending: false }; changed();
        }).catch(failed);
      } catch (error) { failed(error); }
    },
    suspend() { generation++; simulation?.dispose(); simulation = undefined; previousDoc = undefined; requestedFrame = NaN; renderer.clear(); status = { count: 0, pending: false }; },
    dispose() { if (disposed) return; disposed = true; generation++; simulation?.dispose(); renderer.dispose(); },
  };
}
