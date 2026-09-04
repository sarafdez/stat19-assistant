// Must be first: static imports evaluate in order, and .env has to be in place before the
// Anthropic SDK and anything else reads process.env.
import "./env.ts";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import { streamChat, type Attachment, type ChatEvent, type ChatTurn } from "./chat.ts";
import { EFFORTS, MODELS } from "./models.ts";
import { PORT, ROOT, WIKI_ATTACHMENTS, describePaths } from "./paths.ts";
import { rulesStatus } from "./prompt.ts";
import { getDbtSource, listDbtSources, loadDbt, searchDbt } from "./sources/dbt.ts";
import { getWikiPage, listWikiPages, loadWiki, searchWiki } from "./sources/wiki.ts";
import { saveDraft } from "./save.ts";
import { getStatus, pullWiki } from "./status.ts";
import { toAttachment } from "./upload.ts";

loadWiki();
loadDbt();

const app = express();
app.use(express.json({ limit: "2mb" }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.get("/api/models", (_req, res) => {
  res.json({
    models: MODELS.map(({ id, label, hint, inputPrice, outputPrice, effort }) => ({
      id,
      label,
      hint,
      inputPrice,
      outputPrice,
      supportsEffort: effort,
    })),
    efforts: EFFORTS,
  });
});

app.get("/api/status", async (_req, res) => {
  res.json(await getStatus());
});

app.post("/api/refresh/wiki", async (_req, res) => {
  const result = await pullWiki();
  loadWiki();
  res.json({ ...result, status: await getStatus() });
});

app.post("/api/refresh/dbt", async (_req, res) => {
  loadDbt();
  res.json({ ok: true, status: await getStatus() });
});

app.get("/api/wiki/search", (req, res) => {
  res.json(searchWiki(String(req.query.q ?? ""), Number(req.query.limit ?? 10)));
});

app.get("/api/wiki/pages", (_req, res) => {
  res.json(listWikiPages());
});

app.get("/api/wiki/page", (req, res) => {
  try {
    res.json(getWikiPage(String(req.query.id ?? "")));
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

app.get("/api/dbt/sources", (_req, res) => {
  res.json(listDbtSources().map(({ columns, ...rest }) => ({ ...rest, columnCount: columns.length })));
});

app.get("/api/dbt/search", (req, res) => {
  res.json(searchDbt(String(req.query.q ?? ""), Number(req.query.limit ?? 12)));
});

app.get("/api/dbt/source", (req, res) => {
  const source = getDbtSource(String(req.query.id ?? ""));
  if (!source) return res.status(404).json({ error: "Fant ikke dataproduktet." });
  res.json(source);
});

app.post("/api/upload", upload.array("files", 6), async (req, res) => {
  try {
    const files = (req.files ?? []) as Express.Multer.File[];
    const attachments: Attachment[] = [];
    for (const file of files) attachments.push(await toAttachment(file));
    res.json({ attachments });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post("/api/save", (req, res) => {
  const { name, content } = req.body as { name?: string; content?: string };
  try {
    const saved = saveDraft(name ?? "protokollutkast", content ?? "");
    res.json(saved);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post("/api/chat", async (req, res) => {
  const { message, history = [], attachments = [], model, effort } = req.body as {
    message?: string;
    history?: ChatTurn[];
    attachments?: Attachment[];
    model?: string;
    effort?: string;
  };
  if (!message?.trim() && attachments.length === 0) {
    return res.status(400).json({ error: "Tom melding." });
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  // Note: res.on("close") is the client-disconnect signal. req.on("close") fires as
  // soon as the request body has been consumed, which would end the stream instantly.
  const aborted = new AbortController();
  res.on("close", () => aborted.abort());

  /** SSE adapter: one frame per event, dropped once the client has gone away. */
  const emit = ({ type, ...data }: ChatEvent) => {
    if (res.writableEnded || res.destroyed) return;
    // The client's stream reader expects text/thinking payloads as bare strings.
    const payload = type === "text" || type === "thinking" ? (data as { delta: string }).delta : data;
    res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    await streamChat(emit, history, message ?? "", attachments, model, effort, aborted.signal);
  } catch (err) {
    console.error("chat failed:", err);
  } finally {
    if (!res.writableEnded) res.end();
  }
});

// Wiki images, so markdown pages render with their attachments.
app.use("/wiki-assets/.attachments", express.static(WIKI_ATTACHMENTS));

// Production: serve the built client.
const dist = path.join(ROOT, "app", "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  // Express 5 dropped the "*" string pattern, so fall back with plain middleware.
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api")) return next();
    res.sendFile(path.join(dist, "index.html"));
  });
}

/**
 * Tell the user what the assistant can actually do before they type their first question:
 * a missing wiki clone or dbt export degrades the answers, and a missing key or rules file
 * breaks the chat entirely. Silence here is how people end up trusting an empty knowledge base.
 */
async function reportReadiness(): Promise<void> {
  const status = await getStatus();
  const rules = rulesStatus();
  const line = (state: "ok" | "warn", text: string) => console.log(`  ${state === "ok" ? "\u2714" : "!"} ${text}`);

  console.log("\nGrunnlag:");
  line(
    status.wiki.present ? "ok" : "warn",
    status.wiki.present
      ? `wiki: ${status.wiki.pages} sider${status.wiki.stale ? " (utdatert – kjør: node setup.mjs)" : ""}`
      : "wiki: mangler – kjør « node setup.mjs ». Panelene og svarene blir tomme uten den.",
  );
  line(
    status.dbt.present ? "ok" : "warn",
    status.dbt.present
      ? `dbt: ${status.dbt.sources} dataprodukter, ${status.dbt.columns} kolonner${status.dbt.stale ? " (utdatert)" : ""}`
      : "dbt: mangler – variabelnavn blir uverifiserte. Krever FHI-nettet: node setup.mjs",
  );
  line(rules.ok ? "ok" : "warn", rules.ok ? `regler.md: ${rules.chars} tegn i systemprompten` : `regler.md: ${rules.error}`);
  line(
    process.env.ANTHROPIC_API_KEY ? "ok" : "warn",
    process.env.ANTHROPIC_API_KEY
      ? "ANTHROPIC_API_KEY er satt"
      : "ANTHROPIC_API_KEY mangler – panelene virker, chatten feiler. Legg den i .env.",
  );
  if (!status.wiki.present || !status.dbt.present) {
    console.log("\nLeter etter snapshotene her:");
    for (const line of describePaths()) console.log(`  ${line}`);
    console.log("  Ligger de et annet sted? Sett STAT19_WIKI_DIR / STAT19_DBT_DIR i .env.");
  }
  console.log("");
}

app.listen(PORT, "127.0.0.1", async () => {
  console.log(`Stat19-assistent API på http://127.0.0.1:${PORT}`);
  await reportReadiness();
});
