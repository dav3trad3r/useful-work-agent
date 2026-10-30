import { describe, expect, it } from "vitest";
import { wrapFetchWithWork, type WorkEvent } from "../src/client.js";
import { AGENT_HEADER, KINDS_HEADER, RESULT_HEADER, WORK_HEADER, decodeJsonHeader, encodeJsonHeader, type WorkOffer } from "../src/protocol.js";

const offer = (id: string): WorkOffer => ({
  version: 1,
  job: {
    id,
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
});

const JOB_1 = "8f0b7a3e-1c2d-4e5f-9a8b-7c6d5e4f3a2b";
const JOB_2 = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d";

/** A 402 shaped the way an x402 server sends it: the PaymentRequired object, base64 JSON. */
function paymentRequired(extension: unknown): Response {
  const required = encodeJsonHeader({ x402Version: 2, resource: { url: "https://tools.example/x" }, accepts: [], extensions: { "useful-work": extension } });
  return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": required } });
}

describe("work-paying fetch", () => {
  it("answers a 402 job and retries with the answer, agent id and kinds", async () => {
    const calls: Headers[] = [];
    const fakeFetch = async (_input: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push(headers);
      if (!headers.has(WORK_HEADER)) return paymentRequired(offer(JOB_1));
      return new Response('{"ok":true}', { status: 200, headers: { [RESULT_HEADER]: encodeJsonHeader({ status: "accepted", reason: "ok" }) } });
    };
    const events: WorkEvent[] = [];
    const workFetch = wrapFetchWithWork({
      agentId: "test-agent-123",
      fetch: fakeFetch as typeof fetch,
      kinds: ["proofread", "fix"],
      solve: async (o) => ({ jobId: o.job.id, answers: [{ item: "i1", issues: [{ type: "typo", quote: "recieve" }] }] }),
      onEvent: (e) => events.push(e),
    });
    const res = await workFetch("https://tools.example/x");
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.get(AGENT_HEADER)).toBe("test-agent-123");
    expect(calls[0]!.get(KINDS_HEADER)).toBe("proofread,fix");
    expect(decodeJsonHeader(calls[1]!.get(WORK_HEADER)!)).toMatchObject({ jobId: JOB_1 });
    expect(events.map((e) => e.type)).toEqual(["offer", "solved", "result"]);
    expect(events[1]).toMatchObject({ kind: "proofread", issues: 1 });
  });

  it("reports a rejected answer once, then does the next job it's given", async () => {
    let call = 0;
    const fakeFetch = async () => {
      call++;
      if (call === 1) return paymentRequired(offer(JOB_1));
      // Rejected: a fresh 402 with the reason (also in the result header) and a new job.
      if (call === 2) {
        const res = paymentRequired({ ...offer(JOB_2), lastResult: { status: "rejected", reason: "missed 1 of 1 known errors" } });
        res.headers.set(RESULT_HEADER, encodeJsonHeader({ status: "rejected", reason: "missed 1 of 1 known errors" }));
        return res;
      }
      return new Response("{}", { status: 200, headers: { [RESULT_HEADER]: encodeJsonHeader({ status: "accepted" }) } });
    };
    const results: string[] = [];
    const workFetch = wrapFetchWithWork({
      agentId: "test-agent-123",
      fetch: fakeFetch as typeof fetch,
      solve: async (o) => ({ jobId: o.job.id, answers: [] }),
      onEvent: (e) => e.type === "result" && results.push(`${e.jobId}:${e.result.status}`),
    });
    expect((await workFetch("https://tools.example/x")).status).toBe(200);
    expect(results).toEqual([`${JOB_1}:rejected`, `${JOB_2}:accepted`]);
  });

  it("returns the 402 untouched when no job is offered, so the caller can pay", async () => {
    const reasons: string[] = [];
    const fakeFetch = async () => paymentRequired({ version: 1, available: false, reason: "no funded work right now; pay instead" });
    const workFetch = wrapFetchWithWork({
      agentId: "test-agent-123",
      fetch: fakeFetch as typeof fetch,
      solve: async () => {
        throw new Error("should not solve");
      },
      onEvent: (e) => e.type === "no-work" && reasons.push(e.reason),
    });
    expect((await workFetch("https://tools.example/x")).status).toBe(402);
    expect(reasons).toEqual(["no funded work right now; pay instead"]);
  });

  it("asks only for link checks when it can only check links, and turns down other work", async () => {
    let kinds: string | null = null;
    const fakeFetch = async (_input: unknown, init?: RequestInit) => {
      kinds = new Headers(init?.headers).get(KINDS_HEADER);
      return paymentRequired(offer(JOB_1));
    };
    const reasons: string[] = [];
    const workFetch = wrapFetchWithWork({
      agentId: "test-agent-123",
      fetch: fakeFetch as typeof fetch,
      checkLinks: async () => {
        throw new Error("should not check");
      },
      onEvent: (e) => e.type === "no-work" && reasons.push(e.reason),
    });
    expect((await workFetch("https://tools.example/x")).status).toBe(402);
    expect(kinds).toBe("linkcheck");
    expect(reasons).toEqual(["offered a proofread job this agent can't do"]);
  });

  it("ignores a 402 with no payment header at all", async () => {
    const workFetch = wrapFetchWithWork({ agentId: "test-agent-123", fetch: (async () => new Response("{}", { status: 402 })) as typeof fetch });
    expect((await workFetch("https://tools.example/x")).status).toBe(402);
  });
});
