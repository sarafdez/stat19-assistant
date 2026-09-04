# Stat19 assistant (local app)

Chat on the left, a wiki panel and a dataprodukt panel on the right. Everything runs locally on
`127.0.0.1`; the knowledge base is the wiki clone and the dbt export in the folder above.

For setup and how to obtain the two snapshots, see [`../README.md`](../README.md) and
[`../SNAPSHOTS.md`](../SNAPSHOTS.md).

## Running

First time: `node setup.mjs` in the folder above (installs, fetches wiki and dbt, writes `.env`).
Then double-click `start.command` (macOS) / `start.bat` (Windows), or from a terminal:

```bash
cd app
npm run dev          # client on :5178, API on :5179
```

Open http://localhost:5178. Stop with Ctrl+C. "+ Ny samtale" in the top bar clears the
conversation; the panels keep whatever you have open. Requires `ANTHROPIC_API_KEY` — either in
`../.env` (which `setup.mjs` writes) or as an environment variable; the environment wins. The
server prints what is missing of wiki, dbt, `regler.md` and the key at startup.

`npm run build` builds the client into `dist/`; `npm start` then serves everything from :5179 alone.

## How it answers

Model and effort are chosen next to the title (remembered in the browser). Opus 5 ($5/$25 per
million tokens) is the default; Sonnet 5 ($2/$10) and Haiku 4.5 ($1/$5) are cheaper — Haiku 4.5
is the cheapest model available. "Grundighet" (effort: low/medium/high) controls how much the
model thinks, and is the biggest cost lever after the model choice; it applies to Opus 5 and
Sonnet 5. Estimated cost for the last answer is shown under the input box.

Six tools: `search_wiki`, `read_wiki_page`, `search_dbt`, `get_dbt_source`, `list_dbt_sources`
and `get_protocol_template` (returns the template verbatim plus the list of approved protocols as
examples). Ask for a protocol draft and it is expected to fetch the template, look up the
dataprodukter, and write the whole draft.

The assistant **proposes** rather than interviews: forvaltningsoppgave, legal basis, population,
sources and dataprodukter are written as proposals you correct. Only what cannot be derived —
oppdragsgiver, område, avdeling, team members with FHI short names, dates, DevOps numbers and
styringsgruppe decisions — is left as `[TBD: …]` and asked about at the end. The rules come from
`../regler.md`: Norwegian bokmål, the § 19 framing, dataprodukt names rather than register names,
kodeverk always stated, and coverage dates taken from the wiki — never from dbt.

Every tool call appears as a chip in the chat, with the sources it found listed as links below.
The panels never open on their own; clicking a link (or a `wiki:`/`dbt:` link in the answer
itself) shows the page in the panel, marked "fra samtalen". Text the model writes *between* tool
calls ("Jeg skal hente…") is not the answer, and goes into a collapsed "arbeidslogg" above it —
the system prompt asks it to skip such commentary entirely. Both panels also work without the
model: each opens on a browsable overview and has its own search.

### Saving drafts

Under long answers (over 400 characters) there are three buttons:

- **⬇ Last ned som .md** — downloads the answer as a markdown file, named after the draft's own
  heading, e.g. `2026-08-27-statistikkprotokoll-team-ventetidabort.md`. The markdown pastes
  straight into the wiki.
