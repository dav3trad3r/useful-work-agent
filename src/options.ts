import { isIP } from "node:net";
import { parseArgs } from "node:util";
import { AGENT_ID_PATTERN, JOB_KINDS, type JobKind } from "./protocol.js";
import { isPrivateAddress } from "./safe-fetch.js";

// The command line, read into a plan without side effects, so it can be tested on its own.

export const DEFAULT_PROVIDER = "https://tools.usefulwork.app";
export const DEFAULT_MODEL = "anthropic/claude-haiku-5.5";

/** Model services the agent finds by their key alone, in the order it looks for them. */
const SERVICES = [
  { env: "OPENROUTER_API_KEY", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { env: "ANTHROPIC_API_KEY", name: "Anthropic", baseUrl: null },
  { env: "OPENAI_API_KEY", name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { env: "GEMINI_API_KEY", name: "Google", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { env: "GROQ_API_KEY", name: "Groq", baseUrl: "https://api.groq.com/openai/v1" },
] as const;

export const USAGE = `Usage: npx useful-work-agent [options]

Your agent asks Useful Work's tools for a job, does it, and gets the tool call free.
It keeps going until you stop it (Ctrl+C) or it reaches --jobs.

Options:
  --model <id>       Model for proofreading and fixes (default ${DEFAULT_MODEL} on OpenRouter
                     or Anthropic; name one for any other service)
  --base-url <url>   Any OpenAI-compatible model server, such as http://localhost:11434/v1 (Ollama)
                     or http://localhost:1234/v1 (LM Studio)
  --kinds <list>     Jobs to ask for: proofread,linkcheck,fix
                     (default: all three with a model; linkcheck alone without one)
  --id <agent id>    Your agent's id, 8-128 letters, digits and _ . : -
                     (default: one made up on first run and kept in ~/.useful-work-agent.json)
  --jobs <n>         Stop after answering this many jobs
  --idle <seconds>   How long to wait before asking again when there's no work (default 60)
  --max-usd <n>      Stop once model calls have cost this much (needs OpenRouter, which reports cost)
  --provider <url>   The tool provider to work for (default ${DEFAULT_PROVIDER})
  --help             Show this

Environment (the first key found is used):
  OPENROUTER_API_KEY     OpenRouter: any of its models with --model
  ANTHROPIC_API_KEY      Anthropic: Claude models only
  OPENAI_API_KEY         OpenAI (with --model)
  GEMINI_API_KEY         Google Gemini (with --model)
  GROQ_API_KEY           Groq (with --model)
  LLM_API_KEY            The key for --base-url, if its server needs one
  USEFUL_WORK_AGENT_ID   Same as --id
  USEFUL_WORK_PROVIDER   Same as --provider`;

export interface ModelPlan {
  via: "openai-compatible" | "anthropic";
  /** Who serves the model, for display: "OpenRouter", "OpenAI", "your server at localhost:11434"… */
  service: string;
  model: string;
  /** Absent for a local server that needs no key. */
  apiKey?: string;
  /** For OpenAI-compatible services. */
  baseUrl?: string;
  /** OpenRouter reports what each call cost. */
  reportsCost: boolean;
}

export interface RunPlan {
  help: boolean;
  provider: string;
  /** null: use the id saved on this computer, or make one up. */
  agentId: string | null;
  kinds: JobKind[];
  model: ModelPlan | null;
  jobs: number | null;
  idleSeconds: number;
  maxUsd: number | null;
}

type Env = Record<string, string | undefined>;

function number(value: string | undefined, name: string, min: number, integer: boolean): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) {
    throw new Error(`--${name} must be ${integer ? "a whole number" : "a number"} of at least ${min}`);
  }
  return n;
}

/** Plain http only to this machine or the local network, so a key never crosses the internet unencrypted. */
function isLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || (isIP(host) !== 0 && isPrivateAddress(host));
}

