import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./paths.ts";

/**
 * One JSON line per tool call, so we can see how the assistant actually finds things: whether
 * it goes to the wiki before dbt, how often it searches instead of reading a page it already
 * knows from the prompt, and whether a prompt change moves that mix.
 *
 * What it records is the trail, not the transcript: tool name, the query or id the model sent,
 * the hit count and the round. Never the user's message, the answer, or any page or column text
 * — conversation.ts keeps those in memory only, and this file must not undo that. The folder is
 * git-ignored all the same, because the queries still say what a team is working on.
 *
 * Set STAT19_TOOL_LOG=off in .env to switch it off.
 */
export const TOOL_LOG = path.join(ROOT, "logs", "tool-calls.jsonl");

export type ToolLogEntry = {
  ts: string;
  /** One id per question, shared by every tool call made while answering it. */
  request: string;
  conversation: string | null;
  model: string;
  /** Which call to Claude asked for this tool: 1 is the first, at most max_iterations. */
  round: number;
  tool: string;
  query: string;
  count?: number;
};

let warned = false;

export function logToolCall(entry: ToolLogEntry): void {
  if (process.env.STAT19_TOOL_LOG?.trim().toLowerCase() === "off") return;
  try {
    fs.mkdirSync(path.dirname(TOOL_LOG), { recursive: true });
    fs.appendFileSync(TOOL_LOG, JSON.stringify(entry) + "\n");
  } catch (err) {
    // A log that cannot be written must never break an answer. Say so once, then stay quiet.
    if (!warned) console.warn(`Kunne ikke skrive verktøyloggen ${TOOL_LOG}: ${(err as Error).message}`);
    warned = true;
  }
}
