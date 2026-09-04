import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { DBT_DIR, MANIFEST, WIKI_DIR } from "./paths.ts";
import { dbtStats } from "./sources/dbt.ts";
import { wikiStats } from "./sources/wiki.ts";

const run = promisify(execFile);

const STALE_DAYS = { wiki: 7, dbt: 30 };

export type SnapshotStatus = {
  wiki: {
    present: boolean;
    pages: number;
    lastEdited: string | null;
    lastPulled: string | null;
    headSubject: string | null;
    stale: boolean;
    error: string | null;
  };
  dbt: {
    present: boolean;
    sources: number;
    columns: number;
    builtAt: string | null;
    fileTime: string | null;
    stale: boolean;
    error: string | null;
  };
};

function ageDays(iso: string | null): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  return Number.isNaN(then) ? null : (Date.now() - then) / 86_400_000;
}

function mtime(file: string): string | null {
  try {
    return fs.statSync(file).mtime.toISOString();
  } catch {
    return null;
  }
}

export async function getStatus(): Promise<SnapshotStatus> {
  const wiki = wikiStats();
  const dbt = dbtStats();

  let lastEdited: string | null = null;
  let headSubject: string | null = null;
  try {
    const { stdout } = await run("git", ["-C", WIKI_DIR, "log", "-1", "--date=iso-strict", "--format=%cd%x1f%s"]);
    const [date, subject] = stdout.trim().split("\x1f");
    lastEdited = date ?? null;
    headSubject = subject ?? null;
  } catch {
    /* not a git clone, or git unavailable — leave null */
  }

  const lastPulled = mtime(path.join(WIKI_DIR, ".git", "FETCH_HEAD")) ?? mtime(path.join(WIKI_DIR, ".git", "HEAD"));
  const wikiAge = ageDays(lastEdited);
  const dbtAge = ageDays(dbt.generatedAt);

  return {
    wiki: {
      present: wiki.pages > 0,
      pages: wiki.pages,
      lastEdited,
      lastPulled,
      headSubject,
      stale: wikiAge !== null && wikiAge > STALE_DAYS.wiki,
      error: wiki.error,
    },
    dbt: {
      present: dbt.sources > 0,
      sources: dbt.sources,
      columns: dbt.columns,
      builtAt: dbt.generatedAt,
      fileTime: mtime(MANIFEST) ?? mtime(DBT_DIR),
      stale: dbtAge !== null && dbtAge > STALE_DAYS.dbt,
      error: dbt.error,
    },
  };
}

/** `git pull --ff-only` on the wiki clone. Returns git's own output for the UI. */
export async function pullWiki(): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await run("git", ["-C", WIKI_DIR, "pull", "--ff-only"]);
    return { ok: true, output: (stdout + stderr).trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    return { ok: false, output: (e.stdout ?? "") + (e.stderr ?? e.message) };
  }
}
