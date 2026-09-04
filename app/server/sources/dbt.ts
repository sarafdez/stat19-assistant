import fs from "node:fs";
import { CATALOG, MANIFEST } from "../paths.ts";
import { matchesWord, parseQuery } from "./norsk.ts";

export type DbtColumn = {
  /** Name as SQL Server presents it (catalog.json), which is what analysts see. */
  name: string;
  /** dbt's own lowercase name, when it differs — dbt code is lowercase, SQL Server PascalCase. */
  codeName: string | null;
  type: string | null;
  description: string;
};
export type DbtSource = {
  id: string;
  register: string;
  name: string;
  label: string;
  schema: string;
  identifier: string;
  description: string;
  registerDescription: string;
  columns: DbtColumn[];
};

let sources = new Map<string, DbtSource>();
let generatedAt: string | null = null;
let loadError: string | null = null;

/**
 * Only `manifest.sources` matters: those are the dataprodukter (source.fida.<register>.<table>).
 * `manifest.nodes` holds the per-team views, which CLAUDE.md says to ignore.
 * catalog.json supplies the real SQL types.
 */
export function loadDbt(): void {
  sources = new Map();
  generatedAt = null;
  loadError = null;
  try {
    if (!fs.existsSync(MANIFEST)) {
      loadError = `Ingen dbt-metadata i ${MANIFEST}. Last ned manifest.json og catalog.json på jobb-PC.`;
      return;
    }
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
    const catalog = fs.existsSync(CATALOG) ? JSON.parse(fs.readFileSync(CATALOG, "utf8")) : { sources: {} };
    generatedAt = manifest?.metadata?.generated_at ?? null;

    for (const [id, node] of Object.entries<any>(manifest.sources ?? {})) {
      const catColumns: Record<string, any> = catalog.sources?.[id]?.columns ?? {};
      const docColumns: Record<string, any> = node.columns ?? {};
      // dbt documents columns in lowercase; the catalog reports SQL Server's casing.
      // Join case-insensitively, or the same column shows up twice.
      const docByLower = new Map(Object.entries(docColumns).map(([k, v]) => [k.toLowerCase(), { key: k, value: v }]));
      const merged: DbtColumn[] = [];
      const seen = new Set<string>();
      for (const [catName, catValue] of Object.entries(catColumns)) {
        const doc = docByLower.get(catName.toLowerCase());
        seen.add(catName.toLowerCase());
        merged.push({
          name: catName,
          codeName: doc && doc.key !== catName ? doc.key : null,
          type: catValue?.type ?? null,
          description: (doc?.value?.description ?? "").trim(),
        });
      }
      for (const [lower, doc] of docByLower) {
        if (seen.has(lower)) continue;
        merged.push({ name: doc.key, codeName: null, type: null, description: (doc.value?.description ?? "").trim() });
      }
      sources.set(id, {
        id,
        register: node.source_name,
        name: node.name,
        label: `${node.source_name}.${node.name}`,
        schema: node.schema,
        identifier: node.identifier,
        description: (node.description ?? "").trim(),
        registerDescription: (node.source_description ?? "").trim(),
        columns: merged,
      });
    }
  } catch (err) {
    loadError =
      `Kunne ikke lese dbt-metadata (${(err as Error).message}). ` +
      "Hvis filene ligger i OneDrive, kan de være «kun i skyen» – åpne mappen og last dem ned.";
  }
}

export function listDbtSources(): DbtSource[] {
  return [...sources.values()].sort((a, b) => a.label.localeCompare(b.label, "nb"));
}

export function getDbtSource(id: string): DbtSource | null {
  if (sources.has(id)) return sources.get(id)!;
  const needle = id.toLowerCase();
  return (
    listDbtSources().find((s) => s.label.toLowerCase() === needle || s.name.toLowerCase() === needle) ?? null
  );
}

export type DbtHit = {
  id: string;
  label: string;
  register: string;
  description: string;
  matchedColumns: DbtColumn[];
  /** 0-1, relative to the best score this query could plausibly reach. */
  score: number;
  /** Raw points, kept for debugging and the eval harness. */
  raw: number;
};

