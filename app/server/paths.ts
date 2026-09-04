import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repo root = the folder holding CLAUDE.md, regler.md and the default snapshot folders. */
export const ROOT = path.resolve(here, "..", "..");

/**
 * The two snapshots default to the repo root but can live anywhere — a shared OneDrive folder,
 * an external drive, a path colleagues keep in sync themselves. Set STAT19_WIKI_DIR /
 * STAT19_DBT_DIR in .env, absolute or relative to the repo root.
 *
 * NOTE: env.ts must have loaded .env before this module is evaluated.
 */
function snapshotDir(envVar: string, fallback: string): string {
  const configured = process.env[envVar]?.trim();
  if (!configured) return path.join(ROOT, fallback);
  const expanded = configured.startsWith("~")
    ? path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", configured.slice(1))
    : configured;
  return path.resolve(ROOT, expanded);
}

export const WIKI_DIR = snapshotDir("STAT19_WIKI_DIR", "Stat19.wiki");
export const DBT_DIR = snapshotDir("STAT19_DBT_DIR", "dbt");
export const WIKI_ATTACHMENTS = path.join(WIKI_DIR, ".attachments");
/** Shared domain rules — the source of truth for the system prompt (also imported by CLAUDE.md). */
export const RULES_FILE = path.join(ROOT, "regler.md");
export const ENV_FILE = path.join(ROOT, ".env");
export const MANIFEST = path.join(DBT_DIR, "manifest.json");
export const CATALOG = path.join(DBT_DIR, "catalog.json");
export const PORT = Number(process.env.PORT ?? 5179);

/** Shown in the startup report, so a wrong override is visible instead of looking like missing data. */
export function describePaths(): string[] {
  const label = (dir: string, envVar: string) =>
    `${dir}${process.env[envVar] ? ` (fra ${envVar})` : ""}${fs.existsSync(dir) ? "" : " – finnes ikke"}`;
  return [`wiki: ${label(WIKI_DIR, "STAT19_WIKI_DIR")}`, `dbt:  ${label(DBT_DIR, "STAT19_DBT_DIR")}`];
}
