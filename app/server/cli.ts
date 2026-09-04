/**
 * Command-line Stat19 assistant. Same rules, same tools, same snapshots as the web app —
 * it just prints to a terminal instead of a browser.
 *
 *   ./stat19 "hvilke dataprodukter dekker ventetid?"
 *   ./stat19 --protocol "abort og ventetid" --save
 *   cat oppdrag.md | ./stat19 --protocol
 *
 * The answer goes to stdout and everything else to stderr, so redirects stay clean:
 *   ./stat19 --protocol "tema" > utkast.md
 */
import "./env.ts";
import { streamChat, type ChatEvent } from "./chat.ts";
import { MODELS, resolveEffort } from "./models.ts";
import { flattenPanelLinks, saveDraft } from "./save.ts";
import { loadDbt } from "./sources/dbt.ts";
import { loadWiki } from "./sources/wiki.ts";
import { getStatus } from "./status.ts";

const HELP = `Stat19-assistenten (CLI)

Bruk:
  stat19 [valg] "spørsmålet ditt"
  cat oppdrag.md | stat19 --protocol

Valg:
  -m, --model <opus|sonnet|haiku>   modell (standard: opus)
  -e, --effort <low|medium|high>    grundighet, gjelder opus og sonnet (standard: high)
  -p, --protocol                    ber om et fullt protokollutkast om temaet
  -s, --save                        lagre svaret i prosjekter/ som datostemplet .md
  -q, --quiet                       ikke vis oppslag underveis
  -h, --help                        denne teksten

Eksempler:
  stat19 "hvilke dataprodukter dekker ventetid?"
  stat19 -m sonnet -e low "hva er fnr_hash?"
  stat19 --protocol "ventetid og abort" --save
  stat19 --protocol "tema" > utkast.md
`;

/** Accepts short names as well as full ids, so nobody has to type claude-opus-5. */
function pickModel(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const found = MODELS.find((m) => m.id === name || m.id.includes(name.toLowerCase()));
  if (!found) {
    console.error(`Ukjent modell «${name}». Velg blant: ${MODELS.map((m) => m.id).join(", ")}`);
    process.exit(2);
  }
  return found.id;
}

function parseArgs(argv: string[]) {
  const opts = { protocol: false, save: false, quiet: false, help: false } as {
    model?: string;
    effort?: string;
    protocol: boolean;
    save: boolean;
    quiet: boolean;
    help: boolean;
  };
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-m" || arg === "--model") opts.model = argv[++i];
    else if (arg === "-e" || arg === "--effort") opts.effort = argv[++i];
    else if (arg === "-p" || arg === "--protocol") opts.protocol = true;
    else if (arg === "-s" || arg === "--save") opts.save = true;
    else if (arg === "-q" || arg === "--quiet") opts.quiet = true;
    else if (arg === "-h" || arg === "--help") opts.help = true;
    else if (arg.startsWith("-")) {
      console.error(`Ukjent valg «${arg}». Prøv --help.`);
      process.exit(2);
    } else words.push(arg);
  }
  return { opts, question: words.join(" ").trim() };
}

/**
 * Only called when no question was given on the command line. Reading stdin unconditionally
 * hangs whenever stdin is an open pipe that never closes — a script, a CI job, `nohup` — where
 * isTTY is false but no input is coming either.
 */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main(): Promise<void> {
  const { opts, question: fromArgs } = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  // Validate the model before doing any work, so a typo fails instantly.
  const modelId = pickModel(opts.model);

  // Arguments win; stdin is the fallback for `cat oppdrag.md | stat19 --protocol`.
  const topic = fromArgs || (await readStdin());
  if (!topic) {
    process.stderr.write(HELP);
    process.exit(2);
  }

  loadWiki();
  loadDbt();
  const status = await getStatus();
  if (!opts.quiet) {
    const stale = (s: boolean) => (s ? " (utdatert)" : "");
    console.error(
      `\x1b[2mwiki: ${status.wiki.pages} sider${stale(status.wiki.stale)} · ` +
        `dbt: ${status.dbt.sources} dataprodukter${stale(status.dbt.stale)}\x1b[0m`,
    );
    if (!status.wiki.present) console.error("\x1b[33mAdvarsel: ingen wiki lastet – kjør « node setup.mjs ».\x1b[0m");
  }

  const message = opts.protocol
    ? `Skriv et fullstendig utkast til statistikkprotokoll for dette temaet: ${topic}`
    : topic;

  // Text before a tool call is running commentary, not the answer. Keep only the last
  // segment, exactly as the web client does.
  let segment = "";
  let answer = "";
  let failed = false;

  const emit = (event: ChatEvent) => {
    switch (event.type) {
      case "text":
        segment += event.delta;
        break;
      case "tool":
        if (!opts.quiet) {
          const count = event.count === undefined ? "" : ` (${event.count})`;
          console.error(`\x1b[2m  ${event.tool}: ${event.query}${count}\x1b[0m`);
        }
        break;
      case "segment_end":
        // A segment that ended on a tool call was commentary; the final one is the answer.
        if (event.stop_reason !== "tool_use") answer = segment;
        segment = "";
        break;
      case "error":
        failed = true;
        console.error(`\x1b[31mFeil: ${event.message}\x1b[0m`);
        break;
      case "done":
        if (!opts.quiet && event.costUsd !== null) {
          const tokens = event.usage ? `${event.usage.input_tokens} inn / ${event.usage.output_tokens} ut · ` : "";
          console.error(`\x1b[2m${tokens}$${event.costUsd.toFixed(4)} · ${event.model}\x1b[0m`);
        }
        break;
    }
  };

  const aborted = new AbortController();
  process.on("SIGINT", () => aborted.abort());
  await streamChat(emit, [], message, [], modelId, resolveEffort(opts.effort), aborted.signal);

  // Panel links only work inside the web app; a terminal or a .md file wants plain text.
  const text = flattenPanelLinks((answer || segment).trim());
  if (!text) {
    if (!failed) console.error("Tomt svar.");
    process.exit(1);
  }
  process.stdout.write(text + "\n");

  if (opts.save) {
    // Name the file after the draft's own H1 when it has one, like the web app's save button.
    const heading = text.match(/^#\s+(.+)$/m)?.[1];
    const saved = saveDraft(heading ?? topic.slice(0, 60), text);
    console.error(`\x1b[32mLagret: ${saved.path}\x1b[0m`);
  }
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(`\x1b[31m${(err as Error).message}\x1b[0m`);
  process.exit(1);
});
