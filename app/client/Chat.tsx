import { useEffect, useMemo, useRef, useState } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type Attachment, type Status } from "./lib/api.ts";
import { streamChat } from "./lib/stream.ts";

type ToolEvent = { tool: string; query?: string; count?: number };
/** A wiki page or dataprodukt the answer points to. Opens in the panel when clicked. */
export type SourceLink = { panel: "wiki" | "dbt"; id: string; title: string; query?: string };
type Message = {
  role: "user" | "assistant";
  content: string;
  files?: string[];
  tools?: ToolEvent[];
  thinking?: string;
  /** Narration the model wrote before tool calls — kept out of the answer. */
  notes?: string[];
  /** Sources the model looked up, offered as links — the panels open only on a click. */
  sources?: SourceLink[];
};

const TOOL_LABELS: Record<string, string> = {
  search_wiki: "søker i wiki",
  read_wiki_page: "leser wiki-side",
  search_dbt: "søker i dbt",
  get_dbt_source: "henter dataprodukt",
  list_dbt_sources: "lister dataprodukter",
};

/** Wiki ids encode punctuation (%3A = :); decode for display, but never throw on stray %. */
function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * `wiki:<side-id>` and `dbt:<dataprodukt-id>` links in the answer are panel links, not
 * web addresses. Returns null for ordinary links, which keep their normal behaviour.
 */
function parseSourceHref(href: string | undefined): SourceLink | null {
  const match = /^(wiki|dbt):(.+)$/.exec(href ?? "");
  if (!match) return null;
  const panel = match[1] as "wiki" | "dbt";
  const id = decode(match[2]);
  const leaf = panel === "wiki" ? (id.split("/").at(-1) ?? id).replace(/\.md$/, "") : id.replace(/^source\.fida\./, "");
  return { panel, id, title: decode(leaf).replace(/-/g, " ") };
}

/** Keep our own schemes intact; everything else goes through react-markdown's sanitiser. */
function urlTransform(url: string): string {
  return /^(wiki|dbt):/.test(url) ? url : (defaultUrlTransform(url) ?? "");
}

/** A source the user can click open in the panel to the right. */
function SourceChip({ source, onOpen }: { source: SourceLink; onOpen: (source: SourceLink) => void }) {
  const tint =
    source.panel === "wiki"
      ? { background: "var(--wiki-soft)", color: "var(--wiki)" }
      : { background: "var(--dbt-soft)", color: "var(--dbt)" };
  return (
    <button
      type="button"
      onClick={() => onOpen(source)}
      title={`Åpne ${source.id} i ${source.panel === "wiki" ? "wiki-panelet" : "dataprodukt-panelet"}`}
      className="cursor-pointer rounded-full px-2 py-0.5 text-xs underline decoration-dotted underline-offset-2 transition-[filter] hover:brightness-95"
      style={tint}
    >
      {source.panel === "wiki" ? "📄" : "▦"} {source.title}
    </button>
  );
}

