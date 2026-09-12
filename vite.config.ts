import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { viteStaticCopy } from "vite-plugin-static-copy";

/**
 * Side panel is built with Vite (React).
 * Content script + background are bundled separately via esbuild in package.json
 * so they ship as single files Chrome can load without code-splitting imports.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    // Relative paths required for chrome-extension:// side panel loading
    base: "./",
    plugins: [
      react(),
      viteStaticCopy({
        targets: [
          { src: "manifest.json", dest: "." },
          { src: "public/icons/*", dest: "icons" },
          { src: "demo/*", dest: "demo" },
        ],
      }),
    ],
    define: {
      "import.meta.env.VITE_OPENAI_API_KEY": JSON.stringify(
        env.VITE_OPENAI_API_KEY || env.OPENAI_API_KEY || ""
      ),
      "import.meta.env.VITE_OPENROUTER_API_KEY": JSON.stringify(
        env.VITE_OPENROUTER_API_KEY || env.OPENROUTER_API_KEY || ""
      ),
      "import.meta.env.VITE_VISION_PROVIDER": JSON.stringify(
        env.VITE_VISION_PROVIDER || env.VISION_PROVIDER || "openai"
      ),
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      rollupOptions: {
        input: {
          sidepanel: resolve(__dirname, "sidepanel.html"),
          permission: resolve(__dirname, "permission.html"),
        },
      },
    },
  };
});
