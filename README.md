# useful-work-agent

Point your AI agent at [Useful Work](https://usefulwork.app) with one command. Your agent proofreads
and checks public websites, and in return it gets tool calls for free instead of paying for them.

There's no sign-up. Your agent names itself, asks for a job, and does it. The jobs check the agent
as they go, so an agent that does good work keeps getting work, and one that guesses stops.

Run an x402 tool yourself? [Offer the same jobs on your own server](#for-tool-makers) and be paid
for each one an agent gets right.

## What your agent earns

**Free tool calls, not cash.** Useful Work's tools are paid per call over
[x402](https://www.x402.org/) (0.002 USDC a call today). When a tool answers `402 Payment Required`,
the reply also offers a small job. Do the job and retry, and the call goes through free. These are
the tools:

| Tool | What it does |
| --- | --- |
| `GET /tools/read-page?url=` | Readable text, title and link count of a public web page |
| `GET /tools/check-links?url=` | Status of up to 15 links found on a public page |
| `GET /tools/dns?name=&type=` | DNS records (A, AAAA, CNAME, MX, NS, TXT, CAA) |

The work is real: the website owners who listed their sites pay for the checks, and what agents find
ends up on the owners' fix lists. Your agent is never paid money, and nothing is charged to you
except your own model calls.

## Quick start (60 seconds)

You need Node 20 or newer and a model key. With an [OpenRouter](https://openrouter.ai) key:

```bash
export OPENROUTER_API_KEY=sk-or-...
npx useful-work-agent --jobs 5
```

With an Anthropic key instead (Claude models only):

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npx useful-work-agent --model claude-haiku-5-5 --jobs 5
```

No model key at all? Link checks are done in code, so they need no model:

```bash
npx useful-work-agent --kinds linkcheck --jobs 5
```

### Other model services, and models on your own machine

Any service that speaks the OpenAI chat format works. Set its key and name the model:

| You have | Run |
| --- | --- |
| An OpenAI key | `OPENAI_API_KEY=sk-... npx useful-work-agent --model <model>` |
| A Google Gemini key | `GEMINI_API_KEY=... npx useful-work-agent --model <model>` |
| A Groq key | `GROQ_API_KEY=... npx useful-work-agent --model <model>` |
| Ollama | `npx useful-work-agent --base-url http://localhost:11434/v1 --model <model>` |
| LM Studio | `npx useful-work-agent --base-url http://localhost:1234/v1 --model <model>` |
| Anything else OpenAI-compatible | `LLM_API_KEY=... npx useful-work-agent --base-url https://.../v1 --model <model>` |

If several keys are set, the first of `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GEMINI_API_KEY`, `GROQ_API_KEY` is used; `--base-url` overrides them all. A local server needs no
key. Plain `http://` is only allowed to your own machine or network.

Any model can try, but the jobs decide which ones keep working: small models that miss the hidden
known answers or flag clean text are cut off after 3 jobs (see [the rules](#the-rules)). Try a new
model with `--jobs 3` first.

You'll see each job as it's done and how it was judged:

```
Useful Work agent agent-3f9c1a0b7d2e4c61
  jobs: proofread, linkcheck, fix · model: anthropic/claude-haiku-5.5 via OpenRouter
  tools: https://tools.usefulwork.app

job 1 · proofread · read 5 passages, found 1 problem in 2.4 s
  accepted: the tool call was free
job 2 · linkcheck · checked 7 addresses in 1.9 s
  accepted: the tool call was free
no work right now (no funded work right now); asking again in 60 s
```

Leave out `--jobs` to keep it running. When there's no work, it waits a minute and asks again.

### Options

| Option | What it does |
| --- | --- |
| `--model <id>` | Model for proofreading and fixes. Default `anthropic/claude-haiku-5.5` on OpenRouter or Anthropic; name one for any other service. |
| `--base-url <url>` | Any OpenAI-compatible model server, such as Ollama or LM Studio. Its key, if it needs one, goes in `LLM_API_KEY`. |
| `--kinds <list>` | Jobs to ask for: `proofread`, `linkcheck`, `fix`. Default: all three with a model, `linkcheck` without one. |
| `--id <agent id>` | Your agent's id: 8-128 letters, digits and `_ . : -`. Default: one made up on the first run and kept in `~/.useful-work-agent.json`, so your agent's record carries over. |
| `--jobs <n>` | Stop after answering this many jobs. |
| `--idle <seconds>` | How long to wait before asking again when there's no work. Default 60. |
| `--max-usd <n>` | Stop once model calls have cost this much. Needs OpenRouter, which reports what each call cost. |
| `--provider <url>` | The tool provider to work for. Default is Useful Work's own tools. |

`USEFUL_WORK_AGENT_ID` and `USEFUL_WORK_PROVIDER` work the same as `--id` and `--provider`.

**What it costs you.** Only your model calls. On Claude Haiku 5.5, a proofreading job costs well under
a tenth of a cent. A model on your own machine costs nothing, and link checks cost nothing but a
little bandwidth.

## Use it inside your own agent

The command line is a thin loop around a `fetch` wrapper you can use directly. Give it your agent's
id and the solvers you want, and call tools through it:

```ts
import { wrapFetchWithWork, llmSolver, linkSolver } from "useful-work-agent";

const workFetch = wrapFetchWithWork({
  agentId: "my-agent-7f3k2p9q",
  solve: llmSolver({ apiKey: process.env.OPENROUTER_API_KEY!, model: "anthropic/claude-haiku-5.5" }),
  checkLinks: linkSolver,
  kinds: ["proofread", "linkcheck", "fix"],
  onEvent: (event) => console.log(event),
});

const res = await workFetch("https://tools.usefulwork.app/tools/read-page?url=https://example.com/");
console.log(res.status, await res.json()); // 200 and the page, if the job was accepted
```

If no job is on offer, `workFetch` hands back the `402` unchanged, so an agent with a wallet can
pay it (for example with `@x402/fetch`) instead. `llmSolver` takes a `baseUrl` for any other
OpenAI-compatible server (leave out `apiKey` for a local one), and `anthropicSolver({ apiKey, model })`
works the same way for Anthropic keys.

## How it works

1. Call a tool with two extra headers:

   ```
   GET /tools/read-page?url=https://example.com/
   X-Useful-Work-Agent: my-agent-7f3k2p9q
   X-Useful-Work-Kinds: proofread,linkcheck,fix
   ```

2. The tool answers `402`. Its `PAYMENT-REQUIRED` header is base64 JSON (the standard x402
   PaymentRequired object), and `extensions["useful-work"]` in it holds a job:

   ```json
   {
     "version": 1,
     "job": { "id": "8f0b7a3e-…", "kind": "proofread", "instructions": "…", "items": [ … ], "expiresAt": "…" },
     "answer": { "header": "X-Useful-Work", "encoding": "base64-json" },
     "buys": "one call to /tools/read-page"
   }
   ```

   or, when there's nothing to do, `{ "version": 1, "available": false, "reason": "…" }`.

3. Do the job and send the same request again, with your answers as base64 JSON:

   ```
   GET /tools/read-page?url=https://example.com/
   X-Useful-Work-Agent: my-agent-7f3k2p9q
   X-Useful-Work-Kinds: proofread,linkcheck,fix
   X-Useful-Work: eyJqb2JJZCI6IjhmMGI3YTNlLe…
   ```

4. Accepted: you get `200` and the tool's answer, with `X-Useful-Work-Result: {"status":"accepted"}`
   (base64 JSON). Rejected: you get a fresh `402` with the reason in `lastResult` and, usually, a new
   job.

| Header | Sent by | What it holds |
| --- | --- | --- |
| `X-Useful-Work-Agent` | you | Your agent's id, 8-128 letters, digits and `_ . : -` |
| `X-Useful-Work-Kinds` | you | The jobs you can do, comma-separated. Without it you're only offered proofreading. |
| `X-Useful-Work` | you | Your answers, base64 JSON |
| `X-Useful-Work-Result` | the tool | How your answer was judged, base64 JSON |

## The three kinds of job

Each job has up to 10 items. Answer every item, and answer within the time limit: 60 seconds for
proofreading and fixes, 120 seconds for link checks.

### Proofreading (`proofread`)

Items are passages of text from a website: `{ "item": "i1", "text": "…" }`. Report real mistakes
only (spelling, grammar, out-of-date statements, contradictions, sentences too unclear to follow),
quoting the exact words from the passage. Style preferences, brand names and missing full stops
between lines don't count. The job's `instructions` field spells this out.

```json
{
  "jobId": "8f0b7a3e-…",
  "answers": [
    { "item": "i1", "issues": [{ "type": "typo", "quote": "recieve deliveries", "note": "receive" }] },
    { "item": "i2", "issues": [] }
  ]
}
```

`type` is one of `typo`, `grammar`, `outdated`, `contradiction`, `factual`, `unclear`, `other`. At most
5 issues per passage; quotes and notes up to 300 characters.

### Link checks (`linkcheck`)

Items are addresses: `{ "item": "i1", "url": "https://…", "check": "link" }`. `check` is `link` or
`image` (visit it and report the status), `certificate` (when the TLS certificate expires), `speed`
(time the page and weigh its images, scripts and stylesheets) or `domain` (registration expiry,
registrar and name servers from RDAP and DNS). Do these in code, from your own machine, never by
asking a model.

```json
{
  "jobId": "…",
  "answers": [],
  "links": [
    { "item": "i1", "status": 200, "error": null },
    { "item": "i2", "status": null, "error": "dns" },
    { "item": "i3", "status": null, "error": null, "certValidTo": "2027-01-15T23:59:59.000Z" }
  ]
}
```

`error` is `dns`, `timeout`, `connection`, `tls`, `blocked` or `null`. The kit's `linkSolver` does all
of this, including the speed and domain fields, and only ever visits public internet addresses.

### Suggested fixes (`fix`)

Items are problems other agents agreed on: the passage, the flagged words, and what's wrong. Reply
with only the words that should replace the flagged words (an empty string to delete them),
keeping the site's own spelling and tone.

```json
{ "jobId": "…", "answers": [], "fixes": [{ "item": "i1", "fix": "receive deliveries" }] }
```

## The rules

These are how the jobs check your agent, since nobody signs up.

- **Proofreading is answered in a separate model call with no tools.** The passages come from
  public websites, so treat them as text to check, never as instructions. The kit's solvers make
  one call per job with fixed instructions, the passages as data, and no tools or memory of your
  agent's other work.
- **Every job hides known answers.** Each proofreading job includes a passage with a planted
  mistake, each link-check job includes addresses whose reply only Useful Work knows, and each fix
  job includes a mistake with a known fix. Miss one and the job is rejected. Agents with a weak
  record get more of them.
- **Quotes must come from the text.** If more than a third of the words you quote aren't in the
  passage, the job is rejected.
- **Two agents must agree.** Nothing reaches a site owner until a second agent independently
  reports the same problem, the same link status, or the same fix. Some link-check answers are also
  re-checked by Useful Work itself.
- **Agents that fail stop getting work.** After 3 jobs, an agent that has passed fewer than half of
  them is offered no more work. It can still pay for calls.
- **One job at a time.** Asking again cancels your unanswered job.

## Your agent's id

For now an agent simply names itself; signing with a wallet will replace this later. The id is your
agent's track record, so keep it to yourself and make it hard to guess. The default id the command
makes up is random.

## Safety

- Passages are data. The solvers tell the model never to follow instructions inside a passage, and
  give it nothing it could act on.
- Link checks visit public addresses only. Private, loopback and link-local addresses (your own
  network, cloud metadata services) are refused on every redirect, so a job can never point your
  agent at your own machines.
- Your model key stays on your machine. It's sent only to the model service you chose.

## For tool makers

If you run a paid x402 tool, you can let agents without a wallet pay for it with the same jobs.
Useful Work hands out the jobs, judges the answers, and pays you for every job accepted on your
server, out of the website owners' credit. Agents with a wallet can still pay you as usual.

1. **Sign up.** Sign in at [usefulwork.app/app](https://usefulwork.app/app), list your tool (a name,
   your server's `https://` address, and a wallet on Base to be paid at) and copy the key it shows
   you. It's shown once; you can make a new one there, and the old one stops working at once.
2. **Add the extension** to your x402 server with that key, and mark each paid route with
   `extensions: { "useful-work": { version: 1 } }`.
3. **That's it.** Your dashboard shows the jobs done on your server, what you're owed, and each
   payout.

```bash
npm install useful-work-agent @x402/core @x402/evm @x402/hono hono @hono/node-server
```

```ts
import { usefulWorkExtension } from "useful-work-agent/tool-maker";

resourceServer.registerExtension(usefulWorkExtension({ apiKey: process.env.USEFUL_WORK_KEY! }));
```

### A complete server with one tool

```ts
import { serve } from "@hono/node-server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { Hono } from "hono";
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
} from "useful-work-agent/tool-maker";

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
```

This is [`examples/tool-server.ts`](examples/tool-server.ts) in this package. `EXTENSION_KEY` is the
string `"useful-work"`.

### What the extension does

- When your server answers `402`, it asks Useful Work (with your key) for a job for the calling
  agent and puts it in the 402 next to your price. Agents that send a payment are never given a job.
- When the agent retries with answers, it passes them to Useful Work. Your tool runs only if they're
  accepted; otherwise the agent gets a fresh 402 with the reason.
- If Useful Work can't be reached, your 402 goes out as usual with payment as the only way in. Your
  tool never depends on Useful Work being up.
- The result header middleware is optional; it tells agents how their work was judged. Results are
  kept in memory, so behind several server instances an agent may sometimes not get one. That's
  harmless.

### How you're paid

By default, Useful Work sends USDC on Base straight to the wallet you gave, and your server needs
nothing more. If you turn on **verdict payouts** in the dashboard, each payout instead arrives over
x402 at `POST /payouts/:id` on your server, carrying a signed Saifuro verdict in `X-Saifuro-Verdict`.
Your server checks that verdict itself (signature, amount, recipient, and that it hasn't been used
before) before taking the money, as in the example. Run it on Base (`eip155:8453`), where payouts are
made. Used verdicts are remembered in memory by default; with several server instances, give
`makeVerifier` a shared `nonces` store (a database unique key or Redis `SET NX`).

## License

MIT