/** Name the file after the draft's own first heading, if it has one. */
function titleFor(content: string): string {
  const heading = content.split("\n").find((line) => /^#{1,2}\s+\S/.test(line));
  const raw = heading ? heading.replace(/^#+\s*/, "").trim() : "";
  return raw.length > 3 ? raw : "statistikkprotokoll";
}

function downloadMarkdown(content: string, title: string): void {
  const stamp = new Date().toISOString().slice(0, 10);
  const name = `${stamp}-${title.toLowerCase().replace(/[æå]/g, "a").replace(/ø/g, "o").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "protokollutkast"}.md`;
  const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/** What to say while the model works — the newest tool call, in plain Norwegian. */
function activityLabel(message: { tools?: ToolEvent[] }): string {
  const last = message.tools?.at(-1);
  if (!last) return "tenker…";
  const what = TOOL_LABELS[last.tool] ?? last.tool;
  return last.query ? `${what}: ${last.query}` : `${what}…`;
}

const SUGGESTIONS = [
  "Vi skal se på ventetid før abort i perioden 2020–2025 — hvilke dataprodukter og variabler kan vi bruke?",
  "Foreslå populasjon, datakilder og begrunnelse for forvaltningsoppgave for et team om vaksinasjonsdekning hos gravide",
  "Skriv et utkast til statistikkprotokoll etter malen for et nytt team om luftveisinfeksjoner hos eldre",
];

export default function Chat({
  onOpenSource,
  status,
  model,
  effort,
}: {
  onOpenSource: (source: SourceLink) => void;
  status: Status | null;
  model: string;
  effort: string;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [lastUsage, setLastUsage] = useState<{
    input?: number;
    output?: number;
    cached?: number;
    costUsd?: number | null;
  } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  const attach = async (files: File[]) => {
    if (!files.length) return;
    try {
      const uploaded = await api.upload(files);
      setPending((prev) => [...prev, ...uploaded]);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const send = async (text: string) => {
    const trimmed = text.trim();
    if ((!trimmed && !pending.length) || busy) return;

    const attachments = pending;
    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    setMessages((prev) => [
      ...prev,
      { role: "user", content: trimmed, files: attachments.map((a) => a.name) },
      { role: "assistant", content: "", tools: [], thinking: "", notes: [], sources: [] },
    ]);
    setInput("");
    setPending([]);
    setBusy(true);
    setError(null);
    setSaved(null);

    const patchLast = (fn: (m: Message) => Message) =>
      setMessages((prev) => prev.map((m, i) => (i === prev.length - 1 ? fn(m) : m)));

    abort.current = new AbortController();
    try {
      await streamChat(
        { message: trimmed, history, attachments, model, effort },
        {
          onText: (delta) => patchLast((m) => ({ ...m, content: m.content + delta })),
          onThinking: (delta) => patchLast((m) => ({ ...m, thinking: (m.thinking ?? "") + delta })),
          onTool: (event) => patchLast((m) => ({ ...m, tools: [...(m.tools ?? []), event] })),
          onSegmentEnd: (stopReason) =>
            patchLast((m) => {
              // Everything before the last segment is commentary; park it in the work log.
              if (stopReason === "end_turn" || !m.content.trim()) return m;
              return { ...m, notes: [...(m.notes ?? []), m.content.trim()], content: "" };
            }),
          // Collect the sources as links in the chat; the panels stay put until clicked.
          onSource: (event) =>
            patchLast((m) =>
              m.sources?.some((s) => s.panel === event.panel && s.id === event.id)
                ? m
                : { ...m, sources: [...(m.sources ?? []), event] },
            ),
          onError: (message) => setError(message),
          onDone: (info) => {
            setBusy(false);
            if (info?.usage) {
              setLastUsage({
                input: info.usage.input_tokens,
                output: info.usage.output_tokens,
                cached: info.usage.cache_read_input_tokens,
                costUsd: info.costUsd,
              });
            }
          },
        },
        abort.current.signal,
      );
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const dbtMissing = status?.dbt.present === false;

  // wiki:… and dbt:… links in the answer open the page in the panel instead of navigating.
  const answerComponents: Components = useMemo(
    () => ({
      a({ href, children, node: _node, ...props }) {
        const source = parseSourceHref(href);
        if (!source)
          return (
            <a href={href} target="_blank" rel="noreferrer" {...props}>
              {children}
            </a>
          );
        return (
          <button
            type="button"
            onClick={() => onOpenSource(source)}
            title={`Åpne ${source.id} i ${source.panel === "wiki" ? "wiki-panelet" : "dataprodukt-panelet"}`}
            className="cursor-pointer underline decoration-dotted underline-offset-2"
            style={{ color: source.panel === "wiki" ? "var(--wiki)" : "var(--dbt)" }}
          >
            {children}
          </button>
        );
      },
    }),
    [onOpenSource],
  );

  return (
    <div
      className="flex min-h-0 w-full flex-col"
      style={{ background: "var(--surface-panel)" }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void attach([...e.dataTransfer.files]);
      }}
    >
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        {messages.length === 0 && (
          <div className="mx-auto max-w-xl pt-6">
            <h2 className="text-base font-semibold" style={{ color: "var(--accent-strong)" }}>
              Beskriv prosjektet
            </h2>
            <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
              Tema, problemstillinger, PICO, populasjon, tidsperiode og leveranse. Legg gjerne ved
              oppdragsbrev eller protokollutkast (PDF, DOCX, MD, TXT). Assistenten slår opp i wikien
              og dbt-metadataene og lenker til kildene i svaret – klikk en lenke for å åpne siden i
              panelet til høyre.
            </p>
            {dbtMissing && (
              <p className="mt-3 rounded-md px-3 py-2 text-xs" style={{ background: "var(--warn-soft)", color: "var(--warn)" }}>
                dbt-metadata mangler — variabelnavn kan ikke verifiseres. Last ned manifest.json og
                catalog.json på jobb-PC.
              </p>
            )}
            <div className="mt-5 flex flex-col gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => void send(s)}
                  className="rounded-lg border px-3 py-2 text-left text-sm transition-colors hover:brightness-[0.98]"
                  style={{ borderColor: "var(--accent-soft)", background: "var(--surface-sunken)" }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mx-auto flex max-w-2xl flex-col gap-5">
          {messages.map((message, i) => (
            <div key={i} className={message.role === "user" ? "flex justify-end" : ""}>
              {message.role === "user" ? (
                <div
                  className="max-w-[85%] rounded-2xl rounded-br-sm px-3.5 py-2.5 text-sm whitespace-pre-wrap"
                  style={{ background: "var(--accent)", color: "#fff" }}
                >
                  {message.content}
                  {!!message.files?.length && (
                    <div className="mt-1.5 text-xs opacity-80">
                      📎 {message.files.join(", ")}
                    </div>
                  )}
                </div>
              ) : (
                <div>
                  {!!message.tools?.length && (
                    <div className="mb-2 flex flex-wrap gap-1.5">
                      {message.tools.map((tool, k) => (
                        <span
                          key={k}
                          className="rounded-full px-2 py-0.5 text-xs"
                          style={
                            tool.tool.includes("wiki")
                              ? { background: "var(--wiki-soft)", color: "var(--wiki)" }
                              : { background: "var(--dbt-soft)", color: "var(--dbt)" }
                          }
                        >
                          {TOOL_LABELS[tool.tool] ?? tool.tool}
                          {tool.query ? `: ${tool.query}` : ""}
                          {typeof tool.count === "number" ? ` (${tool.count})` : ""}
                        </span>
                      ))}
                    </div>
                  )}
                  {!!message.sources?.length && (
                    <div className="mb-2 flex flex-wrap items-center gap-1.5">
                      <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                        kilder – klikk for å åpne i panelet:
                      </span>
                      {message.sources.map((source) => (
                        <SourceChip key={`${source.panel}:${source.id}`} source={source} onOpen={onOpenSource} />
                      ))}
                    </div>
                  )}
                  {(!!message.notes?.length || (!busy && !!message.thinking?.trim())) && (
                    <details className="mb-2">
                      <summary
                        className="cursor-pointer text-[11px] select-none"
                        style={{ color: "var(--text-muted)" }}
                      >
                        arbeidslogg
                        {message.notes?.length ? ` (${message.notes.length})` : ""}
                        {message.notes?.at(-1) && (
                          <span className="ml-1 opacity-70">· {message.notes.at(-1)!.slice(0, 60)}…</span>
                        )}
                      </summary>
                      <div
                        className="mt-1 border-l-2 pl-2 text-[11px] whitespace-pre-wrap"
                        style={{ borderColor: "var(--border-strong)", color: "var(--text-muted)" }}
                      >
                        {!!message.notes?.length && message.notes.join("\n\n")}
                        {!!message.notes?.length && !!message.thinking?.trim() && "\n\n"}
                        {!!message.thinking?.trim() && `Resonnement:\n${message.thinking.trim()}`}
                      </div>
                    </details>
                  )}
                  {busy && i === messages.length - 1 && (
                    <div className="mb-2 flex flex-col gap-1">
                      <div className="flex items-center gap-2 text-xs" style={{ color: "var(--text-muted)" }}>
                        <span className="pulse-dot" />
                        <span>{activityLabel(message)}</span>
                      </div>
                      {message.thinking?.trim() && (
                        <div
                          className="thinking-trace border-l-2 pl-2 text-[11px] whitespace-pre-wrap"
                          style={{ borderColor: "var(--border-soft)", color: "var(--text-muted)" }}
                        >
                          {message.thinking.trim().slice(-600)}
                        </div>
                      )}
                    </div>
                  )}
                  {message.content ? (
                    <>
                      <div className="prose-wiki answer-in">
                        <Markdown remarkPlugins={[remarkGfm]} components={answerComponents} urlTransform={urlTransform}>
                          {message.content}
                        </Markdown>
                      </div>
                      {!busy && message.content.length > 400 && (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <button
                            onClick={() => downloadMarkdown(message.content, titleFor(message.content))}
                            className="rounded-md border px-2 py-1 text-[11px] font-medium"
                            style={{ borderColor: "var(--accent)", color: "var(--accent-strong)" }}
                          >
                            ⬇ Last ned som .md
                          </button>
                          <button
                            onClick={() => void navigator.clipboard.writeText(message.content).then(() => setSaved("Kopiert"))}
                            className="rounded-md border px-2 py-1 text-[11px]"
                            style={{ borderColor: "var(--border-strong)", color: "var(--text-muted)" }}
                          >
                            Kopier
                          </button>
                          <button
                            onClick={() =>
                              void api
                                .saveDraft(titleFor(message.content), message.content)
                                .then((r) => setSaved(`Lagret som ${r.path}`))
                                .catch((e) => setError(e.message))
                            }
                            className="rounded-md border px-2 py-1 text-[11px]"
                            style={{ borderColor: "var(--border-strong)", color: "var(--text-muted)" }}
                          >
                            Lagre i prosjekter/
                          </button>
                          {saved && (
                            <span className="text-[11px]" style={{ color: "var(--dbt)" }}>
                              {saved}
                            </span>
                          )}
                        </div>
                      )}
                    </>
                  ) : null}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {error && (
        <div className="mx-4 mb-2 rounded-md px-3 py-2 text-xs" style={{ background: "var(--warn-soft)", color: "var(--warn)" }}>
          {error}
        </div>
      )}

      <div
        className="border-t px-4 py-3"
        style={{ borderColor: dragging ? "var(--accent)" : "var(--border-soft)" }}
      >
        {!!pending.length && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {pending.map((file, i) => (
              <span
                key={i}
                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs"
                style={{ background: "var(--surface-sunken)" }}
              >
                📎 {file.name}
                <button onClick={() => setPending((prev) => prev.filter((_, k) => k !== i))} style={{ color: "var(--text-muted)" }}>
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
        <div
          className="flex items-end gap-2 rounded-xl border px-2.5 py-2"
          style={{ borderColor: "var(--border-soft)", background: "var(--surface-sunken)" }}
        >
          <label
            className="cursor-pointer rounded-md px-1.5 py-1 text-base leading-none"
            style={{ color: "var(--text-muted)" }}
            title="Legg ved fil"
          >
            📎
            <input
              type="file"
              multiple
              accept=".pdf,.docx,.md,.txt,.csv"
              className="hidden"
              onChange={(e) => {
                void attach([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
          </label>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            rows={1}
            placeholder="Beskriv prosjektet, eller spør om dataprodukter og variabler…"
            className="max-h-40 min-h-6 flex-1 resize-none bg-transparent text-sm outline-none"
            style={{ color: "var(--text-strong)" }}
          />
          {busy ? (
            <button
              onClick={() => abort.current?.abort()}
              className="rounded-lg px-3 py-1.5 text-xs font-medium"
              style={{ background: "var(--surface-hover)", color: "var(--text-muted)" }}
            >
              Stopp
            </button>
          ) : (
            <button
              onClick={() => void send(input)}
              disabled={!input.trim() && !pending.length}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
              style={{ background: "var(--accent)" }}
            >
              Send
            </button>
          )}
        </div>
        <p className="mt-1.5 text-[11px]" style={{ color: "var(--text-muted)" }}>
          Ingen personopplysninger i denne mappen. Enter sender, Shift+Enter gir ny linje.
          {lastUsage && (
            <span>
              {" · "}
              siste svar: {Math.round((lastUsage.input ?? 0) / 100) / 10}k tokens inn
              {lastUsage.cached ? ` (${Math.round((lastUsage.cached ?? 0) / 100) / 10}k fra cache)` : ""}
              {lastUsage.output ? `, ${Math.round((lastUsage.output ?? 0) / 100) / 10}k ut` : ""}
              {typeof lastUsage.costUsd === "number" ? ` · ca. $${lastUsage.costUsd.toFixed(3)}` : ""}
            </span>
          )}
        </p>
      </div>
    </div>
  );
}
