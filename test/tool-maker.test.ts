import { x402ResourceServer } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { usefulWorkExtension, workResultHeader } from "../src/extension.js";
import { AGENT_HEADER, KINDS_HEADER, RESULT_HEADER, WORK_HEADER, decodeJsonHeader, encodeJsonHeader } from "../src/protocol.js";
import { VerdictRejected, approvedAmount, makeVerifier, verdictPrice } from "../src/verdict.js";

const JOB = "8f0b7a3e-1c2d-4e5f-9a8b-7c6d5e4f3a2b";
const job = {
  version: 1,
  job: { id: JOB, kind: "proofread", instructions: "check", items: [{ item: "i1", text: "We recieve deliveries." }], issueTypes: ["typo"], expiresAt: "2026-10-30T00:00:00Z" },
  answer: { header: "X-Useful-Work", encoding: "base64-json" },
  buys: "one call to https://tools.example/tools/x",
};

/** A stand-in for Useful Work: records each call and answers from the given handler. */
function directory(handler: (path: string, body: Record<string, unknown>) => unknown) {
  const calls: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
  const fetch = async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url, auth: new Headers(init?.headers).get("authorization"), body });
    return Response.json(handler(new URL(url).pathname, body));
  };
  return { calls, fetch: fetch as typeof globalThis.fetch };
}

/** The request as x402's Hono adapter presents it to the extension. */
function request(headers: Record<string, string>, paymentHeader?: string) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { adapter: { getHeader: (name: string) => lower[name.toLowerCase()], getUrl: () => "https://tools.example/tools/x" }, paymentHeader };
}

type Ext = ReturnType<typeof usefulWorkExtension>;
const enrich = (ext: Ext, req: ReturnType<typeof request>) =>
  ext.enrichPaymentRequiredResponse!({} as never, { transportContext: { request: req } } as never) as Promise<Record<string, unknown>>;
const submit = (ext: Ext, req: ReturnType<typeof request>) => ext.transportHooks!.http!.onProtectedRequest!({} as never, req as never, {} as never);

const answer = (jobId = JOB) => encodeJsonHeader({ jobId, answers: [{ item: "i1", issues: [{ type: "typo", quote: "recieve" }] }] });

describe("the x402 extension", () => {
  it("leases a job from Useful Work with the tool's key, for the agent and kinds it names", async () => {
    const dir = directory(() => job);
    const ext = usefulWorkExtension({ apiKey: "my-tool.secret", url: "https://uw.example/", fetch: dir.fetch });
    const offer = await enrich(ext, request({ [AGENT_HEADER]: "agent-12345678", [KINDS_HEADER]: "proofread,linkcheck" }));
    expect(offer).toMatchObject({ job: { id: JOB } });
    expect(dir.calls).toEqual([
      { url: "https://uw.example/v1/jobs", auth: "Bearer my-tool.secret", body: { agent: "agent-12345678", resource: "https://tools.example/tools/x", kinds: ["proofread", "linkcheck"] } },
    ]);
  });

  it("offers no work without an agent id, or while the request is being paid for", async () => {
    const dir = directory(() => job);
    const ext = usefulWorkExtension({ apiKey: "k", fetch: dir.fetch });
    expect(await enrich(ext, request({}))).toMatchObject({ available: false, reason: expect.stringMatching(/X-Useful-Work-Agent/) });
    expect(await enrich(ext, request({ [AGENT_HEADER]: "agent-12345678" }, "signed-payment"))).toMatchObject({ available: false, reason: "payment in progress" });
    expect(dir.calls).toHaveLength(0);
  });

  it("still sends the 402, with payment as the only way in, when Useful Work can't be reached", async () => {
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const ext = usefulWorkExtension({ apiKey: "k", fetch: down });
    expect(await enrich(ext, request({ [AGENT_HEADER]: "agent-12345678" }))).toEqual({ version: 1, available: false, reason: "work queue unavailable; pay instead" });
    expect(await submit(ext, request({ [AGENT_HEADER]: "agent-12345678", [WORK_HEADER]: answer() }))).toBeUndefined();
  });

  it("grants access for an accepted answer and tells the agent so", async () => {
    const dir = directory(() => ({ status: "accepted", reason: "ok" }));
    const ext = usefulWorkExtension({ apiKey: "k", fetch: dir.fetch });
    const work = answer();
    expect(await submit(ext, request({ [AGENT_HEADER]: "agent-12345678", [WORK_HEADER]: work }))).toEqual({ grantAccess: true });
    expect(dir.calls[0]!.url).toBe(`https://usefulwork.app/v1/jobs/${JOB}/submit`);
    const header = workResultHeader(work);
    expect(header?.name).toBe(RESULT_HEADER);
    expect(decodeJsonHeader(header!.value)).toEqual({ status: "accepted", reason: "ok" });
  });

  it("refuses a rejected answer, and the next 402 carries the reason", async () => {
    const other = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d";
    const dir = directory((path) => (path.endsWith("/submit") ? { status: "rejected", reason: "missed 1 of 1 known errors" } : job));
    const ext = usefulWorkExtension({ apiKey: "k", fetch: dir.fetch });
    const req = request({ [AGENT_HEADER]: "agent-12345678", [WORK_HEADER]: answer(other) });
    expect(await submit(ext, req)).toBeUndefined();
    expect(await enrich(ext, req)).toMatchObject({ job: { id: JOB }, lastResult: { status: "rejected", reason: "missed 1 of 1 known errors" } });
  });

  it("lets an agent pay cash: the 402's extensions, echoed back, pass x402's check", async () => {
    const dir = directory(() => job);
    const ext = usefulWorkExtension({ apiKey: "k", fetch: dir.fetch });
    const accepts: PaymentRequirements[] = [{ scheme: "exact", network: "eip155:8453", amount: "2000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PROVIDER, maxTimeoutSeconds: 60, extra: {} }];
    const declared = { "useful-work": { version: 1 } };
    const agent = { [AGENT_HEADER]: "agent-12345678" };
    // The first 402 offers a job; the paid retry is rebuilt with "payment in progress" instead.
    const check = async (extension: Ext) => {
      const server = new x402ResourceServer([]).registerExtension(extension);
      const first = await server.createPaymentRequiredResponse(accepts, { url: "https://tools.example/tools/x" }, "Payment required", declared, { request: request(agent) });
      const paid = await server.createPaymentRequiredResponse(accepts, { url: "https://tools.example/tools/x" }, "Payment required", declared, { request: request(agent, "signed-payment") });
      expect(first.extensions?.["useful-work"]).toMatchObject({ job: { id: JOB } });
      expect(paid.extensions?.["useful-work"]).toMatchObject({ reason: "payment in progress" });
      return server.validateExtensions(paid, { x402Version: 2, accepted: accepts[0]!, payload: {}, extensions: first.extensions } as PaymentPayload);
    };
    expect(await check(ext)).toEqual({ valid: true });
    // Without the dynamic fields, the same echo is refused: the bug this guards against.
    expect(await check({ ...ext, dynamicInfoFields: undefined })).toMatchObject({ valid: false, invalidReason: "extension_echo_mismatch" });
  });

  it("ignores answers that aren't well formed", async () => {
    const dir = directory(() => ({ status: "accepted" }));
    const ext = usefulWorkExtension({ apiKey: "k", fetch: dir.fetch });
    expect(await submit(ext, request({ [AGENT_HEADER]: "agent-12345678", [WORK_HEADER]: "not base64 json" }))).toBeUndefined();
    expect(dir.calls).toHaveLength(0);
    expect(workResultHeader(undefined)).toBeNull();
  });
});

const ISSUER = "https://saifuro.example";
const PROVIDER = "0x1111111111111111111111111111111111111111";
let sign: (claims: Record<string, unknown>, kid?: string, exp?: number) => Promise<string>;
let verifier: ReturnType<typeof makeVerifier>;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const jwks = createLocalJWKSet({
    keys: [
      { ...(await exportJWK(publicKey)), kid: "key-1", alg: "ES256" },
      { ...(await exportJWK(publicKey)), kid: "sandbox-1", alg: "ES256" },
    ],
  });
  verifier = makeVerifier({ jwksUrl: "https://unused.example", issuer: ISSUER, jwks });
  sign = (claims, kid = "key-1", exp = Math.floor(Date.now() / 1000) + 300) =>
    new SignJWT(claims).setProtectedHeader({ alg: "ES256", kid }).setIssuer(ISSUER).setIssuedAt().setExpirationTime(exp).sign(privateKey);
});

