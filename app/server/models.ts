/**
 * Models offered in the UI. Request parameters differ by model generation:
 * Opus 5 / Sonnet 5 take adaptive thinking and output_config.effort, while
 * Haiku 4.5 predates both (effort is rejected there).
 *
 * Prices are USD per million tokens, first-party Anthropic API rates.
 * Haiku 4.5 is the cheapest current model — Haiku 3.5 and older are retired.
 */
export type ModelChoice = {
  id: string;
  label: string;
  hint: string;
  inputPrice: number;
  outputPrice: number;
  adaptiveThinking: boolean;
  effort: boolean;
};

export const MODELS: ModelChoice[] = [
  {
    id: "claude-opus-5",
    label: "Opus 5",
    hint: "best resonnering – anbefalt for protokoll og vurderinger",
    inputPrice: 5,
    outputPrice: 25,
    adaptiveThinking: true,
    effort: true,
  },
  {
    id: "claude-sonnet-5",
    label: "Sonnet 5",
    hint: "raskere og rimeligere – fin til oppslag og utprøving",
    inputPrice: 2,
    outputPrice: 10,
    adaptiveThinking: true,
    effort: true,
  },
  {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5",
    hint: "raskest – enklere resonnering",
    inputPrice: 1,
    outputPrice: 5,
    adaptiveThinking: false,
    effort: false,
  },
];

/** Lower effort = mindre tenketokens = billigere. Gjelder Opus 5 og Sonnet 5. */
export const EFFORTS = [
  { id: "low", label: "Lav", hint: "billigst – korte oppslag" },
  { id: "medium", label: "Middels", hint: "balansert" },
  { id: "high", label: "Høy", hint: "standard – grundig" },
] as const;

export type EffortId = (typeof EFFORTS)[number]["id"];
export const DEFAULT_EFFORT: EffortId = "high";

/** Never pass a client-supplied string straight to the API. */
export function resolveModel(id: string | undefined): ModelChoice {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}

export function resolveEffort(id: string | undefined): EffortId {
  return EFFORTS.some((e) => e.id === id) ? (id as EffortId) : DEFAULT_EFFORT;
}

/** Per-model request extras, so an unsupported parameter is never sent. */
export function modelParams(model: ModelChoice, effort: EffortId): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (model.adaptiveThinking) params.thinking = { type: "adaptive", display: "summarized" };
  if (model.effort) params.output_config = { effort };
  return params;
}

/** Rough USD cost of one turn, for the footer read-out while testing. */
export function estimateCost(
  model: ModelChoice,
  usage: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  } | null,
): number | null {
  if (!usage) return null;
  const fresh = usage.input_tokens ?? 0;
  const cached = usage.cache_read_input_tokens ?? 0;
  const out = usage.output_tokens ?? 0;
  // Cache reads bill at ~10% of the input rate.
  return (fresh * model.inputPrice + cached * model.inputPrice * 0.1 + out * model.outputPrice) / 1_000_000;
}
