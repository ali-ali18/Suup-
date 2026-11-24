import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `@suup/api` is the shared contract and `@suup/avatar` the avatar engine: the app imports their
// sources directly, so a build of the web app does not depend on a previous `tsc -b`.
const source = (path: string) => fileURLToPath(new URL(`../../packages/${path}`, import.meta.url));
export const apiSource = source("api/src/index.ts");
export const workspaceAliases = [
  { find: /^@suup\/api$/, replacement: apiSource },
  // The text of an answer: pure, and the only part of `core` the browser needs (the index of
  // `core` has Node modules).
  { find: "@suup/core/answers", replacement: source("core/src/answers.ts") },
  // The schedule of a routine (docs/ROTINAS.md): zod and Intl only, shared with the server.
  { find: "@suup/core/schedule", replacement: source("core/src/schedule.ts") },
  // What a file the bot sends is (its kind, from the MIME type): exact tables, no Node module.
  { find: "@suup/core/files", replacement: source("core/src/files.ts") },
  { find: /^@suup\/avatar$/, replacement: source("avatar/src/index.ts") },
  { find: /^@suup\/avatar\/browser$/, replacement: source("avatar/src/browser.ts") },
];

export default defineConfig({
  plugins: [tailwindcss(), react()],
  resolve: { alias: workspaceAliases },
  // Tauri expects a fixed port in development (the server allows this origin in CORS).
  server: { port: 1420, strictPort: true, host: "127.0.0.1" },
  preview: { port: 1420, strictPort: true, host: "127.0.0.1" },
  build: { target: "es2022", sourcemap: false },
  clearScreen: false,
});
