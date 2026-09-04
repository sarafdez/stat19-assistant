/**
 * Retrieval eval: `npm run eval` from app/.
 *
 * Reports recall on real questions and, just as importantly, whether queries with no answer
 * in Stat19 are reported as weak rather than as confident noise.
 */
import "../env.ts";
import { loadDbt, searchDbtDetailed } from "../sources/dbt.ts";
import { loadWiki, searchWikiDetailed } from "../sources/wiki.ts";
import { CASES } from "./fixture.ts";

loadWiki();
loadDbt();

const c = { green: "\x1b[32m", red: "\x1b[31m", dim: "\x1b[2m", bold: "\x1b[1m", off: "\x1b[0m" };
const hit = (found: string[], expected: string[]) =>
  expected.some((e) => found.some((f) => f.toLowerCase().includes(e.toLowerCase())));

let pass = 0;
let fail = 0;
const failures: string[] = [];

console.log(`${c.bold}Retrieval eval${c.off}\n`);
for (const testCase of CASES) {
  const dbt = searchDbtDetailed(testCase.query, 5);
  // Mirror the search_wiki tool: search wide, then narrow to the section, so a filter never
  // starves the result list.
  const wikiAll = searchWikiDetailed(testCase.query, testCase.wikiSection ? 40 : 5);
  const wiki = testCase.wikiSection
    ? { ...wikiAll, hits: wikiAll.hits.filter((h) => h.id.startsWith(testCase.wikiSection!)).slice(0, 5) }
    : wikiAll;
  const dbtIds = dbt.hits.map((h) => h.label);
  const wikiIds = wiki.hits.map((h) => h.id);
  const checks: { label: string; ok: boolean; detail: string }[] = [];

  if (testCase.nothing) {
    // Either surface claiming a confident hit is the failure we care about.
    checks.push({
      label: "dbt reports nothing",
      ok: dbt.verdict !== "ok",
      detail: `verdict=${dbt.verdict} top=${dbtIds[0] ?? "–"}@${dbt.hits[0]?.score.toFixed(2) ?? "–"}`,
    });
    checks.push({
      label: "wiki reports nothing",
      ok: wiki.verdict !== "ok",
      detail: `verdict=${wiki.verdict} top=${wikiIds[0]?.split("/").at(-1) ?? "–"}@${wiki.hits[0]?.raw ?? "–"}`,
    });
  }
  if (testCase.dbt) {
    checks.push({
      label: `dbt finds ${testCase.dbt.join("|")}`,
      ok: dbt.verdict === "ok" && hit(dbtIds, testCase.dbt),
      detail: `${dbt.verdict}: ${dbtIds.slice(0, 3).join(", ") || "ingen"}`,
    });
  }
  if (testCase.wiki) {
    checks.push({
      label: `wiki finds ${testCase.wiki.join("|")}`,
      ok: wiki.verdict === "ok" && hit(wikiIds, testCase.wiki),
      detail: `${wiki.verdict}: ${wikiIds.slice(0, 3).map((i) => i.split("/").at(-1)).join(", ") || "ingen"}`,
    });
  }

  const allOk = checks.every((check) => check.ok);
  allOk ? pass++ : fail++;
  console.log(`${allOk ? c.green + "✔" : c.red + "✖"}${c.off} "${testCase.query}"`);
  for (const check of checks) {
    if (!check.ok) {
      console.log(`   ${c.red}${check.label}${c.off} — ${c.dim}${check.detail}${c.off}`);
      failures.push(`"${testCase.query}": ${check.label} (${check.detail})`);
    }
  }
}

console.log(`\n${c.bold}${pass}/${pass + fail} saker${c.off}`);
if (fail) {
  console.log(`${c.red}${fail} feilet${c.off}`);
  process.exit(1);
}
