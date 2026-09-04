import type { Attachment } from "./api.ts";

export type StreamHandlers = {
  onText: (delta: string) => void;
  onThinking: (delta: string) => void;
  onTool: (event: { tool: string; query?: string; count?: number }) => void;
  onSegmentEnd: (stopReason: string | null) => void;
  /** A source the model looked up — offered as a link in the chat, not opened by itself. */
  onSource: (event: { panel: "wiki" | "dbt"; id: string; title: string; query?: string }) => void;
  onError: (message: string) => void;
  onDone: (info?: {
    model?: string;
    costUsd?: number | null;
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  }) => void;
};

/**
 * POST the turn and parse the SSE response. Uses fetch rather than EventSource
 * because the request carries a body (history + attachments).
 */
export async function streamChat(
  body: {
    message: string;
    history: { role: "user" | "assistant"; content: string }[];
    attachments: Attachment[];
    model: string;
    effort: string;
  },
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    handlers.onError((await res.json().catch(() => ({}))).error ?? "Kunne ikke starte samtalen");
    handlers.onDone();
    return;
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;

    // SSE frames are separated by a blank line.
    let split: number;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);

      let event = "message";
      const dataLines: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7).trim();
        else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
      }
      if (!dataLines.length) continue;

      let payload: any;
      try {
        payload = JSON.parse(dataLines.join("\n"));
      } catch {
        continue;
      }

      if (event === "text") handlers.onText(payload);
      else if (event === "thinking") handlers.onThinking(payload);
      else if (event === "tool") handlers.onTool(payload);
      else if (event === "segment_end") handlers.onSegmentEnd(payload?.stop_reason ?? null);
      else if (event === "source") handlers.onSource(payload);
      else if (event === "error") handlers.onError(payload.message);
      else if (event === "done") handlers.onDone(payload);
    }
  }
  handlers.onDone();
}
