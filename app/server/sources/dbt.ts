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
  /** Where the description came from: the dataprodukt itself, or the register's dbt doc block. */
  descriptionFrom: "source" | "doc-block" | null;
};
export type DbtSource = {
  id: string;
  /** A dbt `source`, or a `model` dbt files under `data-products`. */
  kind: "source" | "model";
  /**
   * A building block, not something a team orders on its own. Set when dbt's description says
   * so (KPR-KUHR's three, sykehusepj.data_kode), for NPR's landing schema, and for any source
   * table in a register that has data-products when no team view reads it directly. For
   * registers without data-products (lab, LMR, MSIS, Risikogrupper) the source IS the product.
   */
  restricted: boolean;
  register: string;
  name: string;
  label: string;
  schema: string;
  identifier: string;
  description: string;
  registerDescription: string;
  columns: DbtColumn[];
};

/**
 * dbt states which models are dataprodukter, so read it rather than infer it. Every model's
 * `fqn` is ["fida", "beredt-models", <category>, …], and the project has exactly three
 * categories: `data-products` (what a team orders), `preliminary-objects` (the intermediate
 * calculations the wiki calls "hjelpe-views") and `team-views` (one folder per team, with the
 * team name in fqn[3]). Only the first is served here.
 *
 * This replaced two weaker signals. Scanning the wiki for `model.fida.<navn>` links got the
 * shape right but the details wrong: it missed twenty real dataprodukter that no source page
 * happens to link — som_hoved, bup_hoved, vaksinasjoner_kikhoste — and it wrongly included
 * `episodedetaljer_vw`, which SykehusEPJ.md links but dbt files under preliminary-objects (the
 * dataprodukt is `episodedetaljer`). Guessing from the name is worse still: `forløp`,
 * `startAndEndEpisodes` and `distinctEpisodeIntervals` carry no team suffix and are all
 * preliminary, while `diagnoserarsak_scd2` has one and is a dataprodukt.
 */
const DATA_PRODUCTS = "data-products";
const TEAM_VIEWS = "team-views";

/** dbt's standing phrase for a table that is only reachable through a joined dataprodukt. */
const RESTRICTED =
  /gis det normalt ikke tilgang|tilgang til .{0,20}data\w* gis gjennom|i praksis ikke brukes/i;
/**
 * NPR's source tables are the only ones dbt puts in a schema of their own, `import`, and every
 * one of them is rebuilt as a data-product in the `NPR` schema with the same columns —
 * `npr.npr_som_hoved` (import, 199 columns) against `NPR.som_hoved` (NPR, 199 columns). Listing
 * both as orderable shows the same table twice and points teams at the landing copy. Treat the
 * landing schema as a building block.
 *
 * Note this is read off the schema name, not declared the way the model categories are. If a
 * register other than NPR ever lands in `import`, check it before trusting the mark.
 */
const LANDING_SCHEMA = "import";

let sources = new Map<string, DbtSource>();
let generatedAt: string | null = null;
let loadError: string | null = null;

