import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, proxy API calls to the Fastify server.
const target = `http://${process.env.API_HOST ?? "127.0.0.1"}:${process.env.API_PORT ?? 3001}`;

export default defineConfig({
  plugins: [react()],
  build: {
    // The API's CSP allows fonts from 'self' only, so font subsets ship as files.
    assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
  },
  server: {
    proxy: {
      "/api": target,
      "/health": target,
    },
  },
});
