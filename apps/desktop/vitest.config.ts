import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { apiSource } from "./vite.config.js";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@suup/api": apiSource } },
  test: {
    name: "desktop",
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test-setup.ts"],
  },
});
