import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTVerifyGetKey } from "jose";

// The seller's side of Saifuro, as documented: verify the signature locally against the public
// key set, then check the claims against the deal in front of you, then treat a repeated nonce
// as a replay. Nothing here calls Saifuro. Tool makers who turn on verdict payouts use this on
// their POST /payouts/:id route.

export const VERDICT_HEADER = "X-Saifuro-Verdict";

export interface Deal {
  amount: number;
  currency: string;
  recipient: string;
}

export interface VerdictClaims {
  jti: string;
  verdict: string;
  mandate?: string;
  nonce: string;
  exp: number;
  request: { agent: string; amount: number; currency: string; recipient: string; category: string };
}

export class VerdictRejected extends Error {}

/** Where seen nonces are kept. add() is true the first time a nonce is seen, false after. */
export interface NonceStore {
  add(nonce: string, expiresAtMs: number): Promise<boolean>;
}

/**
 * Nonces kept in this process until their verdict expires. Fine for one server; with several,
 * give makeVerifier a shared store (a database unique key, or Redis SET NX) instead.
 */
export function memoryNonceStore(): NonceStore {
  const seen = new Map<string, number>();
  return {
    async add(nonce, expiresAtMs) {
      const now = Date.now();
      for (const [n, exp] of seen) if (exp <= now) seen.delete(n);
      if (seen.has(nonce)) return false;
      seen.set(nonce, expiresAtMs);
      return true;
    },
  };
}

export function makeVerifier(opts: { jwksUrl: string; issuer: string; rejectKidPrefix?: string; jwks?: JWTVerifyGetKey; nonces?: NonceStore }) {
  // Saifuro's key set allows five minutes of caching; jose's default is ten.
  const jwks = opts.jwks ?? createRemoteJWKSet(new URL(opts.jwksUrl), { cacheMaxAge: 300_000 });
  // Real Saifuro sandbox keys start "sandbox-" and must never count as approvals.
  const rejectKidPrefix = opts.rejectKidPrefix ?? "sandbox-";
  const nonces = opts.nonces ?? memoryNonceStore();

  /** Verify signature and claims for a deal. Does not consume the nonce. */
  async function check(token: string, deal?: Deal): Promise<VerdictClaims> {
    let payload: Record<string, unknown>;
    let kid: string | undefined;
    try {
      const result = await jwtVerify(token, jwks, {
        issuer: opts.issuer,
        algorithms: ["ES256"],
        requiredClaims: ["exp", "iat", "nonce", "verdict", "request"],
      });
      payload = result.payload as Record<string, unknown>;
      kid = result.protectedHeader.kid;
    } catch (err) {
      throw new VerdictRejected(`verdict signature or expiry invalid: ${(err as Error).message}`);
    }
    if (kid?.startsWith(rejectKidPrefix)) throw new VerdictRejected("sandbox verdict: never a production approval");
    const claims = payload as unknown as VerdictClaims;
    if (claims.verdict !== "allow") throw new VerdictRejected(`not an approval: ${claims.verdict}`);
    if (deal) {
      const r = claims.request;
      if (r.amount !== deal.amount || r.currency !== deal.currency || r.recipient.toLowerCase() !== deal.recipient.toLowerCase()) {
        throw new VerdictRejected("approval is for a different transaction");
      }
    }
    return claims;
  }

  /** Record the nonce once; a second sighting is a replay. */
  async function consumeNonce(claims: Pick<VerdictClaims, "nonce" | "exp">): Promise<void> {
    if (!(await nonces.add(claims.nonce, claims.exp * 1000))) throw new VerdictRejected("replayed verdict");
  }

  return { check, consumeNonce };
}

/** The amount a verdict approves, read without verifying it: check() does that. */
export function approvedAmount(token: string | undefined): number {
  let amount = Number.NaN;
  try {
    amount = Number((decodeJwt(token ?? "").request as { amount?: number } | undefined)?.amount);
  } catch {
    // not a JWT
  }
  if (!Number.isFinite(amount) || amount <= 0) throw new VerdictRejected("no approved amount");
  return amount;
}

/** A payout is charged at exactly the amount the verdict approved: use this as the route's x402 price. */
export const verdictPrice = (token: string | undefined): string => `$${approvedAmount(token).toFixed(6)}`;
