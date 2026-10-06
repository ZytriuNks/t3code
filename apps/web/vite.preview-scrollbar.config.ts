import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

/**
 * Serves only the scrollbar review page.
 *
 * Deliberately separate from vite.config.ts: that config installs the router,
 * the dev proxy, and the license plugin, none of which the review page needs,
 * and its dev server boots the whole app shell. This config boots nothing but
 * the page.
 */
const previewRoot = fileURLToPath(new URL("./preview-scrollbar", import.meta.url));

export default defineConfig({
  root: previewRoot,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // The component and its geometry helper import via the `~/` alias.
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5744,
    strictPort: true,
  },
});