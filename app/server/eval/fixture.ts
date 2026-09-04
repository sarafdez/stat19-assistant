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
  { query: "ventetid", dbt: ["npr_som_hoved"], wiki: ["NPR"] },
  { query: "hvor lenge venter pasienter på behandling", dbt: ["npr_som_hoved"] },
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

  // ── queries Stat19 cannot answer: the result must be recognisably empty ──────
  { query: "kvantefysikk på månen", nothing: true },
  { query: "aksjekurser og renteutvikling", nothing: true },
  { query: "hvordan er det", nothing: true },
  { query: "kan jeg få data om noe", nothing: true },
  { query: "utdanningsnivå og inntekt", nothing: true }, // genuinely absent — lives at SSB
  { query: "innvandrerbakgrunn", nothing: true }, // fødeland/innvandringsgrunn is SSB, not Stat19
  { query: "boligpriser i Oslo", nothing: true },
];
