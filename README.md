# Stat19 assistant

A local assistant for **statistikkteam in Stat19** at the Norwegian Institute of Public Health
(FHI): it assesses whether an assignment fits Stat19, proposes dataprodukter and variables, and
drafts the *statistikkprotokoll*. Answers are in Norwegian bokmål. Everything it knows comes from
two local snapshots — a clone of the Stat19 wiki and the dbt docs export.

> **No personal data in this repo**, and no database access. It is a drafting tool: every `[TBD]`
> and every proposed judgement needs a human check.

---

## 1. How to use this repo

```bash
git clone <this-repo> stat19-assistant
cd stat19-assistant
node setup.mjs
```

`setup.mjs` asks for your API key, installs dependencies and fetches both snapshots. Re-run it any
time to refresh — it prints what it could not reach.

## 2. What you need

**Node 20.12+**, **git**, and:

| | Needs |
| --- | --- |
| API key | your own [Anthropic key](https://console.anthropic.com/settings/keys); setup writes it to `.env` |
| Wiki clone | an FHI **account** with Stat19 access in Azure DevOps (a Personal Access Token — the account password will not work) |
| dbt metadata | the FHI **network** — an FHI PC or VPN; the host is IP-restricted |

The app runs anywhere and starts without either snapshot, saying what it lacks. Missing them, or
keeping them in a shared folder, is covered in **[SNAPSHOTS.md](SNAPSHOTS.md)**.

## 3. Run the app

```bash
node start.mjs             # or double-click start.command (macOS) / start.bat (Windows)
```

Opens at **http://localhost:5178** once the server is ready — chat on the left, wiki and
dataprodukt panels on the right. Ctrl+C stops it. Use it when you want to check an answer: click
a source link and read the page behind it.

## 4. Run the CLI

```bash
./stat19 "hvilke dataprodukter dekker ventetid?"
./stat19 --protocol "ventetid og abort" --save    # full draft → prosjekter/
cat oppdrag.md | ./stat19 --protocol              # a brief on stdin
./stat19 --help
```

`stat19.bat` on Windows. The answer goes to stdout and progress to stderr, so `> utkast.md` stays
clean. Use Sonnet or Opus for drafts; Haiku is fine for lookups.

The launcher compiles `server/` to plain JavaScript with `tsc` and runs it under `node`, rather
than using `tsx`. `tsx` drives esbuild, which spawns a native `esbuild.exe` from `node_modules`
— and application allowlisting (AppLocker) on an FHI PC blocks executables in user-writable
paths, so that dies with `spawn UNKNOWN`. `tsc` is pure JavaScript. The build is incremental, so
it adds about a second and can never go stale; `npm run cli:build` does it on its own. See
[`app/tsconfig.server.json`](app/tsconfig.server.json).

**The web app under that policy** — `start.mjs` checks whether esbuild can run, and when it
cannot it starts without Vite: it builds the client with `tsc` + Rollup
(`npm run build:noesbuild`, see [`app/build-client.mjs`](app/build-client.mjs)), compiles the
server, and serves both on one origin at <http://127.0.0.1:5179>. You still just double-click
`start.bat`. Rollup's native part is a `.node` addon, which such policies do not block — only
spawned `.exe` files are. Tailwind is built by its own CLI the same way. The cost is no hot
reload: after editing `client/`, re-run `npm run build:noesbuild`.

Use `npm run build` (Vite) wherever esbuild is allowed; the Rollup path is a fallback, not a
replacement, and both write the same `app/dist`. Getting `esbuild.exe` allowlisted by IT removes
the need for it.

---

## 5. Starting from scratch on a managed FHI Windows PC

These machines run application allowlisting (AppLocker): executables run only from allowlisted
locations, and `node_modules` is not one of them. Two things follow — Node has to come from IT,
and nothing that spawns a bundled `.exe` will work.

**Ask IT for this first**, because you cannot install it yourself — there is no local admin, and
a `winget --scope user` install lands in `AppData`, where it is blocked:

- **Node.js 20.12+ installed to `C:\Program Files\nodejs`.** That path is allowlisted.
- Optionally, `esbuild.exe` allowlisted as well. Not required — everything below works without
  it — but it makes `npm run dev` and `start.bat` behave as documented in sections 3 and 4.

You also need Git (already present and publisher-allowlisted on these machines), an FHI account
with Stat19 access in Azure DevOps, the FHI network or VPN for the dbt export, and your own
Anthropic key.

```bash
git clone <this-repo> stat19-assistant
cd stat19-assistant
node setup.mjs                                   # paste your key; a browser handles the SSO
cd app && npm install --ignore-scripts && cd ..
```

Expect two rough edges:

- **`node setup.mjs` reports `npm install feilet: spawnSync npm ENOENT`** and you must run the
  `npm install` yourself, as above. Setup runs `npm` with `shell: false`, and on Windows `npm`
  is `npm.cmd`, which cannot be spawned that way. This is unrelated to the allowlist — it fails
  on any Windows machine. Everything else in setup (key, wiki clone, dbt) works.
- **Keep `--ignore-scripts`.** A plain `npm install` dies in esbuild's postinstall, which tries
  to run the blocked binary, and then leaves a partly cleaned `node_modules` behind.

Then double-click **`start.bat`** for the app, or use `stat19.bat` for the CLI. Neither goes
through Vite or tsx on such a machine; section 4 explains why.

The snapshots can also be shared rather than fetched per machine — see
[SNAPSHOTS.md](SNAPSHOTS.md) for `STAT19_WIKI_DIR` and `STAT19_DBT_DIR`.

---

## Changing how it behaves

Edit **[`regler.md`](regler.md)**, not the code — it holds the domain rules, and both the app and
[Claude Code](https://claude.com/claude-code) read the same file.

| | |
| --- | --- |
| [`regler.md`](regler.md) | the domain rules — the system prompt |
| [`SNAPSHOTS.md`](SNAPSHOTS.md) | how to get the wiki and dbt data |
| [`app/README.md`](app/README.md) | how the app works: tools, costs, retrieval |
| `prosjekter/` | your working files; drafts are saved here |

## Licence

[MIT](LICENSE). The code is open; the data it reads is not — see *Never commit* below.

## Never commit

`Stat19.wiki`, `dbt`, `prosjekter/` and `.env` are git-ignored — **this repo is public** and that
material is internal. Check `git status --short` before pushing.
