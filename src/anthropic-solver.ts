import Anthropic from "@anthropic-ai/sdk";
import type { Solver } from "./client.js";
import { FIX_SYSTEM, SYSTEM, jobMessage, toAnswer, toFixAnswer, type ModelUsage } from "./llm-solver.js";
import { ISSUE_TYPES, type WorkAnswer, type WorkOffer } from "./protocol.js";

// Solve a job with Claude through Anthropic's own API, for builders with an Anthropic key rather
// than an OpenRouter one. Same rules as ./llm-solver.ts: one call per job, fixed instructions, the
// passages as data, no tools. The reply is held to a JSON schema, then parsed by the same code.

export interface AnthropicOptions {
  apiKey: string;
  /** An Anthropic model id ("claude-haiku-5-5"); OpenRouter-style ids ("anthropic/claude-haiku-5.5") are converted. */
  model: string;
  onUsage?: (usage: ModelUsage) => void;
  /** For tests: the fetch the SDK uses. */
  fetch?: typeof globalThis.fetch;
}

/** "anthropic/claude-haiku-5.5" -> "claude-haiku-5-5"; Anthropic ids pass through unchanged. */
export function toAnthropicModel(model: string): string {
  const bare = model.replace(/^anthropic\//, "");
  if (!bare.startsWith("claude-")) throw new Error(`an Anthropic key only runs Claude models, not ${model}`);
  return bare.replace(/\./g, "-");
}

const ISSUES_SCHEMA = {
  type: "object",
  properties: {
    answers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          item: { type: "string" },
          issues: {
            type: "array",
            items: {
              type: "object",
              properties: { type: { type: "string", enum: [...ISSUE_TYPES] }, quote: { type: "string" }, note: { type: "string" } },
              required: ["type", "quote", "note"],
              additionalProperties: false,
            },
          },
        },
        required: ["item", "issues"],
        additionalProperties: false,
      },
    },
  },
  required: ["answers"],
  additionalProperties: false,
};

const FIXES_SCHEMA = {
  type: "object",
  properties: {
    fixes: {
      type: "array",
      items: {
        type: "object",
        properties: { item: { type: "string" }, fix: { type: "string" } },
        required: ["item", "fix"],
        additionalProperties: false,
      },
    },
  },
  required: ["fixes"],
  additionalProperties: false,
};

export function anthropicSolver(opts: AnthropicOptions): Solver {
  const client = new Anthropic({ apiKey: opts.apiKey, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  const model = toAnthropicModel(opts.model);
  return async (offer: WorkOffer): Promise<WorkAnswer> => {
    if (offer.job.kind === "linkcheck") throw new Error("link checks are done in code (linkSolver), not by a model");
    const fix = offer.job.kind === "fix";
    const response = await client.messages.create(
      {
        model,
        max_tokens: 16000,
        system: fix ? FIX_SYSTEM : SYSTEM,
        messages: [{ role: "user", content: jobMessage(offer) }],
        output_config: { format: { type: "json_schema", schema: fix ? FIXES_SCHEMA : ISSUES_SCHEMA } },
      },
      { timeout: 60_000 },
    );
    opts.onUsage?.({ model, promptTokens: response.usage.input_tokens, completionTokens: response.usage.output_tokens, costUsd: null });
    if (response.stop_reason === "refusal") throw new Error("the model declined this job");
    const content = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    return fix ? toFixAnswer(offer, content) : toAnswer(offer, content);
  };
}
