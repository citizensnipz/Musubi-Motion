import { defineConfig } from "vitest/config";

export default defineConfig({
  // Discover the complete importer/archive graph at startup, avoiding a dependency
  // optimization restart when the first FBX is selected in a running editor.
  optimizeDeps: { include: ["three/addons/loaders/FBXLoader.js", "@zip.js/zip.js", "@noble/hashes/sha2.js"] },
  test: { server: { deps: { inline: ["zundo"] } } },
  // Example generators load the editor commands through Vite's server loader.
  // Keep the framework-free Zustand alias effective inside Zundo there too.
  ssr: { noExternal: ["zundo"] },
  resolve: {
    // Zundo imports createStore from Zustand's root (which also exports React hooks).
    // This editor uses the same public store API from the framework-free entry point.
    alias: [{ find: /^zustand$/, replacement: "zustand/vanilla" }],
  },
});
