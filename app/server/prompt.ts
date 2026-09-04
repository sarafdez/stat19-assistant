import fs from "node:fs";
import { RULES_FILE } from "./paths.ts";
import { listDbtSources } from "./sources/dbt.ts";
import { listWikiPages } from "./sources/wiki.ts";
import type { SnapshotStatus } from "./status.ts";

/**
 * App-specific half of the system prompt: identity, house style and the tool workflow.
 * The faglige rules live in regler.md at the repo root, so the app and CLAUDE.md share one
 * copy instead of drifting apart — see readDomainRules(). Keep this byte-identical between
 * requests so the prompt cache holds; volatile facts (snapshot dates) go in a trailing block.
 */
const APP_RULES = `Du er Stat19-assistenten for et statistikkteam på Folkehelseinstituttet (FHI).
Du hjelper teamlederen med å vurdere nye prosjekter/kunnskapsoppdrag mot Stat19, foreslå
dataprodukter og variabler, og skrive statistikkprotokoll.

Svar alltid på norsk bokmål. Vær konkret og kortfattet; bruk punktlister der det passer.

STIL
- Ikke fortell hva du skal gjøre. Kall verktøyet uten å kommentere det først. Grensesnittet viser
  brukeren hvilke oppslag du gjør, så «Jeg skal hente…», «La meg nå se på…», «Nå skal jeg sjekke…»
  er bare støy.
- Ikke kommenter din egen framdrift eller egne mellomresultater: ingen «Bra start», «Utmerket»,
  «Perfekt», «Flott», «Nå har jeg grunnlaget», «La meg lage en oppsummering».
- Start svaret direkte med innholdet. Ingen innledning om hva svaret kommer til å inneholde.
- Skriv tett: korte avsnitt, punktlister, tabeller der det passer. Ingen oppsummering til slutt som
  gjentar det du nettopp skrev.

VERKTØY (reglene under GRUNNLAGET sier hva du skal slå opp; dette er hvordan)
- Wiki: du har hele sidelista under ALLE WIKI-SIDER. Vet du hvilken side du trenger – f.eks.
  kildesiden til et dataprodukt, Juridisk, eller en bestemt Team-protokoll – kall read_wiki_page
  direkte med id-en derfra. Bruk search_wiki når du ikke vet hvilken side det er, eller når du
  leter etter et ord på tvers av sider (section='Dataprodukter' avgrenser til kildesidene).
  Send alltid med query til read_wiki_page – store sider kommer som utdrag, og query velger
  avsnittene. Mangler du noe, kall igjen med sections=['nr']; full=true bare når du faktisk
  trenger hele siden.
- dbt: search_dbt finner dataproduktet; get_dbt_source gir hele kolonnelista. Søket ser bare
  kolonnenavn og de beskrivelsene som finnes (de fleste kolonner er udokumentert i dbt), så et
  søk på «ventetid» finner ikke ansienDato. Har du funnet dataproduktet, hent kolonnelista med
  get_dbt_source før du oppgir variabelnavn eller sier at en variabel ikke finnes. Begge dekker
  kun 'sources' – team-views er utelatt.
- Sier et søk «SVAKE TREFF» eller «Ingen treff», betyr det «jeg finner det ikke i snapshotet» –
  ikke «det finnes ikke i Stat19». Skill mellom de to i svaret, slik reglene krever.
- Protokollmalen: get_protocol_template.
- Lenk til kildene i svaret. Skriv wiki-sider som [tittel](wiki:<side-id>) og dataprodukter som
  [navn](dbt:<dbt-id>) – f.eks. [NPR](wiki:Dataprodukter-i-Stat19/NPR.md) og
  [npr_som_hoved](dbt:source.fida.npr.npr_som_hoved). Bruk id-en ordrett slik verktøyet ga den, og
  lenk første gang du nevner en side eller et dataprodukt. Panelene til høyre åpner ingenting av
  seg selv – brukeren klikker lenka i svaret for å se siden.`;

/**
 * The shared faglige rules, read from disk once and memoised. A missing or truncated file is a
 * hard error rather than a silently rules-free system prompt — buildSystem() runs inside the
 * request try/catch, so the message reaches the chat window while the panels keep working.
 */
let domainRules: string | null = null;

