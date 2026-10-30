import type { ResourceServerExtension } from "@x402/core/types";
import {
  AGENT_HEADER,
  AGENT_ID_PATTERN,
  EXTENSION_KEY,
  KINDS_HEADER,
  RESULT_HEADER,
  WORK_HEADER,
  decodeJsonHeader,
  encodeJsonHeader,
  parseKinds,
  workAnswerSchema,
  type WorkExtension,
  type WorkResult,
} from "./protocol.js";

// The "useful-work" x402 extension, tool maker's side. On a 402 it asks Useful Work for a job and
// puts it under extensions["useful-work"]; when the agent retries with answers, it hands them to
// Useful Work and grants access if they pass. Paying stays possible the whole time.

export const DIRECTORY_URL = "https://usefulwork.app";

export interface DirectoryOptions {
  /** The key from your Useful Work dashboard ("<tool id>.<secret>"). */
  apiKey: string;
  /** Useful Work's address; you shouldn't need to change it. */
  url?: string;
  /** For tests. */
  fetch?: typeof globalThis.fetch;
}

interface RequestLike {
  adapter: { getHeader(name: string): string | undefined; getUrl(): string };
  paymentHeader?: string;
}

/** Results of answers submitted on this server, read back to set the response header. */
export const recentResults = new Map<string, WorkResult>();

function remember(jobId: string, result: WorkResult): void {
  recentResults.set(jobId, result);
  if (recentResults.size > 5_000) recentResults.delete(recentResults.keys().next().value as string);
}

const validAgent = (id: string | undefined): id is string => !!id && AGENT_ID_PATTERN.test(id);

function readAnswer(header: string | undefined) {
  if (!header) return null;
  try {
    const parsed = workAnswerSchema.safeParse(decodeJsonHeader(header));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The X-Useful-Work-Result header for a response a job unlocked, so the agent learns how its work
 * was judged: pass the request's X-Useful-Work header, set what comes back (if anything).
 */
export function workResultHeader(workHeader: string | undefined): { name: string; value: string } | null {
  const answer = readAnswer(workHeader);
  const result = answer ? recentResults.get(answer.jobId) : undefined;
  return result ? { name: RESULT_HEADER, value: encodeJsonHeader(result) } : null;
}

export function usefulWorkExtension(dir: DirectoryOptions): ResourceServerExtension {
  const base = (dir.url ?? DIRECTORY_URL).replace(/\/$/, "");
  const doFetch = dir.fetch ?? globalThis.fetch;
  const callDirectory = (path: string, body: unknown) =>
    doFetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${dir.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

  return {
    key: EXTENSION_KEY,
    // A paying agent echoes the 402's extensions back, and x402 checks the echo against a 402 built
    // afresh for the paid request. The job, or why there is none, differs every time (a paid request
    // is never offered work), so only the version is held to the echo; without this, nobody could pay.
    dynamicInfoFields: ["available", "reason", "job", "answer", "buys", "lastResult"],

    enrichPaymentRequiredResponse: async (_declaration, context): Promise<WorkExtension> => {
      const request = (context.transportContext as { request?: RequestLike } | undefined)?.request;
      const previous = readAnswer(request?.adapter.getHeader(WORK_HEADER));
      const lastResult = previous ? recentResults.get(previous.jobId) : undefined;
      // A request that carries a payment is being paid for; don't lease work nobody will do.
      if (!request || request.paymentHeader || request.adapter.getHeader("PAYMENT-SIGNATURE")) {
        return { version: 1, available: false, reason: "payment in progress", ...(lastResult ? { lastResult } : {}) };
      }
      const agent = request.adapter.getHeader(AGENT_HEADER);
      if (!validAgent(agent)) {
        return { version: 1, available: false, reason: `send an ${AGENT_HEADER} header (8-128 characters) to be offered work` };
      }
      // Agents say which kinds of job they can do; without the header they only get proofreading.
      const kinds = parseKinds(request.adapter.getHeader(KINDS_HEADER));
      // If Useful Work can't be reached, the 402 still goes out, with payment as the only way in.
      try {
        const res = await callDirectory("/v1/jobs", { agent, resource: request.adapter.getUrl(), kinds });
        if (!res.ok) return { version: 1, available: false, reason: "work queue unavailable; pay instead" };
        // Either a job, or { available: false, reason } explaining why there is none.
        return { ...((await res.json()) as WorkExtension), ...(lastResult ? { lastResult } : {}) };
      } catch {
        return { version: 1, available: false, reason: "work queue unavailable; pay instead" };
      }
    },

    transportHooks: {
      http: {
        onProtectedRequest: async (_declaration, context) => {
          const answer = readAnswer(context.adapter.getHeader(WORK_HEADER));
          const agent = context.adapter.getHeader(AGENT_HEADER);
          if (!answer || !validAgent(agent)) return; // no work offered back: normal payment flow
          let result: WorkResult;
          try {
            const res = await callDirectory(`/v1/jobs/${answer.jobId}/submit`, { agent, answer });
            result = ((await res.json().catch(() => null)) as WorkResult | null) ?? { status: "rejected", reason: "directory unavailable" };
          } catch {
            result = { status: "rejected", reason: "directory unavailable" };
          }
          remember(answer.jobId, result);
          if (result.status === "accepted") return { grantAccess: true };
          // Rejected: fall through to a fresh 402, which carries the reason and a new job.
        },
      },
    },
  };
}
