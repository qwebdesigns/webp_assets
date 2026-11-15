import { defineConfig } from "vite";

// GitHub Pages serves the site from /<repo>/, so every emitted URL must be relative.
// `base: "./"` makes the build portable: it works at a domain root and in a sub-path.
export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    assetsInlineLimit: 0,
  },
  worker: {
    format: "es",
  },
  server: {
    port: 5173,
  },
  preview: {
    port: 4173,
  },
});
