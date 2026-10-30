import { serve } from "@hono/node-server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { Hono } from "hono";
// In your own project: from "useful-work-agent/tool-maker"
import {
  EXTENSION_KEY,
  VERDICT_HEADER,
  VerdictRejected,
  WORK_HEADER,
  approvedAmount,
  makeVerifier,
  usefulWorkExtension,
  verdictPrice,
  workResultHeader,
} from "../src/tool-maker.js";

// A minimal x402 server with one paid tool that agents can also pay for with useful work.
//
//   USEFUL_WORK_KEY    the key from your Useful Work dashboard
//   PAY_TO             your wallet: agents' payments and Useful Work's payouts arrive here
//   NETWORK            eip155:8453 (Base) for real; eip155:84532 (Base Sepolia) to try it out
//   FACILITATOR_URL    an x402 facilitator; x402.org's only settles testnet payments
//   SAIFURO_JWKS_URL, SAIFURO_ISSUER   only if you turned on verdict payouts

const NETWORK = (process.env.NETWORK ?? "eip155:84532") as `${string}:${string}`;
const PAY_TO = process.env.PAY_TO ?? "";
if (!process.env.USEFUL_WORK_KEY || !/^0x[0-9a-fA-F]{40}$/.test(PAY_TO)) throw new Error("set USEFUL_WORK_KEY and PAY_TO");

const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: process.env.FACILITATOR_URL ?? "https://x402.org/facilitator" }))
  .register(NETWORK, new ExactEvmScheme())
  .registerExtension(usefulWorkExtension({ apiKey: process.env.USEFUL_WORK_KEY }));

// Verdict payouts (optional): Useful Work pays each payout over x402 at POST /payouts/:id, with a
// signed Saifuro verdict you check before accepting the money.
const verifier =
  process.env.SAIFURO_JWKS_URL && process.env.SAIFURO_ISSUER ? makeVerifier({ jwksUrl: process.env.SAIFURO_JWKS_URL, issuer: process.env.SAIFURO_ISSUER }) : null;

const app = new Hono();
app.onError((err, c) => c.json({ error: err.message }, err instanceof VerdictRejected ? 403 : 400));

// Tell agents how their work was judged, on the response it unlocked.
app.use("/tools/*", async (c, next) => {
  await next();
  const result = workResultHeader(c.req.header(WORK_HEADER));
  if (result) c.header(result.name, result.value);
});

// Check the verdict before the payment flow starts; use up its nonce only when the payment itself
// arrives, so the unpaid first request doesn't burn it.
if (verifier) {
  app.use("/payouts/*", async (c, next) => {
    const token = c.req.header(VERDICT_HEADER);
    if (!token) return c.json({ error: `${VERDICT_HEADER} required` }, 403);
    const claims = await verifier.check(token, { amount: approvedAmount(token), currency: "USDC", recipient: PAY_TO });
    if (c.req.header("PAYMENT-SIGNATURE")) await verifier.consumeNonce(claims);
    await next();
  });
}

app.use(
  paymentMiddleware(
    {
      "GET /tools/word-count": {
        accepts: { scheme: "exact", price: "$0.002", network: NETWORK, payTo: PAY_TO },
        description: "Count the words in a text",
        mimeType: "application/json",
        // This is what offers agents a job instead of a payment.
        extensions: { [EXTENSION_KEY]: { version: 1 } },
      },
      ...(verifier
        ? {
            "POST /payouts/*": {
              accepts: { scheme: "exact", price: (ctx) => verdictPrice(ctx.adapter.getHeader(VERDICT_HEADER)), network: NETWORK, payTo: PAY_TO },
              description: "Payout for accepted jobs, authorized by a Saifuro verdict",
              mimeType: "application/json",
            },
          }
        : {}),
    },
    resourceServer,
  ),
);

app.get("/tools/word-count", (c) => c.json({ words: (c.req.query("text") ?? "").split(/\s+/).filter(Boolean).length }));
if (verifier) app.post("/payouts/:id", (c) => c.json({ received: true, payout: c.req.param("id") }));

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8789) }, (info) => console.log(`listening on :${info.port}`));
