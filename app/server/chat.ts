import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { estimateCost, modelParams, resolveEffort, resolveModel } from "./models.ts";
import { buildSystem } from "./prompt.ts";
import { getDbtSource, listDbtSources, searchDbtDetailed } from "./sources/dbt.ts";
import { getWikiPage, listWikiPages, readWikiPageForModel, searchWikiDetailed } from "./sources/wiki.ts";
import { getStatus } from "./status.ts";

export type Attachment =
  | { kind: "pdf"; name: string; base64: string }
  | { kind: "text"; name: string; text: string };

export type ChatTurn = { role: "user" | "assistant"; content: string };

/**
 * Everything the tool loop wants to report, independent of transport. The web server turns
 * these into SSE frames; the CLI prints them to stderr. Keeping one implementation means the
 * two surfaces can never drift apart in which lookups they do or what they return.
 */
export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool"; tool: string; query: string; count?: number }
  | { type: "source"; panel: "wiki" | "dbt"; id: string; title: string; query?: string }
  | { type: "segment_end"; stop_reason: string | null }
  | { type: "error"; message: string }
  | {
      type: "done";
      model: string;
      effort: string;
      stop_reason: string | null;
      usage: Anthropic.Usage | null;
      costUsd: number | null;
    };

export type ChatSink = (event: ChatEvent) => void;

const TEMPLATE_PAGE = "Statistikkteam/Mal%3A-protokoll-for-statistikkteam.md";

/**
 * Constructed on first use, not at import: the key may come from the repo-root .env, and a
 * missing key should surface as a chat error (panels keep working) rather than at startup.
 */
let client: Anthropic | null = null;

function anthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY mangler. Legg « ANTHROPIC_API_KEY=sk-ant-… » i .env i toppmappa " +
        "(eller kjør « node setup.mjs »), og start appen på nytt.",
    );
  }
  client ??= new Anthropic();
  return client;
}

