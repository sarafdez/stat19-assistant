#!/usr/bin/env node
/**
 * Cross-platform launcher: `node start.mjs`, or double-click start.command / start.bat, which
 * are thin wrappers around this file.
 *
 * One implementation rather than a shell script per OS — the previous Windows batch file had
 * drifted from the macOS one and passed --yes to setup, so a first run silently skipped the
 * API-key prompt and the chat failed with no explanation.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(ROOT, "app");
const CLIENT_URL = "http://localhost:5178";
const isWindows = process.platform === "win32";
const npm = isWindows ? "npm.cmd" : "npm";

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
async function openWhenReady() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await fetch(CLIENT_URL, { signal: AbortSignal.timeout(1000) });
      openBrowser(CLIENT_URL);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  console.error(`Fikk ikke kontakt med ${CLIENT_URL} – åpne den manuelt i nettleseren.`);
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

  console.log(`Starter… nettleseren åpnes på ${CLIENT_URL}\nStopp med Ctrl+C.\n`);
  // Own process group on POSIX: `npm run dev` fans out to concurrently → vite + tsx, and npm
  // does not forward signals to them. Without this, Ctrl+C left both servers orphaned and the
  // ports held. Windows has no process groups, so it gets taskkill /T instead.
  const dev = spawn(npm, ["run", "dev"], { cwd: APP, stdio: "inherit", detached: !isWindows });
  dev.on("error", (err) => {
    console.error(`Klarte ikke å starte npm: ${err.message}`);
    process.exit(1);
  });

  openWhenReady();

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
