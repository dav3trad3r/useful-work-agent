import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, planRun } from "../src/options.js";

describe("command line", () => {
  it("does all three kinds of job with an OpenRouter key, on Haiku by default", () => {
    const plan = planRun([], { OPENROUTER_API_KEY: "sk-or-test" });
    expect(plan.kinds).toEqual(["proofread", "linkcheck", "fix"]);
    expect(plan.model).toEqual({
      via: "openai-compatible",
      service: "OpenRouter",
      model: DEFAULT_MODEL,
      apiKey: "sk-or-test",
      baseUrl: "https://openrouter.ai/api/v1",
      reportsCost: true,
    });
    expect(plan.provider).toBe(DEFAULT_PROVIDER);
    expect(plan.agentId).toBeNull();
    expect(plan.idleSeconds).toBe(60);
  });

  it("checks links only when there's no model key", () => {
    const plan = planRun([], {});
    expect(plan.kinds).toEqual(["linkcheck"]);
    expect(plan.model).toBeNull();
    expect(() => planRun(["--kinds", "proofread"], {})).toThrow(/need a model/);
  });

  it("uses an Anthropic key for Claude models only", () => {
    expect(planRun([], { ANTHROPIC_API_KEY: "sk-ant-test" }).model).toEqual({ via: "anthropic", service: "Anthropic", model: DEFAULT_MODEL, apiKey: "sk-ant-test", reportsCost: false });
    expect(() => planRun(["--model", "google/gemini-3.8-flash"], { ANTHROPIC_API_KEY: "sk-ant-test" })).toThrow(/only runs Claude/);
    expect(planRun([], { ANTHROPIC_API_KEY: "a", OPENROUTER_API_KEY: "o" }).model?.service).toBe("OpenRouter");
  });

  it("uses an OpenAI, Google or Groq key directly, with the model named", () => {
    expect(planRun(["--model", "gpt-5-mini"], { OPENAI_API_KEY: "sk-test" }).model).toMatchObject({ service: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-5-mini", apiKey: "sk-test" });
    expect(planRun(["--model", "gemini-3.8-flash"], { GEMINI_API_KEY: "g" }).model).toMatchObject({ service: "Google", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" });
    expect(planRun(["--model", "some-model"], { GROQ_API_KEY: "q" }).model).toMatchObject({ service: "Groq", baseUrl: "https://api.groq.com/openai/v1" });
    expect(() => planRun([], { OPENAI_API_KEY: "sk-test" })).toThrow(/OPENAI_API_KEY, say which OpenAI model/);
  });

  it("runs a model on this machine with no key, and any other server with one", () => {
    expect(planRun(["--base-url", "http://localhost:11434/v1/", "--model", "qwen3:8b"], {}).model).toEqual({
      via: "openai-compatible",
      service: "your server at localhost:11434",
      model: "qwen3:8b",
      baseUrl: "http://localhost:11434/v1",
      reportsCost: false,
    });
    expect(planRun(["--base-url", "http://192.168.1.20:1234/v1", "--model", "m"], {}).model?.apiKey).toBeUndefined();
    expect(planRun(["--base-url", "https://llm.example/v1", "--model", "m"], { LLM_API_KEY: "k" }).model).toMatchObject({ apiKey: "k", service: "your server at llm.example" });
    expect(planRun(["--base-url", "https://api.openai.com/v1", "--model", "m"], { OPENAI_API_KEY: "sk", OPENROUTER_API_KEY: "o" }).model).toMatchObject({ service: "OpenAI", apiKey: "sk" });
    expect(() => planRun(["--base-url", "https://llm.example/v1", "--model", "m"], {})).toThrow(/LLM_API_KEY/);
    expect(() => planRun(["--base-url", "http://llm.example/v1", "--model", "m"], { LLM_API_KEY: "k" })).toThrow(/https/);
    expect(() => planRun(["--base-url", "http://localhost:11434/v1"], {})).toThrow(/--model/);
    expect(() => planRun(["--base-url", "not a url", "--model", "m"], {})).toThrow(/--base-url/);
  });

  it("reads the options", () => {
    const plan = planRun(
      ["--model", "google/gemini-3.8-flash", "--kinds", "proofread, fix", "--id", "my-agent-01", "--jobs", "3", "--idle", "30", "--max-usd", "0.5", "--provider", "https://tools.example/"],
      { OPENROUTER_API_KEY: "k" },
    );
    expect(plan).toMatchObject({ kinds: ["proofread", "fix"], agentId: "my-agent-01", jobs: 3, idleSeconds: 30, maxUsd: 0.5, provider: "https://tools.example" });
    expect(plan.model?.model).toBe("google/gemini-3.8-flash");
  });

  it("refuses bad input with a plain reason", () => {
    expect(() => planRun(["--kinds", "proofread,translate"], { OPENROUTER_API_KEY: "k" })).toThrow(/--kinds takes/);
    expect(() => planRun(["--id", "short"], {})).toThrow(/8-128 characters/);
    expect(() => planRun(["--id", "has spaces in it"], {})).toThrow(/8-128 characters/);
    expect(() => planRun(["--jobs", "0"], {})).toThrow(/--jobs/);
    expect(() => planRun(["--idle", "1"], {})).toThrow(/--idle/);
    expect(() => planRun(["--max-usd", "1"], { ANTHROPIC_API_KEY: "a" })).toThrow(/OpenRouter/);
    expect(() => planRun(["--provider", "ftp://x"], {})).toThrow(/--provider/);
    expect(() => planRun(["--nope"], {})).toThrow();
  });

  it("takes the id and provider from the environment too", () => {
    expect(planRun([], { USEFUL_WORK_AGENT_ID: "env-agent-01", USEFUL_WORK_PROVIDER: "https://p.example" })).toMatchObject({ agentId: "env-agent-01", provider: "https://p.example" });
  });
});
