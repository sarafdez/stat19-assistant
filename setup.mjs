#!/usr/bin/env node
/**
 * One-command setup for the Stat19 assistant. Cross-platform (macOS, Windows, Linux) —
 * plain Node so it works without bash, since Node is already required to run the app.
 *
 *   node setup.mjs                       install deps, fetch both snapshots, set up .env
 *   node setup.mjs --no-dbt              skip the dbt download
 *   node setup.mjs --from-zip <file>     unpack a shared dbt docs zip instead of downloading
 *   node setup.mjs --yes                 never prompt (CI, or re-running to refresh)
 *
 * Safe to re-run at any time: it pulls instead of re-cloning and only overwrites a snapshot
 * once the replacement has been fetched and validated.
 *
 * Both sources default to the FHI locations and need no configuration; STAT19_WIKI_REMOTE and
 * STAT19_DBT_BASE in .env override them, and STAT19_WIKI_DIR / STAT19_DBT_DIR move where the
 * snapshots are stored. See SNAPSHOTS.md.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const args = new Set(argv);
const skip = (name) => args.has(`--no-${name}`);
const assumeYes = args.has("--yes") || args.has("-y") || !process.stdin.isTTY;
const flagValue = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : null;
};

const ENV_FILE = path.join(ROOT, ".env");
// Load .env before resolving anything, so overrides set there apply on a re-run.
if (fs.existsSync(ENV_FILE)) {
  const shell = { ...process.env };
  try {
    process.loadEnvFile(ENV_FILE);
    for (const [k, v] of Object.entries(shell)) if (v) process.env[k] = v;
  } catch {
    /* a malformed .env is reported in step 1 */
  }
}

/** Same resolution as app/server/paths.ts — keep the two in step. */
const snapshotDir = (envVar, fallback) => {
  const configured = process.env[envVar]?.trim();
  if (!configured) return path.join(ROOT, fallback);
  const expanded = configured.startsWith("~")
    ? path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", configured.slice(1))
    : configured;
  return path.resolve(ROOT, expanded);
};
const WIKI_DIR = snapshotDir("STAT19_WIKI_DIR", "Stat19.wiki");
const DBT_DIR = snapshotDir("STAT19_DBT_DIR", "dbt");

/** FHI defaults, overridable in .env so a fork can point elsewhere without editing this file. */
const WIKI_REMOTE =
  process.env.STAT19_WIKI_REMOTE?.trim() ||
  "https://fhi.visualstudio.com/DefaultCollection/Stat19/_git/Stat19.wiki";
const DBT_BASE = (process.env.STAT19_DBT_BASE?.trim() || "https://dataproducts.stat19.fhi.no").replace(/\/$/, "");

const c = { dim: "\x1b[2m", bold: "\x1b[1m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", off: "\x1b[0m" };
const results = [];
const ok = (step, note) => (results.push({ step, state: "ok", note }), console.log(`${c.green}✔${c.off} ${note}`));
const warn = (step, note, hint) => (
  results.push({ step, state: "warn", note, hint }), console.log(`${c.yellow}!${c.off} ${note}`), hint && console.log(`  ${c.dim}${hint}${c.off}`)
);
const fail = (step, note, hint) => (
  results.push({ step, state: "fail", note, hint }), console.log(`${c.red}✖${c.off} ${note}`), hint && console.log(`  ${c.dim}${hint}${c.off}`)
);
const heading = (text) => console.log(`\n${c.bold}${text}${c.off}`);