const approval = {
  verdict: "allow",
  mandate: "mnd_1",
  nonce: "n_1",
  request: { agent: "agt_site_1", amount: 0.016, currency: "USDC", recipient: PROVIDER, category: "site_checks" },
};
const deal = { amount: 0.016, currency: "USDC", recipient: PROVIDER };

describe("payout verdicts", () => {
  it("accepts a signed approval for exactly this deal, once", async () => {
    const token = await sign(approval);
    const claims = await verifier.check(token, deal);
    expect(claims.nonce).toBe("n_1");
    await verifier.consumeNonce(claims);
    await expect(verifier.consumeNonce(claims)).rejects.toThrow("replayed verdict");
  });

  it("prices the payout at exactly the approved amount", async () => {
    const token = await sign(approval);
    expect(approvedAmount(token)).toBe(0.016);
    expect(verdictPrice(token)).toBe("$0.016000");
    expect(() => verdictPrice(undefined)).toThrow(VerdictRejected);
  });

  it("rejects a denial, even though it is signed", async () => {
    await expect(verifier.check(await sign({ ...approval, verdict: "deny_velocity" }), deal)).rejects.toThrow("not an approval: deny_velocity");
  });

  it("rejects an approval for a different amount or recipient", async () => {
    await expect(verifier.check(await sign(approval), { ...deal, amount: 0.017 })).rejects.toThrow(VerdictRejected);
    await expect(verifier.check(await sign(approval), { ...deal, recipient: "0x2222222222222222222222222222222222222222" })).rejects.toThrow(VerdictRejected);
  });

  it("rejects sandbox-signed and expired verdicts", async () => {
    await expect(verifier.check(await sign(approval, "sandbox-1"), deal)).rejects.toThrow(/sandbox/);
    await expect(verifier.check(await sign(approval, "key-1", Math.floor(Date.now() / 1000) - 10), deal)).rejects.toThrow(/expiry|exp/);
  });

  it("rejects a token signed by someone else", async () => {
    const { privateKey } = await generateKeyPair("ES256");
    const forged = await new SignJWT(approval).setProtectedHeader({ alg: "ES256", kid: "key-1" }).setIssuer(ISSUER).setIssuedAt().setExpirationTime("5m").sign(privateKey);
    await expect(verifier.check(forged, deal)).rejects.toThrow(VerdictRejected);
  });
});
