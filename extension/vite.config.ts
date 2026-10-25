import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Builds the unpacked extension into dist/: the side panel page, the
// background service worker (as a fixed-name background.js the manifest points
// to), and everything in public/ (manifest and icons).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  // The side panel reuses the web app's API client, which needs an absolute
  // server address outside the web app's dev proxy.
  define: {
    "import.meta.env.VITE_API_BASE": JSON.stringify(process.env.VITE_API_BASE ?? "http://127.0.0.1:8787"),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: { sidepanel: "sidepanel.html", background: "src/background.ts", content: "src/content.ts" },
      output: {
        // background.js and content.js keep fixed names because the manifest points to them.
        entryFileNames: (chunk) => (chunk.name === "background" || chunk.name === "content" ? `${chunk.name}.js` : "assets/[name]-[hash].js"),
      },
    },
  },
});
