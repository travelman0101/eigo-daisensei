import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  optimizeDeps: { include: ["react", "react-dom", "react-dom/client", "react/jsx-dev-runtime", "motion/react", "idb"] },
  // AI calls need a Cloudflare login; local dev uses AI_MOCK unless CF_REMOTE=1.
  plugins: [react(), cloudflare({ remoteBindings: process.env.CF_REMOTE === "1" })],
});