/** Run a command with output shown, so git can prompt for credentials. */
function run(cmd, cmdArgs, opts = {}) {
  const res = spawnSync(cmd, cmdArgs, {
    stdio: "inherit",
    shell: false,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "1" },
    ...opts,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(" ")} avsluttet med kode ${res.status}`);
}

function has(cmd) {
  const probe = spawnSync(cmd, ["--version"], { stdio: "ignore", shell: false });
  return !probe.error && probe.status === 0;
}

// ── 0. Prerequisites ────────────────────────────────────────────────────────────
heading("Stat19-assistenten – oppsett");
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 20 || (major === 20 && minor < 12)) {
  fail("node", `Node ${process.versions.node} er for gammel.`, "Installer Node 20.12 eller nyere: https://nodejs.org");
  process.exit(1);
}
ok("node", `Node ${process.versions.node}`);
const gitAvailable = has("git");
if (!gitAvailable) warn("git", "git ble ikke funnet.", "Trengs for å hente wikien: https://git-scm.com/downloads");

// ── 1. API key in .env ──────────────────────────────────────────────────────────
heading("1/4  API-nøkkel");
function readEnvFile() {
  try {
    return fs.readFileSync(ENV_FILE, "utf8");
  } catch {
    return "";
  }
}
const envText = readEnvFile();
const keyInEnvFile = /^\s*ANTHROPIC_API_KEY\s*=\s*\S+/m.test(envText);
const keyInShell = Boolean(process.env.ANTHROPIC_API_KEY);

if (keyInEnvFile) {
  ok("env", `ANTHROPIC_API_KEY ligger i .env`);
} else if (keyInShell) {
  ok("env", "ANTHROPIC_API_KEY er satt i miljøet (trenger ingen .env)");
} else if (assumeYes) {
  warn("env", "Ingen API-nøkkel funnet.", "Legg ANTHROPIC_API_KEY=sk-ant-… i .env. Nøkkel: https://console.anthropic.com/settings/keys");
} else {
  console.log(`  ${c.dim}Lag en nøkkel på https://console.anthropic.com/settings/keys (starter med sk-ant-).${c.off}`);
  console.log(`  ${c.dim}Den lagres bare i .env her på maskinen, og .env er git-ignorert.${c.off}`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const key = (await rl.question("  Lim inn ANTHROPIC_API_KEY (eller Enter for å hoppe over): ")).trim();
  rl.close();
  if (key) {
    const body = envText && !envText.endsWith("\n") ? `${envText}\n` : envText;
    fs.writeFileSync(ENV_FILE, `${body}ANTHROPIC_API_KEY=${key}\n`, { mode: 0o600 });
    ok("env", "Nøkkelen er lagret i .env");
  } else {
    warn("env", "Hoppet over – chatten vil feile til nøkkelen er satt.", "Legg ANTHROPIC_API_KEY=sk-ant-… i .env når du har en.");
  }
}

// ── 2. Dependencies ────────────────────────────────────────────────────────────
heading("2/4  Avhengigheter");
if (skip("install")) {
  warn("install", "Hoppet over (--no-install).");
} else {
  try {
    run("npm", ["install", "--no-audit", "--no-fund"], { cwd: path.join(ROOT, "app") });
    ok("install", "npm-pakkene er installert");
  } catch (err) {
    fail("install", `npm install feilet: ${err.message}`, "Kjør « cd app && npm install » manuelt og se feilmeldingen.");
  }
}

// ── 3. Wiki clone ──────────────────────────────────────────────────────────────
heading("3/4  Wiki-klone (Stat19.wiki/)");
const authHint =
  process.platform === "win32"
    ? "  Windows: Git Credential Manager følger med Git for Windows og åpner nettleseren.\n" +
      "  Skjer ingenting, oppdater Git: https://git-scm.com/download/win"
    : "  macOS/Linux: enten « brew install --cask git-credential-manager » (nettleser-innlogging),\n" +
      "  eller lag et Personal Access Token i Azure DevOps (User settings → Personal access\n" +
      "  tokens → New token, scope « Code: Read ») og lim det inn som PASSORD når git spør.\n" +
      "  Kontopassordet virker ikke over HTTPS.";
const wikiHint = `Se SNAPSHOTS.md.\n${authHint}`;

if (skip("wiki")) {
  warn("wiki", "Hoppet over (--no-wiki).");
} else if (fs.existsSync(path.join(WIKI_DIR, ".git")) && gitAvailable) {
  // An existing clone knows its own origin — no STAT19_WIKI_REMOTE needed to update it.
  try {
    run("git", ["-C", WIKI_DIR, "pull", "--ff-only"]);
    ok("wiki", `Wikien er oppdatert (${countMarkdown(WIKI_DIR)} sider)`);
  } catch (err) {
    warn("wiki", `git pull feilet: ${err.message}`, "Den eksisterende klonen brukes videre – den kan være utdatert.");
  }
} else if (fs.existsSync(WIKI_DIR) && countMarkdown(WIKI_DIR) > 0) {
  ok("wiki", `Bruker wikien som ligger i ${WIKI_DIR} (${countMarkdown(WIKI_DIR)} sider – ikke en git-klone, oppdateres ikke automatisk)`);
} else if (!gitAvailable) {
  fail("wiki", "Kan ikke hente wikien uten git.", wikiHint);
} else {
  try {
    console.log(`  ${c.dim}Kloner ${WIKI_REMOTE} … (git spør om innlogging første gang)${c.off}`);
    run("git", ["clone", "--depth", "1", WIKI_REMOTE, WIKI_DIR]);
    ok("wiki", `Wikien er klonet (${countMarkdown(WIKI_DIR)} sider)`);
  } catch (err) {
    fail("wiki", `Klarte ikke å klone wikien: ${err.message}`, wikiHint);
  }
}

function countMarkdown(dir) {
  let n = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) n++;
    }
  };
  try {
    walk(dir);
  } catch {
    /* ignore */
  }
  return n;
}

// ── 4. dbt export ──────────────────────────────────────────────────────────────
heading("4/4  dbt-metadata (dbt/)");
const dbtHint =
  `${DBT_BASE} er IP-begrenset og svarer bare fra FHI-nettet (eller VPN).\n` +
  "  Har du en delt zip: node setup.mjs --from-zip <fil.zip>\n" +
  `  Eller legg manifest.json og catalog.json rett i ${DBT_DIR}. Se SNAPSHOTS.md.\n` +
  "  Appen og panelene virker uten – men variabelnavn blir uverifiserte.";