function pickModel(values: { model?: string; "base-url"?: string }, env: Env): ModelPlan | null {
  const key = (name: string) => env[name]?.trim() || undefined;

  if (values["base-url"] !== undefined) {
    let url: URL;
    try {
      url = new URL(values["base-url"]);
    } catch {
      throw new Error(`--base-url must be an address such as http://localhost:11434/v1, not ${values["base-url"]}`);
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHost(url.hostname))) {
      throw new Error("--base-url must start with https:// (plain http:// only for a server on this machine or your own network)");
    }
    const baseUrl = url.href.replace(/\/$/, "");
    const known = SERVICES.find((s) => s.baseUrl && new URL(s.baseUrl).hostname === url.hostname);
    const apiKey = key("LLM_API_KEY") ?? (known ? key(known.env) : undefined);
    if (!apiKey && !isLocalHost(url.hostname)) throw new Error(`set LLM_API_KEY${known ? ` or ${known.env}` : ""} to the key for ${url.host}`);
    if (!values.model) throw new Error("say which model to use with --model (the name your model server knows it by)");
    return {
      via: "openai-compatible",
      service: known?.name ?? `your server at ${url.host}`,
      model: values.model,
      ...(apiKey ? { apiKey } : {}),
      baseUrl,
      reportsCost: known?.name === "OpenRouter",
    };
  }

  const service = SERVICES.find((s) => key(s.env));
  if (!service) return null;
  const apiKey = key(service.env)!;
  if (service.baseUrl === null) {
    const model = values.model ?? DEFAULT_MODEL;
    if (!/^(anthropic\/)?claude-/.test(model)) throw new Error(`an Anthropic key only runs Claude models; set OPENROUTER_API_KEY to use ${model}`);
    return { via: "anthropic", service: service.name, model, apiKey, reportsCost: false };
  }
  const openRouter = service.name === "OpenRouter";
  if (!openRouter && !values.model) throw new Error(`with ${service.env}, say which ${service.name} model to use with --model`);
  return { via: "openai-compatible", service: service.name, model: values.model ?? DEFAULT_MODEL, apiKey, baseUrl: service.baseUrl, reportsCost: openRouter };
}

export function planRun(argv: string[], env: Env): RunPlan {
  const { values } = parseArgs({
    args: argv,
    options: {
      model: { type: "string" },
      "base-url": { type: "string" },
      kinds: { type: "string" },
      id: { type: "string" },
      jobs: { type: "string" },
      idle: { type: "string" },
      "max-usd": { type: "string" },
      provider: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });

  const provider = (values.provider ?? env.USEFUL_WORK_PROVIDER ?? DEFAULT_PROVIDER).replace(/\/$/, "");
  if (!/^https?:\/\/[^/]+/.test(provider)) throw new Error(`--provider must be an http(s) address, not ${provider}`);

  const agentId = values.id ?? env.USEFUL_WORK_AGENT_ID ?? null;
  if (agentId !== null && !AGENT_ID_PATTERN.test(agentId)) {
    throw new Error("the agent id must be 8-128 characters: letters, digits and _ . : -");
  }

  const model = pickModel(values, env);

  let kinds: JobKind[];
  if (values.kinds === undefined) kinds = model ? ["proofread", "linkcheck", "fix"] : ["linkcheck"];
  else {
    const asked = values.kinds.split(",").map((k) => k.trim()).filter(Boolean);
    const unknown = asked.filter((k) => !(JOB_KINDS as readonly string[]).includes(k));
    if (unknown.length > 0 || asked.length === 0) throw new Error(`--kinds takes ${JOB_KINDS.join(", ")} (got ${values.kinds})`);
    kinds = [...new Set(asked as JobKind[])];
  }
  if (!model && kinds.some((k) => k !== "linkcheck")) {
    throw new Error("proofreading and fixes need a model: set a model key (such as OPENROUTER_API_KEY) or --base-url, or run with --kinds linkcheck");
  }

  const maxUsd = number(values["max-usd"], "max-usd", 0.001, false);
  if (maxUsd !== null && !model?.reportsCost) throw new Error("--max-usd needs OpenRouter: only OpenRouter reports what each call cost");

  return {
    help: values.help ?? false,
    provider,
    agentId,
    kinds,
    model,
    jobs: number(values.jobs, "jobs", 1, true),
    idleSeconds: number(values.idle, "idle", 10, false) ?? 60,
    maxUsd,
  };
}
