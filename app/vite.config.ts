import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5178,
    proxy: {
      "/api": "http://127.0.0.1:5179",
      "/wiki-assets": "http://127.0.0.1:5179",
    },
  },
  build: { outDir: "dist" },
});
