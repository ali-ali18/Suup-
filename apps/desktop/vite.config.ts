import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `@suup/api` is the shared contract: the app imports its sources directly, so a build of the
// web app does not depend on a previous `tsc -b`.
export const apiSource = fileURLToPath(new URL("../../packages/api/src/index.ts", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@suup/api": apiSource } },
  // Tauri expects a fixed port in development (the server allows this origin in CORS).
  server: { port: 1420, strictPort: true, host: "127.0.0.1" },
  preview: { port: 1420, strictPort: true, host: "127.0.0.1" },
  build: { target: "es2022", sourcemap: false },
  clearScreen: false,
});
