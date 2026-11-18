import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `@suup/api` is the shared contract and `@suup/avatar` the avatar engine: the app imports their
// sources directly, so a build of the web app does not depend on a previous `tsc -b`.
const source = (path: string) => fileURLToPath(new URL(`../../packages/${path}`, import.meta.url));
export const apiSource = source("api/src/index.ts");
export const workspaceAliases = [
  { find: /^@suup\/api$/, replacement: apiSource },
  { find: /^@suup\/avatar$/, replacement: source("avatar/src/index.ts") },
  { find: /^@suup\/avatar\/browser$/, replacement: source("avatar/src/browser.ts") },
];

export default defineConfig({
  plugins: [react()],
  resolve: { alias: workspaceAliases },
  // Tauri expects a fixed port in development (the server allows this origin in CORS).
  server: { port: 1420, strictPort: true, host: "127.0.0.1" },
  preview: { port: 1420, strictPort: true, host: "127.0.0.1" },
  build: { target: "es2022", sourcemap: false },
  clearScreen: false,
});
