import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// SINGLE_FILE=1 folds the whole app into one chunk so scripts/build-single.mjs
// can inline it into a single .html a participant can just double-click. The
// normal build is untouched apart from `base`.
const single = process.env.SINGLE_FILE === "1";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  // Relative, not absolute: an absolute /assets/... breaks both a project page
  // on GitHub Pages (served from /repo-name/) and a file:// double-click.
  base: "./",
  build: {
    cssCodeSplit: !single,
    rollupOptions: single ? { output: { inlineDynamicImports: true } } : {},
  },
});
