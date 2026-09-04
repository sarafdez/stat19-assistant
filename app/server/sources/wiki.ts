import fs from "node:fs";
import path from "node:path";
import MiniSearch from "minisearch";
import { WIKI_DIR } from "../paths.ts";
import { fold, parseQuery } from "./norsk.ts";

export type WikiHit = {
  id: string;
  title: string;
  breadcrumb: string[];
  /** 0-1, relative to the best-scoring page for this query. */
  score: number;
  /** Raw MiniSearch score, kept for debugging and the eval harness. */
  raw: number;
  snippet: string;
};

export type WikiSearchResult = {
  hits: WikiHit[];
  verdict: "ok" | "weak" | "empty-query";
  dropped: string[];
};

/**
 * MiniSearch scores are unbounded and grow with the number of query terms, so a long nonsense
 * query used to outscore a precise one. Ranking relative to the top hit makes the shape of the
 * result set legible: one clear winner, or a flat field of weak matches that is really a miss.
 */
const RELATIVE_FLOOR = 0.35;
/**
 * A top hit this weak in absolute terms means the query found nothing real. Calibrated against
 * the fixture: the weakest genuine question ("tilgang") scores 23, while a query whose only
 * purchase on the corpus is an incidental place name ("boligpriser i Oslo") scores 8.
 */
const ABSOLUTE_FLOOR = 14;

type Page = {
  id: string;
  title: string;
  breadcrumb: string[];
  headings: string;
  body: string;
};

const pages = new Map<string, Page>();
let index: MiniSearch<Page> | null = null;
let loadError: string | null = null;

/**
 * Azure DevOps wiki filenames use `-` for spaces and percent-encode punctuation
 * (`%3A` = ":", `%2D` = a literal hyphen). Decode in that order.
 */
function prettify(segment: string): string {
  const spaced = segment.replace(/\.md$/, "").replace(/-/g, " ");
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced;
  }
}

/** Drop wiki macros and code fences so they don't pollute the search index. */
function indexableText(markdown: string): string {
  return markdown
    .replace(/\[\[_TOC_\]\]|\[\[_TOSP_\]\]/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<[^>]+>/g, " ");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === ".attachments") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