- **Kopier** — the whole answer to the clipboard.
- **Lagre i prosjekter/** — writes the file to `../prosjekter/`, date-stamped. Never overwrites:
  if the name exists it becomes `-2`, `-3` and so on. The server writes markdown only, and only
  into that folder.

### The assistant's instructions

The system prompt is assembled from two parts, and the domain rules exist in exactly one place:

- **`../regler.md`** — the domain rules (§ 19, propose-don't-interview, coverage dates, protocol
  drafting). Read from disk on the first request and memoised. The same file is imported by
  `../CLAUDE.md`, so a rule changed here applies to both the app and Claude Code.
  **To change how the assistant reasons, edit that file — not the code.**
- `server/prompt.ts` (`APP_RULES`) — only the app-specific part: identity, language, style, and
  which tools exist.

If `regler.md` is missing the server still starts and the panels work, but the chat answers with a
clear error instead of running without rules (`readDomainRules()` in `server/prompt.ts`). Tool
descriptions — when and why the model looks something up — are in `server/chat.ts`.

### What is sent to the model

System prompt (~5 000 tokens estimated: `regler.md` + `APP_RULES`, the catalogue of all 45
dataprodukter, the snapshot dates) + the conversation history + your message + any attachments.
Wiki pages and column lists are sent only when the model actually calls a tool.

`read_wiki_page` returns **excerpts** of large pages: the sections matching the model's `query`,
always the introduction and any section on limitations or coverage, plus a table of contents the
model can order more from (`sections`) or fetch whole (`full=true`). That typically cuts 60 % of
the characters — SykehusEPJ.md alone goes from 23 800 to ~5 500. Pages under 4 000 characters are
sent whole. The panels in the UI still show complete pages; the excerpting applies only to what is
sent to the model. Nothing else in the folder is read. Token usage for the last answer is shown
under the input box.

## Files

| File | Responsibility |
| --- | --- |
| `server/sources/wiki.ts` | reads the wiki pages, MiniSearch index, decodes `%3A`/`%2D` in page names |
| `server/sources/dbt.ts` | reads `manifest.sources` (45 dataprodukter) + `catalog.json`; merges columns case-insensitively because dbt uses lowercase and SQL Server PascalCase |
| `server/status.ts` | freshness: `git log -1` for the wiki, `generated_at` for dbt |
| `server/paths.ts` | resolves the repo root and both snapshot locations, incl. `STAT19_*_DIR` overrides |
| `server/env.ts` | loads `../.env` before the SDK reads the key (imported first in `index.ts`) |
| `server/prompt.ts` | system prompt: reads `../regler.md`, adds `APP_RULES` + a compact catalogue of all dataprodukter |
| `server/models.ts` | model choice (Opus 5 / Sonnet 5 / Haiku 4.5) and which parameters each model accepts |
| `server/chat.ts` | tool loop (`toolRunner`, streaming), emitting transport-agnostic `ChatEvent`s |
| `server/cli.ts` | the command-line surface: same `streamChat`, printing to stdout/stderr |
| `client/*.tsx` | layout, chat, the two panels |

## Command line

`../stat19` (or `npm run cli`) runs the same assistant without a browser — see the root
[README](../README.md#4-run-the-cli). Both surfaces call the same `streamChat()`; it takes a
`ChatSink` callback rather than an HTTP response, and `index.ts` adapts those events into SSE
frames while `cli.ts` prints them. That is why there is one tool implementation, not two.

## Retrieval, and how to tell it is working

Both searches are lexical over small local corpora (175 wiki pages, 45 dataprodukter). The
failure that matters is not a missed hit — it is a query scoring well when nothing relevant
exists, because `regler.md` requires the assistant to separate *"this does not exist in Stat19"*
from *"I cannot find it in my snapshot"*, and it can only do that if a weak match is reported as
weak. So search returns a **verdict** (`ok` / `weak` / `empty-query`) and a normalised 0–1 score
alongside the hits, and the tool passes both to the model.

Unfiltered wiki results are also **grouped**: source pages (`Dataprodukter-i-Stat19/*`) are listed
separately from protocols and process pages. Long team protocols repeat a term far more often than
the short page that documents a dataprodukt, so on score alone `Dataprodukter-til-Team-RSV.md`
buries `Dataprodukter-i-Stat19/MSIS.md`. Grouping keeps the canonical page visible without
pretending a team page is never the right answer — it often is, as protocol precedent.

`server/sources/norsk.ts` holds the Norwegian query handling: a stopword list, ø/å folding,
word-boundary rather than substring matching, the compound linking *-s-* so `bostedskommune`
reaches the column `BostedKommune_Nummer`, and the synonym map.

### The synonym map, and extending it

Its job is to bridge **question language** to **register language**. A teamleder asks about
`svangerskapsavbrudd`; the metadata says `abort`. They ask about `ventetid`; the column is called
`ansienDato`. They ask about `antibiotikabruk`; the answer is in `lmr` under ATC codes. Nothing in
the metadata connects those pairs, so without the map the two vocabularies never meet.

It carries two kinds of entry: **register synonyms** (`abort ↔ svangerskapsavbrudd`) and
**clinical vocabulary → register vocabulary** (`hjerteinfarkt → icd, diagnose, npr`). The second
kind matters because no dataprodukt is named after a disease — a question about hjerteinfarkt is
answered from ICD-10 codes in NPR's diagnosis columns, and the map is what points there.

**Yes, extend it — that is the intended way to improve retrieval.** Each entry is one line, and
the whole map is readable and correctable by a domain expert, which is not true of an embedding
space. Two rules:

- **Add a fixture case with every entry.** A wrong synonym is worse than a missing one: an early
  `bestille → dataprodukt` entry buried the access page under every dataprodukt page, and only
  the eval caught it. Expansions are weighted below direct hits, but they still move ranking.
- **Do not add a synonym for something Stat19 genuinely lacks.** `innvandrerbakgrunn` and
  `utdanningsnivå` come from SSB; they are fixture cases asserting the search returns *nothing*.
  Making them "findable" would make the assistant confidently wrong.

Missing vocabulary shows up as `verdict: "weak"` on a question that should have an answer. The
quickest way to find gaps is to type real questions at the app and watch for it.

```bash
cd app && npm run eval
```

30 cases in `server/eval/fixture.ts`: real questions with the dataprodukt or page they should
find, plus queries Stat19 genuinely cannot answer that must come back as *nothing*. **The right
response to "the search gave me a bad answer" is to add a case**, which turns an impression into
a number that either moves or does not. Before this fixture existed, `kvantefysikk på månen`
outscored `ventetid` three to one.

---

## Possible future improvements

**Enrich dbt metadata from [helsedata.no](https://helsedata.no/).** The real limit on retrieval
is not the algorithm — **590 of 1354 dbt columns have no description at all**. `ansienDato` is a
bare name, so no search, lexical or semantic, can connect it to a question about *ventetid*; there
is no text to match. helsedata.no publishes the national variable catalogue for the same
registries, built to the national metadata specification (DCAT/SKOS), and would supply exactly
that missing text.

Sketched design, not built:

- A script fetches the catalogue once and writes `dbt/helsedata_overlay.json`; `sources/dbt.ts`
  merges it only where a column's own description is empty, tagging provenance so the assistant
  says *"described in helsedata.no as …"* rather than presenting it as Stat19's own documentation.
- Enrichment, not a per-query lookup — that keeps the offline-snapshot property everything else
  rests on, and makes staleness visible like the other two snapshots.
- Two open questions first: does the catalogue expose a machine-readable endpoint (no public API
  was found when this was written), and does a crosswalk exist between register variable names and
  the warehouse names dbt reports (`ansienDato` vs `ansiennitetsdato`)? Expect the mapping to need
  hand-checking for high-value variables; automatic fuzzy matching would mismatch silently.
- Caveat to carry into the design: helsedata describes what the **register** holds, while Stat19
  receives a subset, before the register's own QA. Coverage years especially must keep coming from
  the wiki, as `regler.md` already requires.

Measured first: filling all 590 descriptions with synthetic text moved the worst noise query by
11% and the rest not at all, so enrichment can be added without regressing precision. Run
`npm run eval` before and after to confirm on real data.

**Semantic search** is deliberately *not* on this list yet. It needs an embedding provider,
re-embedding on every wiki pull, and it fixes none of the measured problems — undescribed columns
stay invisible either way. Worth revisiting once the overlay exists and you can measure what
still misses.

---

## Limits

- No personal data here — wiki text, metadata and protocol drafts only.
- The app never writes inside the wiki clone (it is a clone; edits collide with the next pull).
- `.env`, `Stat19.wiki`, `dbt` and `prosjekter/` are git-ignored — never commit them.
- No database access: row counts and load logs must be checked inside the analysis room.
