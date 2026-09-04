import { useCallback, useEffect, useState } from "react";
import Chat from "./Chat.tsx";
import DbtPanel from "./DbtPanel.tsx";
import WikiPanel from "./WikiPanel.tsx";
import { api, formatDate, type EffortChoice, type ModelChoice, type Status } from "./lib/api.ts";

/** What a panel should show. `at` makes every click a new value, so re-clicking re-opens. */
export type PanelTarget = { id: string; title: string; query?: string; at: number };

function Badge({
  label,
  value,
  stale,
  error,
  tint,
}: {
  label: string;
  value: string;
  stale: boolean;
  error: string | null;
  tint: { fg: string; bg: string };
}) {
  const tone =
    error || stale
      ? { background: "var(--warn-soft)", color: "var(--warn)", border: "var(--warn)" }
      : { background: tint.bg, color: tint.fg, border: "transparent" };
  return (
    <span
      title={error ?? undefined}
      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs whitespace-nowrap"
      style={{ background: tone.background, color: tone.color, borderColor: tone.border }}
    >
      <span className="font-medium">{label}</span>
      <span>{error ? "mangler" : value}</span>
    </span>
  );
}

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [efforts, setEfforts] = useState<EffortChoice[]>([]);
  const [model, setModel] = useState<string>("claude-opus-5");
  const [effort, setEffort] = useState<string>("high");
  const [pulling, setPulling] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);
  const [chatKey, setChatKey] = useState(0);
  const [wikiFromChat, setWikiFromChat] = useState<PanelTarget | null>(null);
  const [dbtFromChat, setDbtFromChat] = useState<PanelTarget | null>(null);

  useEffect(() => {
    api
      .status()
      .then(setStatus)
      .catch(() => {
        setStatus(null);
        // Without the API server nothing in the app works, and the badges just vanish — say why.
        setNotice({
          text: "API-serveren på :5179 svarer ikke. Start appen på nytt: start.command, eller «npm run dev» i app/.",
          tone: "warn",
        });
      });
    api
      .models()
      .then(({ models: list, efforts: levels }) => {
        setModels(list);
        setEfforts(levels);
        // Remember the picks between sessions; fall back to the first offered option.
        try {
          const savedModel = localStorage.getItem("stat19.model");
          const savedEffort = localStorage.getItem("stat19.effort");
          setModel(savedModel && list.some((m) => m.id === savedModel) ? savedModel : (list[0]?.id ?? "claude-opus-5"));
          if (savedEffort && levels.some((e) => e.id === savedEffort)) setEffort(savedEffort);
        } catch {
          /* private window or blocked storage — defaults are fine */
        }
      })
      .catch(() => setModels([]));
  }, []);

  const remember = (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private window — the picker still works for this session */
    }
  };

  const current = models.find((m) => m.id === model);

  const refresh = async () => {
    setPulling(true);
    setNotice(null);
    try {
      const wiki = await api.pullWiki();
      setStatus(wiki.status);
      const dbt = await api.reloadDbt();
      setStatus(dbt.status);
      // git exits non-zero on its own without failing the request — report what it said.
      const firstLine = wiki.output.split("\n").find((l) => l.trim()) ?? "";
      if (!wiki.ok) setNotice({ text: `git pull feilet: ${firstLine || "ukjent feil"}`, tone: "warn" });
      else if (/already up to date/i.test(wiki.output))
        setNotice({ text: "Wikien var allerede à jour. dbt-metadataene er lest inn på nytt.", tone: "ok" });
      else setNotice({ text: `Wikien er oppdatert (${firstLine}).`, tone: "ok" });
    } catch (err) {
      setNotice({ text: `Oppdatering feilet: ${(err as Error).message}`, tone: "warn" });
    } finally {
      setPulling(false);
    }
  };

  // Only ever called from a link the user clicked in the chat — the panels never follow
  // the conversation on their own.
  const openSource = useCallback((event: { panel: "wiki" | "dbt"; id: string; title: string; query?: string }) => {
    const entry = { id: event.id, title: event.title, query: event.query, at: Date.now() };
    if (event.panel === "wiki") setWikiFromChat(entry);
    else setDbtFromChat(entry);
  }, []);

  return (
    <div className="flex h-full flex-col" style={{ background: "var(--surface-page)" }}>
      <header
        className="flex flex-wrap items-center gap-3 border-b px-4 py-2.5"
        style={{
          borderColor: "var(--border-soft)",
          background: "linear-gradient(90deg, var(--accent) 0%, var(--accent) 3px, var(--surface-panel) 3px)",
        }}
      >
        <h1 className="text-xl font-semibold tracking-tight" style={{ color: "var(--accent-strong)" }}>
          Stat19-assistent
        </h1>

        <label className="flex items-center gap-1.5">
          <span className="sr-only">Modell</span>
          <select
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              remember("stat19.model", e.target.value);
            }}
            title={current?.hint}
            className="cursor-pointer rounded-md border px-2 py-1 text-xs font-medium outline-none"
            style={{ borderColor: "var(--accent)", color: "var(--accent-strong)", background: "var(--accent-soft)" }}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>

        {current?.supportsEffort && (
          <label className="flex items-center gap-1.5">
            <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              grundighet
            </span>
            <select
              value={effort}
              onChange={(e) => {
                setEffort(e.target.value);
                remember("stat19.effort", e.target.value);
              }}
              title={efforts.find((e) => e.id === effort)?.hint}
              className="cursor-pointer rounded-md border px-2 py-1 text-xs outline-none"
              style={{ borderColor: "var(--border-strong)", color: "var(--text-strong)", background: "var(--surface-panel)" }}
            >
              {efforts.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </select>
          </label>
        )}

        <button
          onClick={() => setChatKey((k) => k + 1)}
          className="rounded-md px-2.5 py-1 text-xs font-medium text-white transition-colors"
          style={{ background: "var(--accent)" }}
          title="Tøm samtalen og start på nytt"
        >
          + Ny samtale
        </button>

        <span className="hidden text-xs lg:inline" style={{ color: "var(--text-muted)" }}>
          protokoll · dataprodukter · variabler
        </span>
        <div className="ml-auto flex items-center gap-2">
          {status && (
            <>
              <Badge
                label="Wiki"
                value={`sist endret ${formatDate(status.wiki.lastEdited)}`}
                stale={status.wiki.stale}
                error={status.wiki.error}
                tint={{ fg: "var(--wiki)", bg: "var(--wiki-soft)" }}
              />
              <Badge
                label="dbt"
                value={`bygget ${formatDate(status.dbt.builtAt)}`}
                stale={status.dbt.stale}
                error={status.dbt.error}
                tint={{ fg: "var(--dbt)", bg: "var(--dbt-soft)" }}
              />
            </>
          )}
          <button
            onClick={refresh}
            disabled={pulling}
            className="rounded-md border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50"
            style={{ borderColor: "var(--accent)", color: "var(--accent)", background: "var(--surface-panel)" }}
          >
            {pulling ? "Oppdaterer…" : "Oppdater"}
          </button>
        </div>
      </header>

      {notice && (
        <div
          className="flex items-start gap-2 border-b px-4 py-1.5 text-xs"
          style={{
            borderColor: "var(--border-soft)",
            background: notice.tone === "warn" ? "var(--warn-soft)" : "var(--accent-soft)",
            color: notice.tone === "warn" ? "var(--warn)" : "var(--accent-strong)",
          }}
        >
          <span className="min-w-0 flex-1">{notice.text}</span>
          <button onClick={() => setNotice(null)} className="shrink-0 opacity-70" title="Lukk">
            ✕
          </button>
        </div>
      )}

      <main className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section className="flex min-h-0 flex-1 lg:w-[56%] lg:flex-none">
          <Chat key={chatKey} onOpenSource={openSource} status={status} model={model} effort={effort} />
        </section>
        <section
          className="flex min-h-0 flex-1 flex-col border-t lg:border-t-0 lg:border-l"
          style={{ borderColor: "var(--border-soft)" }}
        >
          <WikiPanel fromChat={wikiFromChat} />
          <div className="border-t" style={{ borderColor: "var(--border-soft)" }} />
          <DbtPanel fromChat={dbtFromChat} />
        </section>
      </main>
    </div>
  );
}
