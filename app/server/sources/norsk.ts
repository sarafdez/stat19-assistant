/**
 * Norwegian query handling shared by the wiki and dbt search.
 *
 * Both indexes are small (175 pages, 45 dataprodukter) and the corpus is Norwegian prose, so
 * the failure that matters is not missed recall — it is a query scoring well when nothing
 * relevant exists. Before this module, `kvantefysikk på månen` outscored `ventetid` three to
 * one, because `på` substring-matched half the corpus. regler.md requires the assistant to
 * separate "this does not exist in Stat19" from "I cannot find it in my snapshot", and that is
 * impossible unless a weak match can be recognised as weak.
 */

/**
 * Function words and query scaffolding. Deliberately excludes domain words that merely look
 * common (`data`, `dato`, `kode`, `person`) — those carry real signal here.
 */
const STOPWORDS = new Set([
  // pronouns, determiners, conjunctions
  "og", "eller", "men", "som", "det", "den", "de", "dei", "denne", "dette", "disse", "der",
  "en", "ei", "et", "ein", "eit", "jeg", "eg", "du", "vi", "me", "han", "hun", "ho", "dem",
  "seg", "min", "mitt", "sin", "sitt", "vår", "vart", "noe", "noen", "noko", "alle", "alt",
  "ingen", "hver", "hvert", "selv", "sjølv", "samme",
  // question words and modals
  "hva", "kva", "hvem", "kven", "hvor", "kvar", "hvordan", "korleis", "hvorfor", "kvifor",
  "hvilke", "hvilken", "hvilket", "kva", "kan", "kunne", "skal", "skulle", "vil", "ville",
  "må", "matte", "bør", "burde", "har", "hadde", "være", "vere", "er", "var", "blir", "ble",
  "bli", "gjøre", "gjere", "gjør", "få", "får", "fikk", "finnes", "finne", "finner",
  // prepositions and adverbs
  "på", "av", "til", "for", "med", "uten", "utan", "om", "over", "under", "ved", "fra", "frå",
  "etter", "før", "mellom", "hos", "inn", "inni", "ut", "opp", "ned", "her", "der", "nå",
  "også", "bare", "kun", "mye", "mange", "lenge", "lang", "langt", "godt", "bra", "ikke",
  "ikkje", "svært", "veldig", "mer", "meir", "mest", "enn", "så", "sa", "da", "når", "nar",
  "hvis", "dersom", "at", "å", "i", "the", "of", "and",
  // Corpus noise rather than grammar: `data` occurs in 20+ table names and in "dataprodukt",
  // so it ranks everything equally. Dropping it is what makes "kan jeg få data om noe"
  // resolve to an empty query instead of a confident hit on sykehusepj.data_kode.
  "data", "datane", "dataene", "opplysning", "opplysninger", "informasjon", "trenger",
  "onsker", "ønsker", "gjelder", "brukes", "bruke",
]);

/**
 * Domain synonyms, expanded into the query. Deliberately small, hand-written and auditable —
 * a domain expert can read and correct this list, which is not true of an embedding space.
 * Keys and values are matched lowercase; expansion is one level deep, never recursive.
 */
const SYNONYMS: Record<string, string[]> = {
  abort: ["svangerskapsavbrudd", "svangerskapsavbrot", "provosert"],
  svangerskapsavbrudd: ["abort", "provosert"],
  ventetid: ["ventetid", "ansien", "ansiennitet", "frist", "venter", "vurderingsfrist"],
  venter: ["ventetid", "ansien", "frist"],
  ventet: ["ventetid", "ansien", "frist"],
  død: ["dodsfall", "dodsarsak", "mortalitet", "dar"],
  dødsfall: ["dodsarsak", "mortalitet", "dar"],
  dødsårsak: ["dar", "mortalitet"],
  fødsel: ["mfr", "svangerskap", "barn", "fodt"],
  fødsler: ["mfr", "svangerskap", "barn"],
  vaksine: ["sysvak", "vaksinasjon", "immunisering"],
  vaksinasjon: ["sysvak", "vaksine"],
  smitte: ["msis", "smittsom", "utbrudd"],
  legemiddel: ["lmr", "resept", "utlevering", "atc"],
  resept: ["lmr", "legemiddel", "utlevering"],
  fastlege: ["kprkuhr", "kuhr", "allmennlege", "icpc"],
  allmennlege: ["kprkuhr", "kuhr", "fastlege", "icpc"],
  innleggelse: ["opphold", "episode", "somatikk", "npr"],
  sykehus: ["npr", "sykehusepj", "somatikk", "opphold"],
  diagnose: ["icd", "icpc", "kode", "tilstand"],
  prosedyre: ["ncsp", "ncmp", "nkpk", "kode"],
  kreft: ["kreftregisteret", "kreg", "tumor"],
  psykisk: ["psykiatri", "phv", "tsb", "rus"],
  kommune: ["bostedskommune", "geografi", "fylke"],
  alder: ["fodselsar", "fodt", "aldersgruppe"],
  smittsom: ["msis", "smitte", "utbrudd", "infeksjon"],
  sykdom: ["diagnose", "tilstand", "icd"],
  bestille: ["tilgang", "rekvisisjon", "bestilling", "teamleder"],
  bestiller: ["tilgang", "bestilling", "teamleder"],
  bestilling: ["tilgang", "teamleder"],

  // Clinical vocabulary → register vocabulary. There is no per-diagnosis dataprodukt: a
  // question about hjerteinfarkt is answered from ICD-10 codes in NPR's diagnosis columns, so
  // that is where these point. Measured gaps, each with a case in eval/fixture.ts.
  diabetes: ["icd", "diagnose", "npr", "atc"],
  kols: ["icd", "diagnose", "npr"],
  astma: ["icd", "diagnose", "npr"],
  hjerteinfarkt: ["icd", "diagnose", "npr"],
  hjerte: ["icd", "diagnose", "npr"],
  slag: ["icd", "diagnose", "npr"],
  antibiotika: ["lmr", "atc", "utlevering", "legemiddel"],
  antibiotikabruk: ["lmr", "atc", "utlevering"],
  korona: ["covid", "msis", "sysvak"],
  covid: ["msis", "covid19", "sysvak"],
  koronavaksine: ["sysvak", "covid", "vaksinasjon"],
  influensa: ["msis", "sysvak", "lab"],
  keisersnitt: ["mfr", "svangerskap", "ncsp", "forlosning"],
  forlosning: ["mfr", "svangerskap", "barn"],
  reinnleggelse: ["opphold", "episode", "npr"],
  tvang: ["phv", "psykisk", "npr"],
  tvangsinnleggelse: ["phv", "psykisk", "npr"],
  rus: ["tsb", "psykisk", "npr"],
  poliklinikk: ["episode", "kontakt", "npr", "omsorgsniva"],
  poliklinisk: ["episode", "kontakt", "omsorgsniva"],
  dognopphold: ["opphold", "episode", "omsorgsniva"],
  kodeverk: ["icd", "icpc", "ncsp", "ncmp", "nkpk", "kode"],
};

