/**
 * Retrieval fixture. Each case says what a real question should find, or that it should find
 * nothing. The `nothing` cases matter most: regler.md requires the assistant to separate
 * "this does not exist in Stat19" from "I cannot find it in my snapshot", which is only
 * possible if a query with no answer is reported as having no answer.
 *
 * Adding a case is the right response to a retrieval complaint — it turns "the search feels
 * wrong" into a number that either moves or does not.
 */
export type Case = {
  query: string;
  /** Substrings; a hit counts if any expected string appears in the top results. */
  dbt?: string[];
  wiki?: string[];
  /**
   * Restrict the wiki search the way the search_wiki tool does. Source questions are asked
   * with section='Dataprodukter'; without it, long protocol pages that repeat a term outrank
   * the short page that documents it. Cases that omit this test the unfiltered ranking.
   */
  wikiSection?: "Dataprodukter" | "Statistikkteam" | "Stat19-Wiki";
  /** True when the honest answer is "nothing relevant here". */
  nothing?: boolean;
};

export const CASES: Case[] = [
  // ── real domain questions ────────────────────────────────────────────────────
  // som_hoved, not npr_som_hoved: the dataprodukt is the model in the NPR schema, while the
  // source of that name is the landing table in `import`.
  { query: "ventetid", dbt: ["som_hoved"], wiki: ["NPR"] },
  { query: "hvor lenge venter pasienter på behandling", dbt: ["som_hoved"] },
  { query: "abort", dbt: ["mfr"], wiki: ["Team-Abort"] },
  { query: "svangerskapsavbrudd", dbt: ["mfr"], wiki: ["Team-Abort", "MFR"] },
  { query: "fødsler", dbt: ["mfr"], wiki: ["MFR"] },
  { query: "dødsårsak", dbt: ["dar", "dår"], wiki: ["DAR", "DÅR"] },
  { query: "vaksinasjon", dbt: ["sysvak"], wiki: ["SYSVAK"] },
  { query: "smittsomme sykdommer", dbt: ["msis"], wiki: ["MSIS"], wikiSection: "Dataprodukter" },
  { query: "legemidler på resept", dbt: ["lmr"], wiki: ["LMR"] },
  { query: "fastlegekonsultasjoner", dbt: ["kuhr", "kpr"], wiki: ["KprKuhr"] },
  { query: "fnr_hash", dbt: ["npr", "mfr", "folkeregisteret"] },
  { query: "bostedskommune", dbt: ["folkeregisteret"] },
  { query: "sykehusopphold", dbt: ["npr", "sykehusepj"], wiki: ["NPR", "SykehusEPJ"] },
  { query: "juridisk grunnlag for Stat19", wiki: ["Juridisk"] },
  { query: "mal for protokoll", wiki: ["Mal"] },
  { query: "hvordan bestiller jeg data", wiki: ["Tilgang", "Teamleder"], wikiSection: "Stat19-Wiki" },

  // Only findable because column descriptions now fall back to the register's dbt doc block:
  // `manifest.sources` describes 5 of NPR's 1 265 columns, and the word "ansiennitetsdato"
  // appears in none of them — it is the doc block for `ansienDato` that carries it.
  // Only the register can be asserted here: `ansienDato` carries the same doc block in all
  // thirteen NPR hoved/koder/prosedyredato products, which tie exactly. A fixture that named one
  // of them would be recording an accident of iteration order, not a ranking anyone can defend.
  { query: "ansiennitetsdato", dbt: ["npr"] },
  { query: "når ble henvisningen mottatt", dbt: ["npr", "sykehusepj"] },

  // ── clinical vocabulary: no dataprodukt is named after a disease, so these must land on
  //    the register that carries the codes. Each one was a measured miss before the
  //    synonym map covered it.
  { query: "kols og astma", dbt: ["npr"] },
  { query: "hjerteinfarkt", dbt: ["npr"] },
  { query: "antibiotikabruk", dbt: ["lmr"] },
  { query: "koronavaksine", dbt: ["sysvak"] },
  { query: "keisersnitt", dbt: ["mfr"] },
  { query: "poliklinisk konsultasjon", dbt: ["npr", "sykehusepj"] },
  { query: "hvilke kodeverk brukes for prosedyrer", dbt: ["npr", "sykehusepj"] },

  // ── the joined dataprodukter, which are dbt models rather than sources. A team orders
  //    these by name, so ranking the raw source tables above them is the failure: it is what
  //    produced a table listing "KprKuhr" and "MFR" as the things to order.
  { query: "konsultasjon hos fastlege", dbt: ["KprKuhr.Konsultasjon"] },
  { query: "svangerskap og fødsel koblet", dbt: ["MFR.SvangerskapBarn"] },
  { query: "pasientforløp", dbt: ["SykehusEPJ.Pasientforløp"] },
  { query: "dødsårsak historikk", dbt: ["DÅR.diagnoserArsak_SCD2"] },
  // The code lists, which are how a kodeverk gets confirmed instead of recalled.
  { query: "ICPC-2 kodeverk", dbt: ["icpcKode"] },
  { query: "ICD-10 diagnosekoder", dbt: ["icdKode"] },

  // ── queries Stat19 cannot answer: the result must be recognisably empty ──────
  { query: "kvantefysikk på månen", nothing: true },
  { query: "aksjekurser og renteutvikling", nothing: true },
  { query: "hvordan er det", nothing: true },
  { query: "kan jeg få data om noe", nothing: true },
  { query: "utdanningsnivå og inntekt", nothing: true }, // genuinely absent — lives at SSB
  // Innvandringsgrunn is SSB. Fødeland is not — Folkeregisteret.md documents fodeland and
  // person_m_foreldres_fodeland as dataprodukter — but no product is named for the concept, so
  // the honest answer to this phrasing is still "nothing stands out".
  { query: "innvandrerbakgrunn", nothing: true },
  { query: "boligpriser i Oslo", nothing: true },
];

