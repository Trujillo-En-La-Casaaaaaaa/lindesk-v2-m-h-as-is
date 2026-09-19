import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    // Same-origin /api prefix: the dev server forwards it to shopflow-gateway,
    // which publishes host port 3001 (the port the retired API used).
    proxy: { "/api": { target: "http://localhost:3001", rewrite: (path) => path.replace(/^\/api/, "") } }
  }
});
