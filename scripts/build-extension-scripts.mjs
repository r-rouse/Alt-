import * as esbuild from "esbuild";

/**
 * Bundle MV3 background + content script as single files.
 * Content script = IIFE (classic script). Background = ESM (manifest type: module).
 */
await esbuild.build({
  entryPoints: ["src/content/contentScript.ts"],
  bundle: true,
  outfile: "dist/contentScript.js",
  format: "iife",
  target: ["chrome110"],
  logLevel: "info",
});

await esbuild.build({
  entryPoints: ["src/background/background.ts"],
  bundle: true,
  outfile: "dist/background.js",
  format: "esm",
  target: ["chrome110"],
  logLevel: "info",
});

console.log("Extension scripts bundled.");