function tools(emit: ChatSink) {
  /**
   * Counted from the loaded snapshot, never written by hand. Hardcoded totals went stale the
   * first time the dbt export was refreshed (45 products became 53, 1354 columns became 2286),
   * and a tool description that misstates how much is undocumented actively misleads the model.
   */
  const columns = listDbtSources().flatMap((source) => source.columns);
  const counts = {
    pages: listWikiPages().length,
    products: listDbtSources().length,
    columns: columns.length,
    undocumented: columns.filter((column) => !column.description).length,
  };

  /**
   * Offer the source as a link in the chat. The panels do not follow along on their own —
   * the user clicks the link when they want to see the page.
   */
  const reveal = (panel: "wiki" | "dbt", payload: { id: string; title: string; query?: string }) =>
    emit({ type: "source", panel, ...payload });

  const searchWikiTool = betaZodTool({
    name: "search_wiki",
    description:
      `Fritekstsøk i Stat19-wikien (${counts.pages} sider). Bruk section='Dataprodukter' når du leter etter ` +
      "dataprodukter, dekningsperioder eller begrensninger for en kilde – det er hovedkilden til " +
      "beskrivelser. Uten section søkes hele wikien (juridisk, prosess, protokoller).",
    inputSchema: z.object({
      query: z.string().describe("Søkeord, f.eks. 'ventetid NPR' eller 'abort protokoll'"),
      section: z
        .enum(["Dataprodukter", "Statistikkteam", "Stat19-Wiki", "alle"])
        .optional()
        .describe("Avgrens til én del av wikien. 'Dataprodukter' = kildesidene for dataproduktene."),
      limit: z.number().int().min(1).max(15).optional(),
    }),
    run: async ({ query, section, limit }) => {
      const prefix =
        section === "Dataprodukter"
          ? "Dataprodukter-i-Stat19"
          : section === "Statistikkteam"
            ? "Statistikkteam"
            : section === "Stat19-Wiki"
              ? "Stat19-Wiki"
              : null;
      // Search wide, then narrow, so a section filter never starves the result list.
      const result = searchWikiDetailed(query, prefix ? 40 : (limit ?? 8));
      const hits = (prefix ? result.hits.filter((h) => h.id.startsWith(prefix)) : result.hits).slice(0, limit ?? 8);
      emit({
        type: "tool",
        tool: "search_wiki",
        query: section && section !== "alle" ? `${query} (${section})` : query,
        count: hits.length,
      });
      if (hits[0]) reveal("wiki", { id: hits[0].id, title: hits[0].title, query });
      if (!hits.length) {
        return result.verdict === "empty-query"
          ? `Søket «${query}» inneholdt bare vanlige ord (${result.dropped.join(", ")}) – bruk et faglig søkeord.`
          : `Ingen treff i wikien for «${query}». Det betyr at ordet ikke står i denne wiki-klonen – ` +
              `si det heller enn å gjette, og skill det fra at opplysningen ikke finnes i Stat19.`;
      }
      const header =
        result.verdict === "weak"
          ? `SVAKE TREFF for «${query}» – ingen side skiller seg ut. Behandle dette som «finner det ikke ` +
            `i snapshotet», ikke som et svar, og si det til brukeren hvis du bygger på det.\n\n`
          : "";
      const line = (h: (typeof hits)[number]) => `${h.id} | ${h.title} | rel=${h.score.toFixed(2)} | ${h.snippet}`;

      // Without a section filter, group the results. Long team protocols repeat a term far more
      // often than the short source page that documents it, so on score alone a page like
      // Dataprodukter-til-Team-RSV.md buries Dataprodukter-i-Stat19/MSIS.md. Grouping means the
      // canonical source page is always visible, and the model is told which kind it is looking
      // at, without pretending team pages are never the right answer.
      if (!prefix) {
        const sourcePages = hits.filter((h) => h.id.startsWith("Dataprodukter-i-Stat19"));
        const others = hits.filter((h) => !h.id.startsWith("Dataprodukter-i-Stat19"));
        if (sourcePages.length && others.length) {
          return (
            header +
            `DATAPRODUKTSIDER – kildebeskrivelsene, og eneste sted dekningsperioder står:\n` +
            sourcePages.map(line).join("\n\n") +
            `\n\nANDRE SIDER – protokoller, juridisk, prosess. Bruk dem til formål, hjemmel og ` +
            `eksempler, ikke til å avgjøre hva et dataprodukt inneholder:\n` +
            others.map(line).join("\n\n")
          );
        }
      }
      return header + hits.map(line).join("\n\n");
    },
  });

  const readWikiPageTool = betaZodTool({
    name: "read_wiki_page",
    description:
      "Les en wiki-side. Bruk id-en fra search_wiki, f.eks. 'Dataprodukter-i-Stat19/NPR.md'. " +
      "Store sider returneres som utdrag: de relevante avsnittene (styr dem med 'query') pluss en " +
      "innholdsliste over alle avsnitt. Trenger du mer, kall på nytt med sections=['4','7'] " +
      "(avsnittsnummer eller overskrift) eller full=true. Små sider kommer alltid i sin helhet.",
    inputSchema: z.object({
      id: z.string(),
      query: z
        .string()
        .optional()
        .describe("Hva du er ute etter på siden – avgjør hvilke avsnitt som returneres"),
      sections: z.array(z.string()).optional().describe("Avsnittsnummer eller overskrifter du vil ha i sin helhet"),
      full: z.boolean().optional().describe("Hele siden. Bruk sparsomt – store sider koster mye"),
    }),
    run: async ({ id, query, sections, full }) => {
      try {
        const read = readWikiPageForModel(id, { query, sections, full });
        emit({
          type: "tool",
          tool: "read_wiki_page",
          query: read.mode === "utdrag" ? `${read.title} (${read.returned}/${read.total} avsnitt)` : read.title,
        });
        reveal("wiki", { id: read.id, title: read.title });
        return read.text;
      } catch (err) {
        return `Feil: ${(err as Error).message}`;
      }
    },
  });

  const searchDbtTool = betaZodTool({
    name: "search_dbt",
    description:
      "Søk i dbt-metadata etter dataprodukter og faktiske kolonnenavn. Dekker kun dbt `sources` " +
      "(source.fida.<register>.<tabell>) – altså dataproduktene teamene bestiller fra. dbt `nodes` " +
      "(model.fida.*_<team>, dvs. team-views med det enkelte teamet allerede har fått) er bevisst " +
      "utelatt og skal ikke brukes. Bruk dette for å FINNE dataproduktet – ikke for å avgjøre hvilke " +
      `variabler det har. ${counts.undocumented} av ${counts.columns} kolonner mangler beskrivelse i dbt, ` +
      "så søket ser bare kolonnenavnet: variabler med kryptiske navn (f.eks. ansienDato for " +
      "ansiennitetsdato) blir ikke funnet av et søk på «ventetid». Har du funnet dataproduktet, kall " +
      "get_dbt_source og les hele kolonnelista før du sier at en variabel ikke finnes.",
    inputSchema: z.object({
      query: z.string().describe("Søkeord, f.eks. 'ventetid', 'fnr_hash', 'sykehusepj'"),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    run: async ({ query, limit }) => {
      const result = searchDbtDetailed(query, limit ?? 10);
      const hits = result.hits;
      emit({ type: "tool", tool: "search_dbt", query, count: hits.length });
      if (hits[0]) reveal("dbt", { id: hits[0].id, title: hits[0].label, query });
      if (!hits.length) {
        return result.verdict === "empty-query"
          ? `Søket «${query}» inneholdt bare vanlige ord (${result.dropped.join(", ")}) – bruk et faglig søkeord.`
          : `Ingen treff i dbt-metadata for «${query}». Ingen dataproduktnavn, kolonnenavn eller ` +
              `kolonnebeskrivelse inneholder ordet. Merk at ${counts.undocumented} av ${counts.columns} kolonner mangler beskrivelse i dbt, ` +
              `så et søk kan bomme selv om variabelen finnes: hent hele kolonnelista med get_dbt_source ` +
              `for det dataproduktet du tror det gjelder, før du konkluderer med at variabelen ikke finnes.`;
      }
      const header =
        result.verdict === "weak"
          ? `SVAKE TREFF for «${query}» – ingenting skiller seg ut. Behandle det som «finner det ikke», ` +
            `og sjekk kolonnelista med get_dbt_source før du konkluderer.\n\n`
          : "";
      return (
        header +
        hits
          .map(
            (h) =>
              `${h.label} (${h.id}) rel=${h.score.toFixed(2)}\n  ${h.description.split("\n")[0]}\n  treff i kolonner: ${
                h.matchedColumns.map((c) => `${c.name}${c.type ? ":" + c.type : ""}`).join(", ") || "—"
              }`,
          )
          .join("\n\n")
      );
    },
  });

  const getDbtSourceTool = betaZodTool({
    name: "get_dbt_source",
    description:
      "Hent ALLE kolonner (navn, datatype, beskrivelse) for ett dataprodukt fra dbt `sources`. " +
      "Godtar id (source.fida.npr.npr_som_hoved) eller 'register.tabell'. Dette er den " +
      "autoritative lista over hvilke variabler som finnes – search_dbt finner bare de som har " +
      "søkeordet i navnet eller beskrivelsen. Kall alltid denne før du oppgir variabelnavn i et " +
      "protokollutkast, og før du konkluderer med at en variabel ikke finnes.",
    inputSchema: z.object({ id: z.string() }),
    run: async ({ id }) => {
      const source = getDbtSource(id);
      if (!source) return `Fant ikke dataproduktet '${id}'.`;
      emit({ type: "tool", tool: "get_dbt_source", query: source.label });
      reveal("dbt", { id: source.id, title: source.label });
      return [
        `${source.label} (skjema ${source.schema}.${source.identifier})`,
        source.description,
        "",
        "Kolonner:",
        ...source.columns.map(
          (c) =>
            `- ${c.name}${c.codeName ? ` (dbt: ${c.codeName})` : ""}${c.type ? ` [${c.type}]` : ""}` +
            // An undescribed column must not look like one you failed to look up: most columns
            // have no dbt description, so silence here is the normal case, not a miss.
            `${c.description ? ` – ${c.description}` : " – [udokumentert i dbt]"}`,
        ),
        "",
        `${source.columns.filter((c) => !c.description).length} av ${source.columns.length} kolonner mangler ` +
          `beskrivelse i dbt. Navnet er likevel korrekt og kan bestilles; si at beskrivelsen er udokumentert ` +
          `framfor å dikte opp hva kolonnen inneholder.`,
      ].join("\n");
    },
  });

  const protocolTemplateTool = betaZodTool({
    name: "get_protocol_template",
    description:
      "Hent malen for statistikkprotokoll ordrett, sammen med en liste over godkjente protokoller som kan brukes som eksempel. Kall denne FØR du skriver et protokollutkast.",
    inputSchema: z.object({}),
    run: async () => {
      emit({ type: "tool", tool: "get_protocol_template", query: "protokollmal" });
      try {
        const template = getWikiPage(TEMPLATE_PAGE);
        reveal("wiki", { id: template.id, title: template.title });
        const examples = listWikiPages()
          // Top-level team protocols only — not their child pages.
          .filter((p) => /^Statistikkteam\/Team-[^/]+\.md$/.test(p.id))
          .map((p) => `- ${p.title} (${p.id})`)
          .join("\n");
        return [
          "MAL (følg avsnittene i denne rekkefølgen):",
          template.markdown,
          "",
          "EKSEMPELPROTOKOLLER – les én med read_wiki_page for tone og detaljnivå:",
          examples,
        ].join("\n");
      } catch (err) {
        return `Fant ikke malen (${(err as Error).message}). Søk etter «Mal protokoll» med search_wiki.`;
      }
    },
  });

  const listDbtSourcesTool = betaZodTool({
    name: "list_dbt_sources",
    description: `List alle ${counts.products} dataproduktene (dbt sources) med antall kolonner, gruppert per register.`,
    inputSchema: z.object({}),
    run: async () => {
      emit({ type: "tool", tool: "list_dbt_sources", query: "alle dataprodukter" });
      return listDbtSources().map((s) => `${s.label} (${s.columns.length} kolonner)`).join("\n");
    },
  });

  return [
    searchWikiTool,
    readWikiPageTool,
    searchDbtTool,
    getDbtSourceTool,
    listDbtSourcesTool,
    protocolTemplateTool,
  ];
}

function userContent(text: string, attachments: Attachment[]): Anthropic.Beta.BetaContentBlockParam[] {
  const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const file of attachments) {
    if (file.kind === "pdf") {
      blocks.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: file.base64 },
        title: file.name,
      });
    } else {
      blocks.push({ type: "text", text: `Vedlagt fil «${file.name}»:\n\n${file.text}` });
    }
  }
  blocks.push({ type: "text", text });
  return blocks;
}

