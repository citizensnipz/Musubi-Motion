import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { server: { deps: { inline: ["zundo"] } } },
  resolve: {
    // Zundo imports createStore from Zustand's root (which also exports React hooks).
    // This editor uses the same public store API from the framework-free entry point.
    alias: [{ find: /^zustand$/, replacement: "zustand/vanilla" }],
  },
});
