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
    // Локальный PHP-прокси: `php -S 127.0.0.1:8099 -t host`, затем npm run dev.
    proxy: {
      "/host/proxy.php": {
        target: "http://127.0.0.1:8099",
        rewrite: () => "/proxy.php",
      },
    },
  },
  preview: {
    port: 4173,
  },
});
