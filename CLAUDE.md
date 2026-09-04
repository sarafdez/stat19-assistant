# Stat19 project assistant

Helps plan new **statistikkteam** / reviews in Stat19 and write the **statistikkprotokoll**.

**Reads:** 1) the wiki clone in `Stat19.wiki/`, 2) dbt metadata in `dbt/` (when present),
3) project info you give me — tema, PICO, timeline, deliverables.
**Answers:** which dataprodukter and variables fit, what time period they cover, whether Stat19
may be used for it at all, and a protocol draft.

Chat, deliverables, etc. in **Norwegian bokmål**.

## The faglige rules live in one file

@regler.md

If that import did not load (no rules about § 19 in your context), read `regler.md` before
answering anything faglig — do not fall back on memory.

That file is the single source of truth for the domain rules — § 19, propose-don't-interview,
coverage dates, what to do when the question can't be answered, and how to write a protocol draft.
The app reads the same file at runtime (`app/server/prompt.ts` → `readDomainRules()`), so a rule
changed there applies both here and in the app. **Never copy those rules back into this file.**

Everything below is about working *in this repo* — it does not belong in `regler.md`.

## Check snapshot age first, and say it out loud

Both sources are snapshots, not live. Before leaning on either:

```bash
git -C Stat19.wiki log -1 --date=short --format='wiki last edited %cd (%h %s)'
stat -f '%Sm  %N' -t '%Y-%m-%d %H:%M' dbt/*.json 2>/dev/null || echo "no dbt snapshot"
```

Report both dates in one line. Refresh both with `node setup.mjs` (clones or pulls the wiki and
re-downloads the dbt export), or just the wiki with `git -C Stat19.wiki pull --ff-only`.
The dbt files need the FHI network — if they're missing or old, say so instead of guessing
variable names. Both snapshot locations can be redirected with `STAT19_WIKI_DIR` /
`STAT19_DBT_DIR` in `.env`, so don't assume the default paths; `describePaths()` in
`app/server/paths.ts` resolves them.

## Getting dbt metadata (FHI network only)

The dbt docs host is IP-restricted (403 off the network). `node setup.mjs` downloads these two
files into `dbt/` (or unpacks a shared zip with `--from-zip`); on a machine without access they
can be copied in by hand. Full instructions: `SNAPSHOTS.md`.

- `…/manifest.json` — dataprodukter, team views, column descriptions, lineage, and the model SQL
  that shows each team's filtering. This is the main source of information from dbt.
  Dataprodukter are listed under `sources`; ignore `nodes`.
- `…/catalog.json` — real column names and data types

Metadata only, no person-level data. Everything can then be read and tested locally.

## Where things are

| Path | Contents |
| --- | --- |
| `regler.md` | the faglige rules — shared with the app's system prompt |
| `app/` | the local web app (see `app/README.md`); system prompt in `app/server/prompt.ts` |
| `setup.mjs` | one-command setup: deps, wiki clone/pull, dbt download, `.env` |
| `stat19` / `stat19.bat` | CLI launcher — `./stat19 --protocol "tema" --save` |
| `start.mjs` | cross-platform app launcher; `start.command`/`start.bat` just call it |
| `README.md` / `SNAPSHOTS.md` | user-facing docs, in English — setup and how to obtain the two snapshots |
| `prosjekter/` | working files — protocol drafts land here |
| `Stat19.wiki/` | the wiki clone (git-ignored, fetched by setup) |
| `dbt/` | the dbt export (git-ignored, fetched by setup) |

Inside the wiki clone:

| Path | Contents |
| --- | --- |
| `Statistikkteam/Mal%3A-protokoll-for-statistikkteam.md` | the protocol template |
| `Statistikkteam/Team-*.md` | ~20 real protocols; `Team-Abort.md` is the best example |
| `Dataprodukter-i-Stat19.md` + `Dataprodukter-i-Stat19/*.md` | one page per source (NPR, SykehusEPJ, MFR, Folkeregisteret, DÅR, MSIS, SYSVAK, LMR, KprKuhr …), incl. coverage and "Viktige begrensninger" |
| `Stat19-Wiki/Juridisk.md` | what Stat19 may and may not be used for |
| `Stat19-Wiki/Roller,-myndighet-og-ansvar/Teamleder/Tilgang-til-opplysninger-i-Stat19.md` | approval + data-ordering process |

Filenames encode punctuation (`%3A` = `:`, `%2D` = hyphen) and contain `,`, `!`, `å/æ/ø` — glob
for pages instead of guessing paths, and quote them in shell. Never edit inside `Stat19.wiki/`
(it's a clone; edits collide with the next pull); working files go in `prosjekter/`.

**This repo is public.** No person-level data in this folder, and never commit `Stat19.wiki`,
`dbt`, `prosjekter/` or `.env` — they are git-ignored because they hold internal FHI material.
Don't add absolute local paths to committed files (use the `STAT19_*_DIR` overrides). User-facing docs
(`README.md`, `SNAPSHOTS.md`) are in English; `regler.md` and the app's own UI stay in bokmål.

## Frontend

Lokal app i `app/` — chat til venstre, wiki-panel og dbt-panel til høyre.

Start: `node setup.mjs` én gang, deretter `node start.mjs` (eller dobbeltklikk `start.command` på
macOS / `start.bat` på Windows – begge er tynne wrappere rundt den). `cd app && npm run dev`
kjører serverne direkte (klient :5178, API :5179).

- Modell og grundighet velges i topplinja: Opus 5 / Sonnet 5 / Haiku 4.5, effort lav/middels/høy.
- React + TypeScript + Vite + Tailwind; Express-backend som kaller valgt modell med seks
  verktøy over de lokale snapshotene (`search_wiki`, `read_wiki_page`, `search_dbt`,
  `get_dbt_source`, `list_dbt_sources`, `get_protocol_template`).
- Systemprompten er `regler.md` + de app-spesifikke delene i `app/server/prompt.ts` (`APP_RULES`:
  identitet, stil, verktøybruk). Endrer du en faglig regel, endrer du `regler.md` — ett sted.
- Ferskhetsmerkene øverst kommer fra `git log -1` (wiki) og `manifest.metadata.generated_at` (dbt).
- Ingen framdriftskommentering: modellen skal kalle verktøy uten å annonsere det, og ikke skryte av
  mellomresultater. Kommentarer som likevel dukker opp havner i «arbeidslogg» i grensesnittet, ikke
  i svaret.
- Protokollutkast kan lastes ned som `.md`, kopieres, eller lagres i `prosjekter/` direkte fra
  svaret (`app/server/save.ts` – datostemplet, overskriver aldri, kun markdown i den mappa).
- Panelene følger ikke samtalen automatisk. Kildene modellen slår opp listes som klikkbare lenker
  i chatten; det er klikket som åpner siden i wiki- eller dataprodukt-panelet.
- `read_wiki_page` sender utdrag (relevante avsnitt + innholdsliste), ikke hele sider, for å holde
  token-bruken nede. Modellen kan hente flere avsnitt med `sections` eller hele siden med `full`.
- Merk: dbt dokumenterer kolonner med små bokstaver, mens SQL Server viser PascalCase. Appen
  slår dem sammen case-uavhengig og viser dbt-navnet i parentes når de er ulike.
- CLI: `./stat19 "spørsmål"` gir samme assistent uten nettleser (`app/server/cli.ts`). Begge
  flatene kaller samme `streamChat()`, som tar en `ChatSink`-callback – `index.ts` gjør eventene
  om til SSE, `cli.ts` skriver dem til stderr. Én verktøyimplementasjon, ikke to.
- Detaljer: `app/README.md`.
