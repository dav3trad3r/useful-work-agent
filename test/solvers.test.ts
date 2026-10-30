import { describe, expect, it } from "vitest";
import { anthropicSolver, toAnthropicModel } from "../src/anthropic-solver.js";
import { linkSolver } from "../src/link-solver.js";
import { chatRequest, llmSolver, toAnswer, toFixAnswer } from "../src/llm-solver.js";
import type { WorkOffer } from "../src/protocol.js";

const proofread: WorkOffer = {
  version: 1,
  job: {
    id: "8f0b7a3e-1c2d-4e5f-9a8b-7c6d5e4f3a2b",
    kind: "proofread",
    instructions: "check",
    items: [
      { item: "i1", text: "We recieve deliveries." },
      { item: "i2", text: "Open daily." },
    ],
    issueTypes: ["typo"],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  },
  answer: { header: "X-Useful-Work", encoding: "base64-json" },
  buys: "one call",
};

const fix: WorkOffer = {
  ...proofread,
  job: {
    id: proofread.job.id,
    kind: "fix",
    instructions: "fix",
    items: [{ item: "i1", text: "We recieve deliveries.", quote: "recieve", type: "typo" }],
    expiresAt: proofread.job.expiresAt,
  },
};

/** A fetch that records each request body and answers with a fixed JSON body. */
function recorder(reply: unknown) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetch = async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { bodies, fetch: fetch as typeof globalThis.fetch };
}

describe("parsing a model's reply", () => {
  it("keeps well-formed issues for known items and fills in missing items", () => {
    const answer = toAnswer(proofread, '```json\n{"answers":[{"item":"i1","issues":[{"type":"typo","quote":"recieve"},{"type":"nonsense","quote":"x"}]},{"item":"i9","issues":[{"type":"typo","quote":"y"}]}]}\n```');
    expect(answer.answers).toEqual([
      { item: "i1", issues: [{ type: "typo", quote: "recieve" }] },
      { item: "i2", issues: [] },
    ]);
  });

  it("survives a reply that isn't JSON", () => {
    expect(toAnswer(proofread, "sorry, I can't").answers.every((a) => a.issues.length === 0)).toBe(true);
  });

  it("keeps one fix per item in the job", () => {
    expect(toFixAnswer(fix, '{"fixes":[{"item":"i1","fix":"receive"},{"item":"i7","fix":"x"}]}').fixes).toEqual([{ item: "i1", fix: "receive" }]);
  });
});

