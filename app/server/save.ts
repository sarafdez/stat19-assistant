import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./paths.ts";

const PROJECTS = path.join(ROOT, "prosjekter");

/**
 * `[tittel](wiki:<id>)` and `[navn](dbt:<id>)` are panel links: they open a page in the app's
 * side panels and mean nothing anywhere else. Flatten them to their label so text destined for
 * a terminal, a file or the wiki carries no broken links. Ordinary links are left alone.
 */
export function flattenPanelLinks(markdown: string): string {
  return markdown.replace(/\[([^\]]+)\]\((?:wiki|dbt):[^)]+\)/g, "$1");
}

/** Filesystem-safe Norwegian slug. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[æå]/g, "a")
    .replace(/ø/g, "o")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "protokollutkast";
}

/**
 * Write a draft into prosjekter/ — the folder CLAUDE.md sets aside for working files.
 * Markdown only, never outside that folder, never overwriting an existing file.
 */
export function saveDraft(name: string, content: string): { path: string; absolute: string } {
  if (!content.trim()) throw new Error("Tomt innhold.");
  const stem = slugify(name);
  const date = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(PROJECTS, { recursive: true });

  let file = path.join(PROJECTS, `${date}-${stem}.md`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(PROJECTS, `${date}-${stem}-${n}.md`);

  const resolved = path.resolve(file);
  if (!resolved.startsWith(PROJECTS + path.sep)) throw new Error("Ugyldig filnavn.");

  fs.writeFileSync(resolved, content.endsWith("\n") ? content : content + "\n", "utf8");
  return { path: path.relative(ROOT, resolved), absolute: resolved };
}
