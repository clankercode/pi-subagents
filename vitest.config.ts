import { defineConfig } from "vitest/config";

export default defineConfig({
  // The print-mode e2e suite (test/subagents-print-mode-e2e.test.ts) drives REAL
  // faux-model turns through pi-coding-agent + pi-agent-core. That requires ONE
  // shared @earendil-works/pi-ai instance so the faux provider the test registers
  // lands in the same api-registry the session streams through. npm physically
  // duplicates pi-ai (a top-level copy and one nested under pi-coding-agent), which
  // otherwise yields two registries and "No API provider registered" errors.
  // Inlining the @earendil-works packages routes them through Vite's resolver so
  // dedupe can collapse pi-ai to a single instance — for the parent AND for every
  // subagent session the extension spawns. dedupe alone is insufficient (it only
  // affects modules Vite resolves; without inline the runtime stays externalized).
  test: {
    server: { deps: { inline: [/@earendil-works\/pi-/] } },
    // Cap parallelism to 2 workers. Under heavy system load, vite's SSR
    // transforms (the inline @earendil-works packages above) can OOM/timeout
    // and surface as a misleading `Cannot find module '.../stream'` from
    // vitest's module-evaluator. Limiting concurrency keeps memory + transform
    // pressure low and matches the host's 2-thread testing budget.
    minWorkers: 1,
    maxWorkers: 2,
  },
  resolve: { dedupe: ["@earendil-works/pi-ai"] },
});
