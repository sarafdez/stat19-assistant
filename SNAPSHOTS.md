# Getting the two data snapshots

The assistant has no database access and no live connection. Everything it knows comes from two
**local snapshots** that you provide:

| Snapshot | Default location | What the assistant gets from it |
| --- | --- | --- |
| The Stat19 **wiki** (an Azure DevOps wiki repo) | `./Stat19.wiki` | Descriptions of each dataprodukt, which years it covers, "Viktige begrensninger", the legal pages, the protocol template, and ~20 approved protocols |
| The **dbt docs** export (two JSON files) | `./dbt` | The real dataprodukt names (`source.<project>.<register>.<table>`) and the real column names and types |

Neither is committed to this repo, and neither should be — they describe internal FHI systems and
the wiki text is internal material, so `.gitignore` excludes both and you should keep it that way.
**This repo is public.**

Both are optional in the sense that the app starts without them — but an assistant with no wiki
has nothing to reason from, and with no dbt export it must say variable names are unverified
rather than state them. Get at least the wiki.

---

## Just run setup

```bash
node setup.mjs
```

Both source locations are built in, so there is nothing to configure first. Setup fetches what it
can and tells you plainly what it could not. It is safe to re-run any time — that is also how you
refresh both snapshots later.

The rest of this page is for when that is not enough: no Azure DevOps credentials, no access to
the dbt host, or snapshots you keep somewhere other than this folder.

---

## The wiki

### If you can reach Azure DevOps

`node setup.mjs` clones it the first time and pulls on every later run. You can also do it by hand
(the remote is printed by setup, and is the `STAT19_WIKI_REMOTE` default):

```bash
git clone --depth 1 <wiki-remote> Stat19.wiki
```

**You will have to authenticate, and your account password will not work over HTTPS.** Azure
DevOps needs one of:

- **Windows** — Git for Windows bundles Git Credential Manager, which opens a browser for SSO.
  This usually just works; if no window appears, update Git from https://git-scm.com/download/win
- **macOS / Linux** — no credential manager by default. Either install one:
  ```bash
  brew install --cask git-credential-manager
  ```
  or create a **Personal Access Token**: Azure DevOps → *User settings* → *Personal access
  tokens* → *New token*, scope **Code: Read**. When git asks for a password, paste the token.
  The token is then cached in your OS keychain, so you only do this once.

Once cloned, `node setup.mjs` keeps it up to date with `git pull --ff-only` and needs no
credentials again — the clone remembers its own origin. The app can also
pull it from the freshness badge in the top bar.

**Never edit files inside the clone.** Edits collide with the next pull. Your own working files
belong in `prosjekter/`.

### If you cannot reach Azure DevOps

Have someone copy the wiki folder to you — it is only markdown — and either put it at
`./Stat19.wiki` or point `STAT19_WIKI_DIR` at wherever you keep it. The app reads a plain folder
of `.md` files just as happily as a git clone; it simply cannot refresh it for you, and the
freshness badge will show no date.

---

## The dbt export

Two files are needed, `manifest.json` and `catalog.json`. The dbt docs site serves them over HTTP
at its root, next to `index.html` — that is how the dbt UI itself loads them, and how
`node setup.mjs` downloads them.

**The dbt docs host is IP-restricted.** From outside the FHI network you get HTTP 403, no matter
how the URL is spelled. There are three ways in:

**1. On the network (or VPN)** — just run setup:
```bash
node setup.mjs
```

**2. From a zip somebody shared with you** — the usual route for a laptop that cannot reach the
host. Someone with access exports the docs folder, zips it, and sends it to you:
```bash
node setup.mjs --from-zip ~/Downloads/stat19_dbt_docs_2026-08-22.zip
```
The two JSON files may sit in a subfolder inside the zip; setup searches the tree, validates that
each file really is dbt JSON, and copies only `manifest.json` and `catalog.json` into place. It
never overwrites a working snapshot with something that failed validation.

**3. By hand** — copy `manifest.json` and `catalog.json` into `./dbt` (or wherever
`STAT19_DBT_DIR` points). No unpacking or renaming needed; the files work exactly as exported.

### Keeping a shared copy

If several people share one export through OneDrive or a network drive, do not copy it into every
clone. Point each machine at the shared folder instead:

```bash
STAT19_DBT_DIR=~/OneDrive/stat19_agent/dbt_docs
```

One caveat: OneDrive files can be "online only". If the app reports the export as missing while
the folder looks full, open the folder in Finder or Explorer and make the files available offline.

### What the export does and does not contain

Structural metadata only — schema, table and column names, data types, model SQL, test
definitions, build timings. **No row-level data, no row counts, no personal identifiers.** Person
identifiers appear only as hashed *column names* (e.g. `fnr_hash`) — names, never values.

It does describe internal architecture and names active projects, though. Treat it as internal:
keep it out of the repo and out of anything public.

---

## Checking what you actually have

The server prints this at startup:

```
Grunnlag:
  ✔ wiki: 175 sider
  ! dbt: mangler – variabelnavn blir uverifiserte. Krever FHI-nettet: node setup.mjs
  ✔ regler.md: 10016 tegn i systemprompten
  ✔ ANTHROPIC_API_KEY er satt
```

If something is missing it also prints where it looked, so a wrong `STAT19_*_DIR` looks like a
wrong path rather than like missing data. The app's top bar shows the age of both snapshots, and
the assistant is instructed to say so when it answers anything date-dependent — and to
distinguish "this does not exist in Stat19" from "this is not in my snapshot".

---

## Refreshing

| What | How | How often |
| --- | --- | --- |
| Both | `node setup.mjs` | whenever the badge says stale |
| Wiki only | `git -C Stat19.wiki pull --ff-only`, or the button in the app | wiki changes often; flagged stale after 7 days |
| dbt only | `node setup.mjs` on the network, or a fresh zip | flagged stale after 30 days |

Coverage periods — which years a dataprodukt actually holds data for — are **not** in the dbt
metadata. They live on the wiki source pages, which is why a stale wiki matters more than a stale
dbt export.