/** Validate + install one dbt artifact. Written via temp file so a bad copy never wins. */
function installDbtFile(name, text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${name} var ikke JSON (fikk du en innloggingsside?)`);
  }
  if (!parsed.nodes && !parsed.sources) throw new Error(`${name} ser ikke ut som en dbt-fil`);
  fs.mkdirSync(DBT_DIR, { recursive: true });
  const target = path.join(DBT_DIR, name);
  const tmp = `${target}.download`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, target);
  return { bytes: text.length, sources: Object.keys(parsed.sources ?? {}).length };
}

/**
 * Unpack a shared dbt docs zip. The two files may sit in a subfolder, so search the tree
 * rather than assuming a layout. Uses whatever unzip tool the OS has: `unzip` on macOS/Linux,
 * bsdtar (`tar -xf`) on Windows 10+ and macOS.
 */
function installFromZip(zipPath) {
  if (!fs.existsSync(zipPath)) throw new Error(`fant ikke ${zipPath}`);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "stat19-dbt-"));
  const tools = [
    ["unzip", ["-q", "-o", path.resolve(zipPath), "-d", out]],
    ["tar", ["-xf", path.resolve(zipPath), "-C", out]],
  ];
  let unpacked = false;
  for (const [cmd, cmdArgs] of tools) {
    const res = spawnSync(cmd, cmdArgs, { stdio: "ignore" });
    if (!res.error && res.status === 0) {
      unpacked = true;
      break;
    }
  }
  if (!unpacked) throw new Error("klarte ikke å pakke ut zipen – pakk den ut manuelt og bruk STAT19_DBT_DIR");

  const found = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "manifest.json" || entry.name === "catalog.json") found[entry.name] ??= full;
    }
  };
  walk(out);
  if (!found["manifest.json"]) throw new Error("zipen inneholder ingen manifest.json");

  const manifest = installDbtFile("manifest.json", fs.readFileSync(found["manifest.json"], "utf8"));
  if (found["catalog.json"]) installDbtFile("catalog.json", fs.readFileSync(found["catalog.json"], "utf8"));
  else warn("dbt", "Zipen hadde ingen catalog.json – datatyper mangler.");
  fs.rmSync(out, { recursive: true, force: true });
  return manifest;
}

/** The dbt docs UI fetches these over HTTP from the site root, so that is where they live. */
async function download(name) {
  const url = `${DBT_BASE}/${name}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} fra ${url}`);
  // A login or error page is also "200 OK" — installDbtFile only accepts real dbt JSON.
  return installDbtFile(name, await res.text());
}

const zipArg = flagValue("from-zip");
const dbtAlreadyThere = () => fs.existsSync(path.join(DBT_DIR, "manifest.json"));

if (skip("dbt")) {
  warn("dbt", "Hoppet over (--no-dbt).");
} else if (zipArg) {
  try {
    const manifest = installFromZip(zipArg);
    ok("dbt", `dbt-metadata pakket ut fra zip (${manifest.sources} dataprodukter) → ${DBT_DIR}`);
  } catch (err) {
    fail("dbt", `Klarte ikke å bruke zipen: ${err.message}`, dbtHint);
  }
} else {
  try {
    const manifest = await download("manifest.json");
    await download("catalog.json").catch((err) => {
      warn("dbt", `catalog.json feilet: ${err.message}`, "manifest.json holder for navn og beskrivelser; datatyper mangler.");
    });
    ok("dbt", `dbt-metadata hentet (${manifest.sources} dataprodukter i manifest.json)`);
  } catch (err) {
    if (dbtAlreadyThere()) {
      warn("dbt", `Nedlasting feilet (${err.message}).`, "Den eksisterende dbt-eksporten brukes videre – sjekk datoen i appen.");
    } else {
      warn("dbt", `Fikk ikke lastet ned dbt-metadata: ${err.message}`, dbtHint);
    }
  }
}

// ── Summary ────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => r.state === "fail");
const warned = results.filter((r) => r.state === "warn");
heading("Oppsummering");
if (!failed.length && !warned.length) {
  console.log(`${c.green}Alt klart.${c.off}`);
} else {
  for (const r of [...failed, ...warned]) console.log(`  ${r.state === "fail" ? c.red + "✖" : c.yellow + "!"}${c.off} ${r.note}`);
}
console.log(
  `\n${c.bold}Start appen:${c.off}\n` +
    `  macOS    dobbeltklikk start.command\n` +
    `  Windows  dobbeltklikk start.bat\n` +
    `  terminal cd app && npm run dev      ${c.dim}→ http://localhost:5178${c.off}\n`,
);
process.exit(failed.length ? 1 : 0);