/** Fold Norwegian characters so ø/o and å/a queries reach the same terms. */
export function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/[æ]/g, "ae")
    .replace(/[ø]/g, "o")
    .replace(/[å]/g, "a");
}

export type ParsedQuery = {
  /** Meaningful terms from the query, folded. Empty when the query was only function words. */
  terms: string[];
  /** Synonym expansions, scored lower than a direct hit so they never outrank one. */
  expansions: string[];
  /** Function words removed — reported so a caller can say the query carried no content. */
  dropped: string[];
};

export function parseQuery(query: string): ParsedQuery {
  const raw = query
    .toLowerCase()
    .split(/[^a-zæøåäöü0-9_]+/)
    .filter(Boolean);
  const terms: string[] = [];
  const dropped: string[] = [];
  for (const word of raw) {
    // Single characters carry no signal; `på`/`er` and friends are the noise source.
    if (word.length < 3 || STOPWORDS.has(word)) dropped.push(word);
    else terms.push(fold(word));
  }
  const expansions = new Set<string>();
  for (const word of raw) {
    // Norwegian compounds: "fastlegekonsultasjoner" must still reach the key "fastlege",
    // and "sykehusopphold" the key "sykehus". Exact match first, then longest prefix key.
    const keys = SYNONYMS[word]
      ? [word]
      : Object.keys(SYNONYMS)
          .filter((k) => k.length >= 5 && word.startsWith(k))
          .sort((a, b) => b.length - a.length)
          .slice(0, 1);
    for (const key of keys) {
      for (const syn of SYNONYMS[key] ?? []) {
        const folded = fold(syn);
        if (!terms.includes(folded)) expansions.add(folded);
      }
    }
  }
  return { terms: [...new Set(terms)], expansions: [...expansions], dropped };
}

/**
 * Does `term` occur in `text` as a word rather than as a substring? `includes()` is what let
 * `på` match `påført` and `er` match `registeret`. A trailing-boundary check is deliberately
 * omitted so Norwegian compounds and inflections still match: `ventetid` finds
 * `ventetidSluttDato`, and `abort` finds `aborten`.
 */
export function matchesWord(text: string, term: string): boolean {
  const haystack = fold(text);
  if (occursAsWord(haystack, term)) return true;
  // Norwegian compounds take a linking -s- that the underlying column names often omit:
  // the query says `bostedskommune`, the warehouse column is `BostedKommune_Nummer`. Retry
  // with each internal s-before-consonant dropped. Cheap, and only tried after a real miss.
  for (const variant of dropLinkingS(term)) {
    if (occursAsWord(haystack, variant)) return true;
  }
  return false;
}

function occursAsWord(haystack: string, term: string): boolean {
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(term, from);
    if (at === -1) return false;
    const before = at === 0 ? "" : haystack[at - 1];
    if (!before || !/[a-z0-9]/.test(before)) return true;
    from = at + 1;
  }
}

function dropLinkingS(term: string): string[] {
  const out: string[] = [];
  for (let i = 3; i < term.length - 3; i++) {
    if (term[i] === "s" && /[bcdfghjklmnpqrstvwxz]/.test(term[i + 1] ?? "")) {
      out.push(term.slice(0, i) + term.slice(i + 1));
    }
  }
  return out.slice(0, 3);
}