function readDomainRules(): string {
  if (domainRules !== null) return domainRules;
  let text: string;
  try {
    text = fs.readFileSync(RULES_FILE, "utf8").trim();
  } catch (err) {
    throw new Error(
      `Fant ikke de faglige reglene i ${RULES_FILE} (${(err as Error).message}). ` +
        `Fila ligger i repoet ved siden av CLAUDE.md – hent den tilbake med « git checkout regler.md ».`,
    );
  }
  if (text.length < 1000) {
    throw new Error(`${RULES_FILE} er tom eller avkortet (${text.length} tegn) – systemprompten mangler reglene.`);
  }
  domainRules = text;
  return text;
}

/** True when the rules file is readable — used by the startup check in index.ts. */
export function rulesStatus(): { ok: boolean; error: string | null; chars: number } {
  try {
    const text = readDomainRules();
    return { ok: true, error: null, chars: text.length };
  } catch (err) {
    return { ok: false, error: (err as Error).message, chars: 0 };
  }
}

/**
 * The full list of wiki pages, so the model can go straight to read_wiki_page instead of
 * discovering pages by search. The dbt half has always had its catalogue here; the wiki did
 * not, which is why wiki lookups depended entirely on ranking — and why a protocol page that
 * merely repeats a term could outrank the source page that documents it.
 *
 * Regenerated on every request from the loaded snapshot, so a wiki pull shows up immediately.
 * Ids only: they are readable, and they are what read_wiki_page needs. Adding titles as well
 * would roughly double the cost for very little the id does not already say.
 */
function wikiIndex(): string {
  const pages = listWikiPages();
  if (!pages.length) return "Ingen wiki-sider er lastet — si at wiki-klonen mangler.";
  const bySection = new Map<string, string[]>();
  for (const page of pages) {
    const section = page.breadcrumb[0] ?? "(rot)";
    bySection.set(section, [...(bySection.get(section) ?? []), page.id]);
  }
  return [...bySection.entries()]
    .map(([section, ids]) => `${section}:\n  ${ids.join("\n  ")}`)
    .join("\n");
}

/** Compact catalogue so the model knows what exists before it starts searching. */
function dbtCatalogue(): string {
  const sources = listDbtSources();
  if (!sources.length) return "Ingen dbt-metadata er lastet — si at variabelnavn er uverifiserte.";
  const byRegister = new Map<string, string[]>();
  for (const s of sources) {
    const line = `${s.name} (${s.columns.length} kolonner)${s.description ? " – " + s.description.split("\n")[0].slice(0, 110) : ""}`;
    byRegister.set(s.register, [...(byRegister.get(s.register) ?? []), line]);
  }
  return [...byRegister.entries()]
    .map(([register, tables]) => `${register}:\n  - ${tables.join("\n  - ")}`)
    .join("\n");
}

function norwegianDate(iso: string | null): string {
  if (!iso) return "ukjent";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "ukjent" : d.toLocaleDateString("nb-NO");
}

export function buildSystem(status: SnapshotStatus): Array<{
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}> {
  return [
    { type: "text", text: `${APP_RULES}\n\n${readDomainRules()}` },
    {
      type: "text",
      text:
        `ALLE WIKI-SIDER (${listWikiPages().length} sider i snapshotet). Vet du hvilken side du ` +
        `trenger, kall read_wiki_page direkte med id-en herfra – du behøver ikke søke først. ` +
        `search_wiki er for når du IKKE vet hvilken side det er.\n${wikiIndex()}`,
    },
    {
      type: "text",
      text: `TILGJENGELIGE DATAPRODUKTER (dbt 'sources' – det som kan bestilles)\n${dbtCatalogue()}`,
      // Cache breakpoint: everything above this is stable between requests.
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text:
        `SNAPSHOT-STATUS (nevn dette hvis brukeren spør om hvor ferske opplysningene er)\n` +
        `- Wiki: ${status.wiki.pages} sider, sist endret ${norwegianDate(status.wiki.lastEdited)}` +
        `${status.wiki.stale ? " (utdatert – foreslå git pull)" : ""}\n` +
        `- dbt: ${status.dbt.sources} dataprodukter, dokumentasjon bygget ${norwegianDate(status.dbt.builtAt)}` +
        `${status.dbt.stale ? " (utdatert – bør lastes ned på nytt fra jobb-PC)" : ""}` +
        `${status.dbt.error ? `\n- Feil: ${status.dbt.error}` : ""}`,
    },
  ];
}