export async function streamChat(
  emit: ChatSink,
  history: ChatTurn[],
  message: string,
  attachments: Attachment[],
  modelId?: string,
  effortId?: string,
  signal?: AbortSignal,
): Promise<void> {
  const status = await getStatus();
  const model = resolveModel(modelId);
  const effort = resolveEffort(effortId);

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...history.map((t) => ({ role: t.role, content: t.content }) as Anthropic.Beta.BetaMessageParam),
    { role: "user", content: userContent(message, attachments) },
  ];

  try {
    const runner = anthropic().beta.messages.toolRunner({
      model: model.id,
      max_tokens: 32_000,
      system: buildSystem(status),
      ...modelParams(model, effort),
      tools: tools(emit),
      messages,
      max_iterations: 24,
      stream: true,
    }, { signal });

    for await (const stream of runner) {
      stream.on("text", (delta) => emit({ type: "text", delta }));
      stream.on("thinking", (delta) => emit({ type: "thinking", delta }));
      const message = await stream.finalMessage();
      // Text written before a tool call is running commentary, not the answer. Tell the
      // client where each segment ended so it can keep only the final one as the answer.
      emit({ type: "segment_end", stop_reason: message.stop_reason });
      // The runner does not auto-resume a paused server-tool turn.
      if (message.stop_reason === "pause_turn") {
        runner.pushMessages({ role: "assistant", content: message.content });
      }
      if (message.stop_reason === "refusal") {
        emit({ type: "error", message: "Modellen avslo forespørselen (safety)." });
      }
    }

    const final = await runner.done();
    emit({
      type: "done",
      model: model.id,
      effort,
      stop_reason: final?.stop_reason ?? null,
      usage: final?.usage ?? null,
      costUsd: estimateCost(model, final?.usage ?? null),
    });
  } catch (err) {
    if (signal?.aborted) return;
    console.error("streamChat:", err);
    let message = (err as Error).message;
    if (err instanceof Anthropic.AuthenticationError) {
      message = "Ugyldig eller manglende ANTHROPIC_API_KEY.";
    } else if (err instanceof Anthropic.RateLimitError) {
      message = "Rate limit fra API-et – prøv igjen om litt.";
    } else if (err instanceof Anthropic.APIError) {
      message = `API-feil ${err.status}: ${err.message}`;
    }
    emit({ type: "error", message });
  }
}
