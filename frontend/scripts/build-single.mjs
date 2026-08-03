// Build the whole app into ONE .html file.
//
// The point is the lowest-friction way to hand this to someone: no clone, no
// npm, no server, no link that can rot. They get a file, they double-click it,
// it runs in their browser. Everything is inlined, so it works from file://
// with no network at all.
//
//   npm run build:single      ->  dist-single/interactive-airflow.html
//
// One caveat worth knowing before sending it: it is one ~1.2 MB file, which is
// fine as an email attachment but is not a thing to keep re-sending as you
// iterate. Nothing is lost functionally — the goal parser is a dictionary that
// runs in the page, so a file opened with no network understands every sentence
// the deployed app does.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, "dist");
const out = join(root, "dist-single");

execFileSync("npx", ["vite", "build"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, SINGLE_FILE: "1" },
});

const assets = join(dist, "assets");
const files = readdirSync(assets);
const js = files.filter((f) => f.endsWith(".js"));
const css = files.filter((f) => f.endsWith(".css"));
if (js.length !== 1) {
  throw new Error(`expected exactly one JS chunk to inline, found ${js.length}: ${js.join(", ")}`);
}

let html = readFileSync(join(dist, "index.html"), "utf8");
// Drop the tags that point at files, and inline their contents instead. The
// script keeps type="module" so top-level await and import.meta still parse.
html = html
  .replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, "")
  .replace(/<link[^>]*rel="stylesheet"[^>]*>/g, "")
  .replace(/<link[^>]*rel="modulepreload"[^>]*>/g, "");

const styles = css.map((f) => `<style>\n${readFileSync(join(assets, f), "utf8")}\n</style>`).join("\n");

// The bundle goes in BASE64, not as script text.
//
// Pasting a megabyte of minified JS between <script> tags puts it through the
// HTML tokenizer, which has its own opinions about what it is reading: three.js
// ships GLSL in template literals full of `#include <...>`, and the parser cut
// the element short and left an unterminated template behind — a page that
// silently rendered nothing, with no console error, because the script it was
// running was not the script we wrote. Base64 has no `<` in it at all, so there
// is nothing for the tokenizer to react to; the loader turns it back into a
// module through a Blob URL, which keeps `import.meta` and top-level await
// working exactly as they do from a real file.
const b64 = readFileSync(join(assets, js[0])).toString("base64");
const script = `<script type="module">
const src = Uint8Array.from(atob("${b64}"), (c) => c.charCodeAt(0));
const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
import(url).catch((e) => {
  document.body.innerHTML =
    '<pre style="padding:24px;font:13px system-ui;color:#a23226">Could not start: ' + e + '</pre>';
});
</script>`;

html = html.replace("</head>", `${styles}\n</head>`).replace("</body>", `${script}\n</body>`);

mkdirSync(out, { recursive: true });
const file = join(out, "interactive-airflow.html");
writeFileSync(file, html);
console.log(`\nOne file, ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB: ${file}`);