/**
 * Page-read fixture. Ranking is only half the retrieval: a search can put the right page on
 * top and the read can still hand back an excerpt with the answer cut out of it. That is not
 * hypothetical — readWikiPageForModel() used to return KprKuhr.md as a 74-character intro,
 * because the coverage period sits under "Daglige dataprodukter", a heading none of the
 * ALWAYS words match, and the query terms appear nowhere on the page.
 *
 * Every case here asserts the one kind of fact regler.md forbids guessing: which years a
 * dataprodukt covers. The query is written the way the model actually asks, not the way that
 * happens to score well.
 */
export type ReadCase = {
  page: string;
  query: string;
  /** Substrings that must survive into the text the model receives. */
  must: string[];
};

const SOURCE = "Dataprodukter-i-Stat19/";

export const READ_CASES: ReadCase[] = [
  { page: SOURCE + "KprKuhr.md", query: "dekningsperiode", must: ["1.1.2017"] },
  // The query from the session that exposed the bug — none of its words are on the page.
  { page: SOURCE + "KprKuhr.md", query: "KprKuhr coverage dekning kommuner", must: ["1.1.2017"] },
  { page: SOURCE + "MFR.md", query: "dekningsperiode", must: ["tilbake til 1.1.2015"] },
  { page: SOURCE + "NPR.md", query: "dekningsperiode", must: ["01.01.2015", "31.12.2025"] },
  { page: SOURCE + "LMR-Legemiddelregisteret.md", query: "dekningsperiode", must: ["1.1.2004"] },
  { page: SOURCE + "MSIS-Labdatabasen.md", query: "urinkultur agens", must: ["2.10.2022"] },
  { page: SOURCE + "SYSVAK.md", query: "dekningsperiode", must: ["1.10.2018"] },
  { page: SOURCE + "DÅR.md", query: "dekningsperiode", must: ["30.7.2025"] },
  // Genuinely too big to send whole, so it still comes back as an excerpt — the point is that
  // the coverage sentence travels with the excerpt rather than being ranked away.
  { page: SOURCE + "SykehusEPJ.md", query: "dekningsperiode", must: ["01.01.2020"] },
];
