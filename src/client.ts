import {
  AGENT_HEADER,
  EXTENSION_KEY,
  KINDS_HEADER,
  RESULT_HEADER,
  WORK_HEADER,
  decodeJsonHeader,
  encodeJsonHeader,
  workExtensionSchema,
  workResultSchema,
  type JobKind,
  type WorkAnswer,
  type WorkOffer,
  type WorkResult,
} from "./protocol.js";

// Wraps fetch so that a 402 carrying a "useful-work" job is answered with work instead of money.
// If no job is offered, the 402 is returned unchanged and the caller can pay (for example with
// @x402/fetch) instead.

export type Solver = (offer: WorkOffer) => Promise<WorkAnswer>;

export type WorkEvent =
  | { type: "offer"; jobId: string; kind: WorkOffer["job"]["kind"]; items: number }
  /** issues: problems found for proofreading, addresses checked for link checks, fixes given for fix jobs. */
  | { type: "solved"; jobId: string; kind: WorkOffer["job"]["kind"]; issues: number; ms: number }
  | { type: "result"; jobId: string; result: WorkResult }
  | { type: "no-work"; reason: string };

export interface WorkFetchOptions {
  agentId: string;
  /** Answers proofreading and fix jobs (see ./llm-solver.ts and ./anthropic-solver.ts). */
  solve?: Solver;
  /** Answers link-check jobs (see ./link-solver.ts). */
  checkLinks?: Solver;
  /** Which jobs to ask for; by default proofreading when solve is set, plus link checks when checkLinks is. */
  kinds?: JobKind[];
  fetch?: typeof globalThis.fetch;
  /** How many jobs to try for one request before giving up (a rejected answer brings a new job). */
  maxAttempts?: number;
  onEvent?: (event: WorkEvent) => void;
}

/** The "useful-work" part of a 402's PAYMENT-REQUIRED header (base64 JSON), or null. */
export function readWorkExtension(res: Response) {
  const header = res.headers.get("PAYMENT-REQUIRED");
  if (!header) return null;
  try {
    const required = decodeJsonHeader(header) as { extensions?: Record<string, unknown> };
    const parsed = workExtensionSchema.safeParse(required.extensions?.[EXTENSION_KEY]);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function defaultKinds(options: WorkFetchOptions): JobKind[] {
  const kinds: JobKind[] = [];
  if (options.solve) kinds.push("proofread");
  if (options.checkLinks) kinds.push("linkcheck");
  return kinds.length > 0 ? kinds : ["proofread"];
}

export function wrapFetchWithWork(options: WorkFetchOptions) {
  const baseFetch = options.fetch ?? globalThis.fetch;
  const maxAttempts = options.maxAttempts ?? 2;
  const emit = options.onEvent ?? (() => {});

  return async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set(AGENT_HEADER, options.agentId);
    headers.set(KINDS_HEADER, (options.kinds ?? defaultKinds(options)).join(","));
    let res = await baseFetch(input, { ...init, headers });

    for (let attempt = 0; attempt < maxAttempts && res.status === 402; attempt++) {
      const ext = readWorkExtension(res);
      if (!ext || !("job" in ext)) {
        emit({ type: "no-work", reason: ext && "reason" in ext ? ext.reason : "no useful-work offer in the 402" });
        return res;
      }
      const solver = ext.job.kind === "linkcheck" ? options.checkLinks : options.solve;
      if (!solver) {
        emit({ type: "no-work", reason: `offered a ${ext.job.kind} job this agent can't do` });
        return res;
      }
      emit({ type: "offer", jobId: ext.job.id, kind: ext.job.kind, items: ext.job.items.length });
      const started = Date.now();
      const answer = await solver(ext);
      const found = answer.links ? answer.links.length : answer.fixes ? answer.fixes.length : answer.answers.reduce((n, a) => n + a.issues.length, 0);
      emit({ type: "solved", jobId: ext.job.id, kind: ext.job.kind, issues: found, ms: Date.now() - started });

      const retryHeaders = new Headers(headers);
      retryHeaders.set(WORK_HEADER, encodeJsonHeader(answer));
      res = await baseFetch(input, { ...init, headers: retryHeaders });

      // The verdict comes back once: in a result header, or (on a fresh 402) as lastResult.
      const resultHeader = res.headers.get(RESULT_HEADER);
      const fromHeader = resultHeader ? workResultSchema.safeParse(safeDecode(resultHeader)) : null;
      if (fromHeader?.success) emit({ type: "result", jobId: ext.job.id, result: fromHeader.data });
      else if (res.status === 402) {
        const again = readWorkExtension(res);
        if (again?.lastResult) emit({ type: "result", jobId: ext.job.id, result: again.lastResult });
      }
    }
    return res;
  };
}

function safeDecode(header: string): unknown {
  try {
    return decodeJsonHeader(header);
  } catch {
    return null;
  }
}
