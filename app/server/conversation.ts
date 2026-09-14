import type Anthropic from "@anthropic-ai/sdk";

/**
 * Server-side conversation store, holding the real message blocks — tool_use and tool_result
 * included — for the chat windows this process is serving.
 *
 * It exists because the browser never sees tool results. The SSE stream carries only which
 * lookups happened (`tool`/`source` events), so a history rebuilt in the client is the model's
 * own prose and nothing else. Replaying that put the assistant's unverified claims back into
 * context as plain assistant text, indistinguishable from a fact it had looked up — which is
 * how an invented coverage period survived three turns and got firmer each time it was
 * repeated. Keeping the blocks here means a later turn can see what a claim was actually built
 * on, and that a claim was built on nothing.
 *
 * Deliberately in memory: a local single-user app, cleared on restart, no transcript on disk in
 * a repo that must never hold internal material. A restart falls back to the client's text-only
 * history, which is degraded but not wrong — the prompt tells the model to re-check anything it
 * cannot see a source for.
 */
export type Blocks = Anthropic.Beta.BetaMessageParam[];

/** Chat windows kept at once. Old ones are evicted least-recently-used. */
const MAX_CONVERSATIONS = 20;
/** Messages kept per conversation. Tool results are bulky; this is roughly a long session. */
const MAX_MESSAGES = 60;

const store = new Map<string, Blocks>();

/**
 * True for a message that starts a real turn — i.e. something the user typed, not the
 * tool_result blocks the API also carries in a `user` message. Trimming is only safe at these
 * boundaries: cut between a tool_use and its tool_result and the next request is rejected.
 */
function startsTurn(message: Anthropic.Beta.BetaMessageParam): boolean {
  if (message.role !== "user") return false;
  if (typeof message.content === "string") return true;
  return !message.content.some((block) => block.type === "tool_result");
}

function trim(messages: Blocks): Blocks {
  if (messages.length <= MAX_MESSAGES) return messages;
  for (let i = messages.length - MAX_MESSAGES; i < messages.length; i++) {
    if (startsTurn(messages[i])) return messages.slice(i);
  }
  // No safe cut point — keep everything rather than send a broken tool pairing.
  return messages;
}

export function loadConversation(id: string | undefined): Blocks | null {
  if (!id) return null;
  const messages = store.get(id);
  if (!messages) return null;
  // Refresh LRU position.
  store.delete(id);
  store.set(id, messages);
  return messages;
}

export function saveConversation(id: string | undefined, messages: Blocks): void {
  if (!id) return;
  store.delete(id);
  store.set(id, trim(messages));
  while (store.size > MAX_CONVERSATIONS) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

/** Drop one conversation — the client calls this when the user starts a new chat. */
export function forgetConversation(id: string | undefined): void {
  if (id) store.delete(id);
}

export function conversationStats(): { conversations: number; messages: number } {
  let messages = 0;
  for (const blocks of store.values()) messages += blocks.length;
  return { conversations: store.size, messages };
}
