import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Keep dependencies (notably @lydell/node-pty's native binding) external
  // to the main/preload bundles — they resolve from node_modules at runtime.
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    plugins: [react()],
  },
});