export function loadWiki(): void {
  pages.clear();
  loadError = null;
  if (!fs.existsSync(WIKI_DIR)) {
    loadError = `Fant ikke wiki-klonen på ${WIKI_DIR}`;
    index = null;
    return;
  }
  for (const file of walk(WIKI_DIR)) {
    const id = path.relative(WIKI_DIR, file);
    const raw = fs.readFileSync(file, "utf8");
    const text = indexableText(raw);
    pages.set(id, {
      id,
      title: prettify(path.basename(id)),
      breadcrumb: path.dirname(id) === "." ? [] : path.dirname(id).split(path.sep).map(prettify),
      headings: [...text.matchAll(/^#{1,4}\s+(.+)$/gm)].map((m) => m[1]).join(" · "),
      body: text,
    });
  }
  index = new MiniSearch<Page>({
    fields: ["title", "headings", "body"],
    storeFields: ["title", "breadcrumb"],
    // Fold ø/å so a query typed either way reaches the same terms, exactly as dbt search does.
    processTerm: (term) => (term.length < 2 ? null : fold(term)),
    searchOptions: {
      prefix: true,
      // Fuzzy only on long terms: at 0.2 a five-letter word tolerates one edit, which is how
      // "månen" matched "måned" and gave a nonsense query a confident hit.
      fuzzy: (term) => (term.length >= 8 ? 0.2 : false),
      boost: { title: 4, headings: 2 },
    },
  });
  index.addAll([...pages.values()]);
}

function snippetFor(body: string, query: string): string {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const lower = body.toLowerCase();
  let at = -1;
  for (const term of terms) {
    at = lower.indexOf(term);
    if (at !== -1) break;
  }
  const start = at === -1 ? 0 : Math.max(0, at - 120);
  return (start > 0 ? "…" : "") + body.slice(start, start + 320).replace(/\s+/g, " ").trim() + "…";
}

export function searchWikiDetailed(query: string, limit = 8): WikiSearchResult {
  if (!index || !query.trim()) return { hits: [], verdict: "empty-query", dropped: [] };
  const { terms, expansions, dropped } = parseQuery(query);
  if (!terms.length && !expansions.length) return { hits: [], verdict: "empty-query", dropped };

  // Stopwords are gone from the query itself, so function words no longer contribute score.
  // Synonyms are searched too, but weighted down so a page using the actual word still wins.
  const results = index.search(
    { combineWith: "OR", queries: [...terms, ...expansions.map((e) => ({ queries: [e], boost: { body: 0.5 } }))] },
    { combineWith: "OR" },
  );
  if (!results.length) return { hits: [], verdict: "weak", dropped };

  // A long protocol page that says "smittsomme sykdommer" twenty times outranks the short
  // source page that actually documents MSIS, because term frequency dominates. regler.md
  // makes the source pages the canonical description of a dataprodukt, so encode that as a
  // mild prior rather than letting raw frequency decide.
  const SOURCE_PAGE_PRIOR = 1.6;
  for (const r of results) {
    if (String(r.id).startsWith("Dataprodukter-i-Stat19")) r.score *= SOURCE_PAGE_PRIOR;
  }
  results.sort((a, b) => b.score - a.score);

  const top = results[0].score;
  const all: WikiHit[] = results.slice(0, Math.max(limit, 8)).map((r) => {
    const page = pages.get(String(r.id))!;
    return {
      id: page.id,
      title: page.title,
      breadcrumb: page.breadcrumb,
      score: Math.round((r.score / top) * 100) / 100,
      raw: Math.round(r.score * 100) / 100,
      snippet: snippetFor(page.body, [...terms, ...expansions].join(" ")),
    };
  });

  if (top < ABSOLUTE_FLOOR) return { hits: all.slice(0, 3), verdict: "weak", dropped };
  const confident = all.filter((h) => h.score >= RELATIVE_FLOOR).slice(0, limit);
  return { hits: confident, verdict: "ok", dropped };
}

/** Back-compatible shape for the browser panel, which just wants a ranked list. */
export function searchWiki(query: string, limit = 8): WikiHit[] {
  return searchWikiDetailed(query, limit).hits;
}

export function getWikiPage(id: string): { id: string; title: string; breadcrumb: string[]; markdown: string } {
  const full = path.resolve(WIKI_DIR, id);
  if (!full.startsWith(WIKI_DIR + path.sep)) throw new Error("Ugyldig sidebane");
  if (!fs.existsSync(full)) throw new Error(`Fant ikke wiki-siden: ${id}`);
  const page = pages.get(path.relative(WIKI_DIR, full));
  return {
    id: path.relative(WIKI_DIR, full),
    title: page?.title ?? prettify(path.basename(full)),
    breadcrumb: page?.breadcrumb ?? [],
    markdown: fs.readFileSync(full, "utf8"),
  };
}

export type WikiEntry = { id: string; title: string; breadcrumb: string[]; section: string };

/** Full page list for browsing the wiki without searching. */
export function listWikiPages(): WikiEntry[] {
  return [...pages.values()]
    .map((p) => ({
      id: p.id,
      title: p.title,
      breadcrumb: p.breadcrumb,
      section: p.breadcrumb[0] ?? p.title,
    }))
    .sort((a, b) => a.section.localeCompare(b.section, "nb") || a.title.localeCompare(b.title, "nb"));
}

export function wikiStats() {
  return { pages: pages.size, error: loadError };
}

// --- Excerpting for the model -------------------------------------------------
// Whole pages are the main input-token cost (SykehusEPJ.md alone is ~7k tokens),
// so the model gets relevant sections plus an outline of the rest, and asks for
// more by section number. The browser panel still gets the full page.

const SMALL_PAGE = 4_000; // below this, excerpting saves nothing
const EXCERPT_BUDGET = 8_000; // chars of section text per read
const FULL_PAGE_CAP = 60_000;
const INTRO_CAP = 1_200;
/** Sections the wiki convention puts caveats in — always worth including. */
const ALWAYS = /begrensning|dekning|kvalitet|viktig|oppdater|periode|historikk/i;

type Section = { index: number; level: number; heading: string | null; text: string };

function splitSections(markdown: string): Section[] {
  const lines = markdown.split("\n");
  const sections: Section[] = [];
  let current: Section = { index: 0, level: 0, heading: null, text: "" };
  for (const line of lines) {
    const match = /^(#{1,4})\s+(.+?)\s*$/.exec(line);
    if (match) {
      if (current.text.trim() || current.heading) sections.push(current);
      current = {
        index: sections.length + 1,
        level: match[1].length,
        heading: match[2].replace(/<[^>]+>/g, "").trim(),
        text: "",
      };
    } else {
      current.text += line + "\n";
    }
  }
  if (current.text.trim() || current.heading) sections.push(current);
  return sections.map((sec, i) => ({ ...sec, index: i + 1 }));
}

function size(n: number): string {
  return n >= 1000 ? `${Math.round(n / 100) / 10}k tegn` : `${n} tegn`;
}

function scoreSection(section: Section, terms: string[]): number {
  const heading = (section.heading ?? "").toLowerCase();
  const body = section.text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (heading.includes(term)) score += 6;
    const hits = body.split(term).length - 1;
    score += Math.min(hits, 5);
  }
  return score;
}

export type PageRead = {
  id: string;
  title: string;
  mode: "hel side" | "utdrag";
  returned: number;
  total: number;
  text: string;
};

/** Read a page for the model: whole page, named sections, or a relevant excerpt. */
export function readWikiPageForModel(
  id: string,
  opts: { query?: string; sections?: string[]; full?: boolean } = {},
): PageRead {
  const page = getWikiPage(id);
  const header = `${page.title} (${page.breadcrumb.join(" / ") || "rot"}) — ${page.id}`;
  const all = splitSections(page.markdown);

  const whole = (why: PageRead["mode"]): PageRead => ({
    id: page.id,
    title: page.title,
    mode: why,
    returned: all.length,
    total: all.length,
    text: `${header}\n\n${page.markdown.slice(0, FULL_PAGE_CAP)}`,
  });

  if (opts.full || page.markdown.length <= SMALL_PAGE || all.length <= 1) return whole("hel side");

  let chosen: Section[];
  if (opts.sections?.length) {
    const wanted = opts.sections.map((w) => w.trim().toLowerCase());
    chosen = all.filter(
      (sec) =>
        wanted.includes(String(sec.index)) ||
        wanted.some((w) => w.length > 2 && (sec.heading ?? "").toLowerCase().includes(w)),
    );
    if (!chosen.length) chosen = all.slice(0, 3);
  } else {
    const terms = (opts.query ?? "").toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    const intro = all.filter((sec) => sec.heading === null);
    const always = all.filter((sec) => sec.heading && ALWAYS.test(sec.heading));
    const ranked = all
      .filter((sec) => !intro.includes(sec) && !always.includes(sec))
      .map((sec) => ({ sec, score: scoreSection(sec, terms) }))
      .sort((a, b) => b.score - a.score)
      .filter((entry) => (terms.length ? entry.score > 0 : true))
      .map((entry) => entry.sec);

    chosen = [];
    let budget = EXCERPT_BUDGET;
    for (const sec of [...intro, ...always, ...ranked]) {
      const cost = sec.heading === null ? Math.min(sec.text.length, INTRO_CAP) : sec.text.length;
      if (chosen.length && cost > budget) continue;
      chosen.push(sec);
      budget -= cost;
      if (budget <= 0) break;
    }
    chosen.sort((a, b) => a.index - b.index);
  }

  if (chosen.length === all.length) return whole("hel side");

  const outline = all
    .map((sec) => {
      const mark = chosen.includes(sec) ? " ← med her" : "";
      const label = sec.heading ? `${"#".repeat(sec.level)} ${sec.heading}` : "(innledning)";
      return `  ${String(sec.index).padStart(2)}  ${label} (${size(sec.text.length)})${mark}`;
    })
    .join("\n");

  const bodies = chosen
    .map((sec) => {
      const label = sec.heading ? `${"#".repeat(sec.level)} ${sec.heading}` : "(innledning)";
      const text = sec.heading === null ? sec.text.slice(0, INTRO_CAP) : sec.text;
      return `--- ${sec.index}. ${label} ---\n${text.trim()}`;
    })
    .join("\n\n");

  return {
    id: page.id,
    title: page.title,
    mode: "utdrag",
    returned: chosen.length,
    total: all.length,
    text:
      `${header}\nUTDRAG: ${chosen.length} av ${all.length} avsnitt. ` +
      `Trenger du mer, kall read_wiki_page igjen med sections=["nr"] eller full=true.\n\n` +
      `AVSNITT PÅ SIDEN:\n${outline}\n\n${bodies}`,
  };
}
