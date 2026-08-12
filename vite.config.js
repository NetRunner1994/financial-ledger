import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Relative base so the build works from a subpath, e.g. GitHub Pages
  // served at /ledger/ as well as from a domain root on Netlify.
  base: "./",
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