describe("OpenRouter solver", () => {
  it("asks Gemini to think briefly and leaves Claude as it is", async () => {
    const reply = { choices: [{ message: { content: '{"answers":[]}' } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 } };
    const gemini = recorder(reply);
    await llmSolver({ apiKey: "k", model: "google/gemini-3.8-flash", fetch: gemini.fetch })(proofread);
    expect(gemini.bodies[0]!.reasoning).toEqual({ effort: "low" });
    const claude = recorder(reply);
    await llmSolver({ apiKey: "k", model: "anthropic/claude-haiku-5.5", fetch: claude.fetch })(proofread);
    expect(claude.bodies[0]!.reasoning).toBeUndefined();
  });

  it("sends the passages as data in a call of their own, with no tools", async () => {
    const usage: number[] = [];
    const rec = recorder({ choices: [{ message: { content: '{"answers":[{"item":"i1","issues":[{"type":"typo","quote":"recieve"}]}]}' } }], usage: { cost: 0.0002 } });
    const answer = await llmSolver({ apiKey: "k", model: "anthropic/claude-haiku-5.5", fetch: rec.fetch, onUsage: (u) => usage.push(u.costUsd ?? -1) })(proofread);
    const body = rec.bodies[0]!;
    expect(body.tools).toBeUndefined();
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(JSON.parse(messages[1]!.content).passages).toEqual(proofread.job.items);
    expect(answer.answers[0]!.issues).toHaveLength(1);
    expect(usage).toEqual([0.0002]);
  });

  it("asks OpenAI's reasoning models the way they need, and Gemini direct to think briefly", () => {
    const openAi = chatRequest({ model: "gpt-5-mini", baseUrl: "https://api.openai.com/v1" }, proofread);
    expect(openAi).toMatchObject({ max_completion_tokens: 6000, reasoning_effort: "low" });
    expect(openAi).not.toHaveProperty("max_tokens");
    expect(openAi).not.toHaveProperty("temperature");
    expect(chatRequest({ model: "gpt-4.1-mini", baseUrl: "https://api.openai.com/v1" }, proofread)).toMatchObject({ max_completion_tokens: 3000, temperature: 0 });
    expect(chatRequest({ model: "gemini-3.8-flash", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" }, proofread)).toMatchObject({ reasoning_effort: "low", max_tokens: 3000 });
    const local = chatRequest({ model: "qwen3:8b", baseUrl: "http://localhost:11434/v1" }, proofread);
    expect(local).toMatchObject({ max_tokens: 3000, temperature: 0, response_format: { type: "json_object" } });
    expect(local).not.toHaveProperty("usage");
    expect(local).not.toHaveProperty("reasoning");
  });

  it("sends no key to a local server, and drops JSON mode if the server refuses it", async () => {
    const seen: Array<{ auth: string | null; json: boolean }> = [];
    const fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      seen.push({ auth: new Headers(init?.headers).get("authorization"), json: "response_format" in body });
      if ("response_format" in body) return new Response("'response_format.type' must be 'json_schema'", { status: 400 });
      return Response.json({ choices: [{ message: { content: '<think>a typo here</think>\nSure: {"answers":[{"item":"i1","issues":[{"type":"typo","quote":"recieve"}]}]}' } }] });
    }) as typeof globalThis.fetch;
    const solve = llmSolver({ model: "local-model", baseUrl: "http://localhost:1234/v1", fetch });
    expect((await solve(proofread)).answers[0]!.issues).toEqual([{ type: "typo", quote: "recieve" }]);
    await solve(proofread);
    expect(seen).toEqual([
      { auth: null, json: true },
      { auth: null, json: false },
      { auth: null, json: false },
    ]);
  });

  it("refuses link-check jobs, which are done in code", async () => {
    const link = { ...proofread, job: { id: proofread.job.id, kind: "linkcheck" as const, instructions: "", items: [{ item: "i1", url: "https://example.com/", check: "link" as const }], expiresAt: "" } };
    await expect(llmSolver({ apiKey: "k", model: "m" })(link)).rejects.toThrow(/in code/);
    await expect(linkSolver(proofread)).rejects.toThrow(/only does link-check/);
  });
});

describe("Anthropic solver", () => {
  it("turns OpenRouter-style ids into Anthropic ones and refuses other makers' models", () => {
    expect(toAnthropicModel("anthropic/claude-haiku-5.5")).toBe("claude-haiku-5-5");
    expect(toAnthropicModel("claude-haiku-5-5")).toBe("claude-haiku-5-5");
    expect(() => toAnthropicModel("google/gemini-3.8-flash")).toThrow(/Claude models/);
  });

  it("holds the reply to a JSON schema and parses it like any other", async () => {
    const rec = recorder({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-haiku-5-5",
      content: [{ type: "text", text: '{"fixes":[{"item":"i1","fix":"receive"}]}' }],
      stop_reason: "end_turn",
      usage: { input_tokens: 120, output_tokens: 20 },
    });
    const answer = await anthropicSolver({ apiKey: "k", model: "anthropic/claude-haiku-5.5", fetch: rec.fetch })(fix);
    const body = rec.bodies[0]!;
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.tools).toBeUndefined();
    expect((body.output_config as { format: { type: string } }).format.type).toBe("json_schema");
    expect(answer.fixes).toEqual([{ item: "i1", fix: "receive" }]);
  });
});
