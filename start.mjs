#!/usr/bin/env node
/**
 * Cross-platform launcher: `node start.mjs`, or double-click start.command / start.bat, which
 * are thin wrappers around this file.
 *
 * One implementation rather than a shell script per OS — the previous Windows batch file had
 * drifted from the macOS one and passed --yes to setup, so a first run silently skipped the
 * API-key prompt and the chat failed with no explanation.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(ROOT, "app");
const CLIENT_URL = "http://localhost:5178";
// Where the built client is served from when Vite cannot run: the API server hands out
// app/dist itself, so client and API share one origin and need no proxy.
const SERVER_URL = "http://127.0.0.1:5179";
const isWindows = process.platform === "win32";
const npm = isWindows ? "npm.cmd" : "npm";

/**
 * Can esbuild actually run here?
 *
 * esbuild ships a native esbuild.exe and spawns it as a service. Application allowlisting
 * (AppLocker) on an FHI PC only permits executables in allowlisted paths, and node_modules
 * is not one, so the spawn fails with `spawn UNKNOWN`. Vite and tsx both depend on it, which
 * takes out `npm run dev` entirely — hence the fallback below.
 *
 * Ask esbuild to do the smallest possible piece of work rather than pattern-matching on error
 * text: transformSync starts the service, so this fails exactly when the real build would.
 */
function esbuildWorks() {
  const probe = spawnSync(process.execPath, ["-e", "require('esbuild').transformSync('0')"], {
    cwd: APP,
    stdio: "ignore",
  });
  return !probe.error && probe.status === 0;
}

/** Run to completion with the terminal attached, so prompts and git logins still work. */
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} avsluttet med kode ${code}`))));
  });
}

function openBrowser(url) {
  const [command, args] = isWindows
    ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];
  spawn(command, args, { stdio: "ignore", detached: true }).unref();
}

/** Wait for the dev server to answer before opening a tab, so nobody sees a refused connection. */
async function openWhenReady(url) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(1000) });
      openBrowser(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  console.error(`Fikk ikke kontakt med ${url} – åpne den manuelt i nettleseren.`);
}

async function main() {
  if (!fs.existsSync(APP)) {
    console.error(`Fant ikke app-mappa i ${APP}. Kjører du dette fra repoet?`);
    process.exit(1);
  }

  // First run: full interactive setup, so the API-key prompt actually appears.
  if (!fs.existsSync(path.join(APP, "node_modules"))) {
    console.log("Første gang: kjører oppsett…\n");
    await run(process.execPath, [path.join(ROOT, "setup.mjs")]);
    console.log("");
  }

  // Without esbuild there is no Vite and no tsx, so serve a prebuilt client from the compiled
  // server instead of running the dev servers. Same app, no hot reload.
  const viteUsable = esbuildWorks();
  const url = viteUsable ? CLIENT_URL : SERVER_URL;

  if (!viteUsable) {
    console.log(
      "esbuild kan ikke kjøre her – antakelig programkontroll (AppLocker) på en FHI-PC.\n" +
        "Starter uten Vite: ferdigbygd klient + kompilert server. Ingen hot reload.\n",
    );
    if (!fs.existsSync(path.join(APP, "dist"))) {
      console.log("Bygger klienten (tsc + Rollup). Dette tar et halvt minutt…\n");
      await run(process.execPath, [path.join(APP, "build-client.mjs")], { cwd: APP });
      console.log("");
    }
    await run(process.execPath, [path.join(APP, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.server.json"], {
      cwd: APP,
    });
  }

  console.log(`Starter… nettleseren åpnes på ${url}\nStopp med Ctrl+C.\n`);
  // Own process group on POSIX: `npm run dev` fans out to concurrently → vite + tsx, and npm
  // does not forward signals to them. Without this, Ctrl+C left both servers orphaned and the
  // ports held. Windows has no process groups, so it gets taskkill /T instead.
  const dev = viteUsable
    ? spawn(npm, ["run", "dev"], { cwd: APP, stdio: "inherit", detached: !isWindows })
    : spawn(process.execPath, [path.join("dist-server", "index.js")], {
        cwd: APP,
        stdio: "inherit",
        detached: !isWindows,
      });
  dev.on("error", (err) => {
    console.error(`Klarte ikke å starte ${viteUsable ? "npm" : "serveren"}: ${err.message}`);
    process.exit(1);
  });

  openWhenReady(url);

  // Forward Ctrl+C to the whole tree, then exit once it is actually gone.
  //
  // npm exits on the first signal while vite and tsx are still shutting down. Exiting as soon
  // as npm does — which the obvious dev.on("exit") → process.exit does — abandons them, leaving
  // both ports held. So once stopping, this process stays alive long enough to SIGKILL whatever
  // survived, and the timer is deliberately not unref'd.
  let stopping = false;
  const killGroup = (signal) => {
    if (dev.pid === undefined) return;
    try {
      process.kill(-dev.pid, signal);
    } catch {
      /* group already gone */
    }
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (isWindows) {
      spawn("taskkill", ["/pid", String(dev.pid), "/T", "/F"], { stdio: "ignore" });
      setTimeout(() => process.exit(0), 2000);
      return;
    }
    killGroup("SIGTERM");
    setTimeout(() => {
      killGroup("SIGKILL");
      process.exit(0);
    }, 2000);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // Only relay the dev server's exit code when it stopped on its own, not during shutdown.
  dev.on("exit", (code) => {
    if (!stopping) process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