export type DbtSearchResult = {
  hits: DbtHit[];
  /** Why there is nothing worth showing — lets the caller say so instead of listing noise. */
  verdict: "ok" | "weak" | "empty-query";
  /** Function words stripped from the query. */
  dropped: string[];
};

/**
 * Calibrated against the eval fixture. Once stopwords and word-boundary matching are in place,
 * every query with no counterpart in Stat19 scores raw 0 — the separation comes from matching,
 * not from thresholding. So the floor only has to reject the residue: a single incidental
 * description hit. Real domain terms measured 4.5-31 raw; nonsense measured 0.
 */
const MIN_RAW = 2;
const CONFIDENCE_FLOOR = 0.1;

/**
 * Points per place a term can match. Column hits are capped per term, because a term matching
 * forty columns in one wide table says less than the table name matching — before capping,
 * a 199-column table won every query by sheer width.
 */
const WEIGHTS = { name: 6, register: 4, description: 2, column: 3, columnDescription: 1 };
const MAX_COLUMN_POINTS_PER_TERM = 9;
/** Synonym hits count, but never enough to outrank a page that uses the word itself. */
const EXPANSION_FACTOR = 0.5;

export function searchDbtDetailed(query: string, limit = 10): DbtSearchResult {
  const { terms, expansions, dropped } = parseQuery(query);
  if (!terms.length && !expansions.length) return { hits: [], verdict: "empty-query", dropped };

  const scoreTerm = (source: DbtSource, term: string, matched: DbtColumn[]): number => {
    let points = 0;
    if (matchesWord(source.name, term)) points += WEIGHTS.name;
    if (matchesWord(source.register, term)) points += WEIGHTS.register;
    if (matchesWord(source.description, term)) points += WEIGHTS.description;
    let columnPoints = 0;
    for (const col of source.columns) {
      const onName = matchesWord(col.name, term) || (col.codeName ? matchesWord(col.codeName, term) : false);
      const onDesc = !onName && col.description && matchesWord(col.description, term);
      if (!onName && !onDesc) continue;
      columnPoints += onName ? WEIGHTS.column : WEIGHTS.columnDescription;
      if (!matched.includes(col)) matched.push(col);
    }
    return points + Math.min(columnPoints, MAX_COLUMN_POINTS_PER_TERM);
  };

  const hits: DbtHit[] = [];
  for (const source of sources.values()) {
    const matched: DbtColumn[] = [];
    let raw = 0;
    for (const term of terms) raw += scoreTerm(source, term, matched);
    for (const term of expansions) raw += scoreTerm(source, term, matched) * EXPANSION_FACTOR;
    if (raw > 0) {
      hits.push({
        id: source.id,
        label: source.label,
        register: source.register,
        description: source.description,
        matchedColumns: matched.slice(0, 12),
        score: 0,
        raw,
      });
    }
  }
  if (!hits.length) return { hits: [], verdict: "weak", dropped };

  // Normalise against what this query could have scored: every term hitting a product name
  // plus a full complement of column matches. That makes the number comparable across
  // queries, which raw points never were.
  // Only the real terms set the bar. Expansions add to a hit's score but never to what a
  // perfect score would be — otherwise adding a synonym to the map lowers every score.
  const perfect = Math.max(terms.length, 1) * (WEIGHTS.name + WEIGHTS.register + MAX_COLUMN_POINTS_PER_TERM);
  for (const hit of hits) hit.score = Math.min(1, hit.raw / Math.max(perfect, 1));
  hits.sort((a, b) => b.raw - a.raw);

  const confident = hits.filter((h) => h.score >= CONFIDENCE_FLOOR && h.raw >= MIN_RAW);
  return confident.length
    ? { hits: confident.slice(0, limit), verdict: "ok", dropped }
    : { hits: hits.slice(0, 3), verdict: "weak", dropped };
}

/** Back-compatible shape for the browser panel, which just wants a ranked list. */
export function searchDbt(query: string, limit = 10): DbtHit[] {
  return searchDbtDetailed(query, limit).hits;
}

export function dbtStats() {
  return { sources: sources.size, columns: [...sources.values()].reduce((n, s) => n + s.columns.length, 0), generatedAt, error: loadError };
}
