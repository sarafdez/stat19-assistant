/**
 * Build the client into app/dist WITHOUT esbuild.
 *
 *   node build-client.mjs
 *
 * Why this exists: `npm run build` uses Vite, and Vite delegates TS/JSX to esbuild,
 * which spawns a native esbuild.exe out of node_modules. Application allowlisting
 * (AppLocker) on an FHI PC blocks executables in user-writable paths, so that fails
 * with `spawn UNKNOWN` and the app cannot be built on such a machine at all.
 *
 * Nothing here spawns a binary:
 *   - tsc (pure JavaScript)      TSX -> JS, via tsconfig.client.json
 *   - Rollup (a .node addon)     bundle + tree-shake; addons load fine, only .exe is blocked
 *   - Tailwind CLI (.node addon) styles.css -> plain CSS
 *
 * The output is a normal static bundle, byte-for-byte equivalent in purpose to Vite's:
 * app/dist/{index.html,assets/*}. The server serves it (see server/index.ts), so
 * `npm run serve`, or start.bat / start.mjs, then runs the whole app on one origin.
 *
 * Prefer `npm run build` (Vite) wherever esbuild is allowed to run; this is the fallback.
 */
import { rollup } from "rollup";
import nodeResolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import replace from "@rollup/plugin-replace";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TS_OUT = path.join(HERE, ".build-client");
const DIST = path.join(HERE, "dist");
const ASSETS = path.join(DIST, "assets");
const NODE = process.execPath;

const step = (msg) => console.log(`\x1b[2m→ ${msg}\x1b[0m`);
const die = (msg) => {
  console.error(`\x1b[31m✖ ${msg}\x1b[0m`);
  process.exit(1);
};

/** Run a Node-based CLI in-process-adjacent (node <script>), never a bare binary. */
function runNode(scriptRelative, args, label) {
  const script = path.join(HERE, "node_modules", ...scriptRelative);
  if (!fs.existsSync(script)) die(`${label}: mangler ${script}. Kjør « npm install » i app/.`);
  const r = spawnSync(NODE, [script, ...args], { cwd: HERE, stdio: "inherit" });
  if (r.error) die(`${label} kunne ikke starte: ${r.error.message}`);
  if (r.status !== 0) die(`${label} feilet (kode ${r.status}).`);
}

// ── 1. TSX -> JS ───────────────────────────────────────────────────────────────
step("kompilerer klienten med tsc …");
runNode(["typescript", "bin", "tsc"], ["-p", "tsconfig.client.json"], "tsc");

const entry = path.join(TS_OUT, "main.js");
if (!fs.existsSync(entry)) die(`fant ikke ${entry} etter kompilering.`);

// ── 2. Bundle ──────────────────────────────────────────────────────────────────
step("bundler med Rollup …");
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(ASSETS, { recursive: true });

// The CSS import is a bundler convention; Tailwind emits the real stylesheet in step 3,
// so the import becomes an empty module rather than being bundled into the JS.
const stubCss = {
  name: "stub-css",
  resolveId: (id) => (id.endsWith(".css") ? { id, external: false } : null),
  load: (id) => (id.endsWith(".css") ? "export default undefined;" : null),
};

let bundle;
try {
  bundle = await rollup({
    input: entry,
    plugins: [
      stubCss,
      // React reads process.env.NODE_ENV and ships dev-only warnings behind it.
      // Without this the browser throws on `process` being undefined.
      replace({ preventAssignment: true, "process.env.NODE_ENV": JSON.stringify("production") }),
      nodeResolve({ browser: true, extensions: [".mjs", ".js", ".json"] }),
      commonjs(),
    ],
    // Rollup warns about `use client` directives in React 19 packages; they are
    // meaningless outside a server-components bundler and safe to drop.
    onwarn(warning, warn) {
      if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
      warn(warning);
    },
  });
  const { output } = await bundle.write({
    dir: ASSETS,
    format: "es",
    entryFileNames: "main.js",
    chunkFileNames: "[name]-[hash].js",
    sourcemap: true,
  });
  const bytes = output.reduce((n, c) => n + (c.type === "chunk" ? c.code.length : 0), 0);
  step(`${output.filter((c) => c.type === "chunk").length} chunk(s), ${(bytes / 1024).toFixed(0)} kB JS`);
} catch (err) {
  die(`Rollup feilet: ${err.message}`);
} finally {
  await bundle?.close();
}

// ── 3. Tailwind CSS ────────────────────────────────────────────────────────────
step("bygger CSS med Tailwind …");
runNode(
  ["@tailwindcss", "cli", "dist", "index.mjs"],
  ["--input", path.join("client", "styles.css"), "--output", path.join("dist", "assets", "styles.css"), "--minify"],
  "tailwindcss",
);

// ── 4. index.html ──────────────────────────────────────────────────────────────
// index.html points at /client/main.tsx, which only a dev server can serve.
// Rewrite it to the built assets, the same substitution Vite makes.
step("skriver index.html …");
const html = fs.readFileSync(path.join(HERE, "index.html"), "utf8");
const rewritten = html.replace(
  /<script type="module" src="\/client\/main\.tsx"><\/script>/,
  '<script type="module" crossorigin src="/assets/main.js"></script>\n    <link rel="stylesheet" href="/assets/styles.css" />',
);
if (rewritten === html) die("klarte ikke å bytte ut script-tagen i index.html – er den endret?");
fs.writeFileSync(path.join(DIST, "index.html"), rewritten);

// Intermediate tsc output is not part of the deliverable.
fs.rmSync(TS_OUT, { recursive: true, force: true });

const list = fs.readdirSync(ASSETS).map((f) => `    assets/${f}`).join("\n");
console.log(`\n\x1b[32m✔\x1b[0m Klienten er bygd til app/dist:\n    index.html\n${list}`);
console.log(`\n  Start appen:  npm run serve      \x1b[2m→ http://127.0.0.1:5179\x1b[0m`);
console.log(`  eller dobbeltklikk start.bat\n`);
