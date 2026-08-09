import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Root is web/, build output is web/dist. vite.config.ts is intentionally COPYd into
// the image build stage (the old console shipped without
// it and the SPA silently fell back to root=/app, never building web/dist).
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8484",
      "/auth": "http://localhost:8484",
    },
  },
});