/**
 * Reads three keys and no more: `manifest.sources` (the dataprodukter,
 * source.fida.<register>.<table>), `manifest.docs` (the shared variable descriptions, used only
 * where a dataprodukt describes nothing itself — see describe() below), and `catalog.sources`
 * for the real SQL column names and types. `manifest.nodes` holds the per-team views, which
 * regler.md says to ignore; only the `data-products` models are read from it.
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

    // Column descriptions sit in two places. `manifest.sources` is the authoritative one, but for
    // some registers — NPR worst of all — it is all but empty. The same text lives in dbt's
    // doc blocks (`doc.fida.<register>_<kolonne>`), which dbt resolves onto the team views under
    // `nodes`. The views themselves stay out of scope, but a doc block describes the register's
    // column, not one team's cut of it, so it is fair to read when the dataprodukt says nothing.
    const docBlocks = new Map<string, string>();
    for (const block of Object.values<any>(manifest.docs ?? {})) {
      const text = String(block?.block_contents ?? "").trim();
      if (block?.name && text) docBlocks.set(String(block.name).toLowerCase(), text);
    }
    const describe = (
      register: string,
      column: string,
      own: string,
    ): Pick<DbtColumn, "description" | "descriptionFrom"> => {
      if (own) return { description: own, descriptionFrom: "source" };
      const block = docBlocks.get(`${register}_${column}`.toLowerCase());
      return block ? { description: block, descriptionFrom: "doc-block" } : { description: "", descriptionFrom: null };
    };

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
          ...describe(node.source_name, catName, (doc?.value?.description ?? "").trim()),
        });
      }
      for (const [lower, doc] of docByLower) {
        if (seen.has(lower)) continue;
        merged.push({
          name: doc.key,
          codeName: null,
          type: null,
          ...describe(node.source_name, doc.key, (doc.value?.description ?? "").trim()),
        });
      }
      const ownDescription = (node.description ?? "").trim();
      sources.set(id, {
        id,
        kind: "source",
        restricted:
          RESTRICTED.test(ownDescription) || String(node.schema ?? "").toLowerCase() === LANDING_SCHEMA,
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
    // The data-products. Same column merge, but the register comes from the model's schema
    // (KprKuhr, MFR, SykehusEPJ, DÅR) and the display name from its alias, so a team reads
    // "KprKuhr.Konsultasjon" — the name it orders — rather than a lowercase dbt identifier.
    for (const [id, node] of Object.entries<any>(manifest.nodes ?? {})) {
      if (node?.resource_type !== "model" || node?.fqn?.[2] !== DATA_PRODUCTS) continue;
      const register = String(node.schema ?? "").toLowerCase();
      if (!register) continue;
      const catColumns: Record<string, any> = catalog.nodes?.[id]?.columns ?? {};
      const docColumns: Record<string, any> = node.columns ?? {};
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
          ...describe(register, catName, (doc?.value?.description ?? "").trim()),
        });
      }
      for (const [lower, doc] of docByLower) {
        if (seen.has(lower)) continue;
        merged.push({
          name: doc.key,
          codeName: null,
          type: null,
          ...describe(register, doc.key, (doc.value?.description ?? "").trim()),
        });
      }
      sources.set(id, {
        id,
        kind: "model",
        // A joined dataprodukt is the thing teams order, by definition.
        restricted: false,
        register,
        name: node.alias ?? node.name,
        label: `${node.schema}.${node.alias ?? node.name}`,
        schema: node.schema,
        identifier: node.alias ?? node.name,
        description: (node.description ?? "").trim(),
        registerDescription: "",
        columns: merged,
      });
    }

    // A register that has data-products is ordered through them. Its source tables are then
    // building blocks — SykehusEPJ's normalised Data_Pasient, Data_Tjeneste … — unless a team
    // view reads the table directly, which is dbt's own record that it was handed out
    // (folkeregisteret.person, sysvak.hendelser, sykehusepj.data_enhet). Team views are read
    // for that one fact only; they are still not served.
    const orderedDirectly = new Set<string>();
    for (const node of Object.values<any>(manifest.nodes ?? {})) {
      if (node?.resource_type !== "model" || node?.fqn?.[2] !== TEAM_VIEWS) continue;
      for (const dep of node.depends_on?.nodes ?? []) orderedDirectly.add(dep);
    }
    const registersWithProducts = new Set(
      [...sources.values()].filter((s) => s.kind === "model").map((s) => s.register.toLowerCase()),
    );
    for (const s of sources.values()) {
      if (s.kind === "source" && registersWithProducts.has(s.register.toLowerCase()) && !orderedDirectly.has(s.id)) {
        s.restricted = true;
      }
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
/**
 * Must stay below WEIGHTS.name: a dataprodukt whose own name is the search term is the strongest
 * signal there is, and at a cap of 9 against a name worth 6 it lost to any wide table with three
 * columns mentioning the word. That buried SykehusEPJ.icpcKode — the ICPC-2 code list — under
 * NPR's *_koder tables on "ICPC-2 kodeverk". Capped here rather than by raising `name`, because
 * `name` also sets the perfect score every hit is normalised against: inflating it drags every
 * query's score down and tips borderline-but-real ones into "weak".
 */
const MAX_COLUMN_POINTS_PER_TERM = 5;
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
  // A term that every dataprodukt carries — `fnr_hash` above all — leaves most of the field tied
  // on raw points, and a tie used to be broken by nothing but Map insertion order. Break it on
  // what the team can actually order: a data-product ahead of a source table, and a source that
  // is handed out ahead of one dbt holds back. Ties beyond that stay in snapshot order; NPR's
  // som/bup/phv/tsb products are near-identical, so a query like "ventetid" genuinely cannot
  // separate them and no tie-break should pretend otherwise.
  const rank = new Map(
    [...sources.values()].map((s) => [s.id, s.kind === "model" ? 0 : s.restricted ? 2 : 1] as const),
  );
  hits.sort((a, b) => b.raw - a.raw || (rank.get(a.id) ?? 1) - (rank.get(b.id) ?? 1));

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
