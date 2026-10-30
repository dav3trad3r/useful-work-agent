#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { anthropicSolver } from "./anthropic-solver.js";
import { wrapFetchWithWork, type Solver, type WorkEvent } from "./client.js";
import { linkSolver } from "./link-solver.js";
import { llmSolver, type ModelUsage } from "./llm-solver.js";
import { USAGE, planRun, type RunPlan } from "./options.js";
import { AGENT_ID_PATTERN } from "./protocol.js";

// npx useful-work-agent: one agent that keeps asking a Useful Work tool for jobs, does them, and
// gets each tool call free. With nothing to do it waits and asks again.

// A cheap tool call to carry each job: a DNS lookup on the provider.
const CALL = "/tools/dns?name=example.com&type=A";
const ID_FILE = join(homedir(), ".useful-work-agent.json");

/** The id this computer's agent uses, made up on first run so its track record carries over. */
function savedAgentId(): string {
  try {
    if (existsSync(ID_FILE)) {
      const { id } = JSON.parse(readFileSync(ID_FILE, "utf8")) as { id?: unknown };
      if (typeof id === "string" && AGENT_ID_PATTERN.test(id)) return id;
    }
  } catch {
    // unreadable: make a new one
  }
  const id = `agent-${randomBytes(8).toString("hex")}`;
  writeFileSync(ID_FILE, JSON.stringify({ id }, null, 2) + "\n");
  return id;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function run(plan: RunPlan): Promise<number> {
  const agentId = plan.agentId ?? savedAgentId();
  const spend = { usd: 0, priced: 0, calls: 0, tokensIn: 0, tokensOut: 0 };
  const onUsage = (u: ModelUsage) => {
    spend.calls++;
    spend.tokensIn += u.promptTokens;
    spend.tokensOut += u.completionTokens;
    if (u.costUsd !== null) {
      spend.usd += u.costUsd;
      spend.priced++;
    }
  };
  const m = plan.model;
  let solve: Solver | undefined;
  if (m?.via === "anthropic") solve = anthropicSolver({ apiKey: m.apiKey!, model: m.model, onUsage });
  else if (m) {
    solve = llmSolver({
      apiKey: m.apiKey,
      baseUrl: m.baseUrl,
      model: m.model,
      // OpenRouter's attribution headers; other servers don't need them.
      ...(m.service === "OpenRouter" ? { headers: { "HTTP-Referer": "https://usefulwork.app", "X-Title": "Useful Work agent" } } : {}),
      onUsage,
    });
  }

  const totals = { jobs: 0, accepted: 0, rejected: 0, idle: 0, errors: 0 };
  const summary = () =>
    `${plural(totals.jobs, "job")} answered: ${totals.accepted} accepted, ${totals.rejected} rejected` +
    (spend.calls ? ` · ${plural(spend.calls, "model call")}${spend.priced ? `, $${spend.usd.toFixed(5)}` : `, ${spend.tokensIn} tokens in / ${spend.tokensOut} out`}` : "");
  process.on("SIGINT", () => {
    console.log(`\nStopped. ${summary()}`);
    process.exit(0);
  });

  console.log(`Useful Work agent ${agentId}`);
  console.log(`  jobs: ${plan.kinds.join(", ")} · model: ${m ? `${m.model} via ${m.service}` : "none (link checks only)"}`);
  console.log(`  tools: ${plan.provider}\n`);

  const items = new Map<string, number>();
  for (;;) {
    let idle = false;
    let cutOff: string | null = null;
    const onEvent = (event: WorkEvent) => {
      if (event.type === "offer") items.set(event.jobId, event.items);
      else if (event.type === "solved") {
        totals.jobs++;
        const n = items.get(event.jobId) ?? 0;
        const what =
          event.kind === "linkcheck"
            ? `checked ${plural(n, "address", "addresses")}`
            : event.kind === "fix"
              ? `suggested ${plural(event.issues, "fix", "fixes")} for ${plural(n, "problem")}`
              : `read ${plural(n, "passage")}, found ${plural(event.issues, "problem")}`;
        console.log(`job ${totals.jobs} · ${event.kind} · ${what} in ${(event.ms / 1000).toFixed(1)} s`);
      } else if (event.type === "result") {
        items.delete(event.jobId);
        if (event.result.status === "accepted") {
          totals.accepted++;
          console.log("  accepted: the tool call was free");
        } else {
          totals.rejected++;
          console.log(`  rejected: ${event.result.reason ?? "no reason given"}`);
        }
      } else if (event.type === "no-work") {
        idle = true;
        if (/not offered to this agent/.test(event.reason)) cutOff = event.reason;
        else console.log(`no work right now (${event.reason.replace(/; pay instead$/, "")}); asking again in ${plan.idleSeconds} s`);
      }
    };
    try {
      const workFetch = wrapFetchWithWork({ agentId, solve, checkLinks: plan.kinds.includes("linkcheck") ? linkSolver : undefined, kinds: plan.kinds, onEvent, maxAttempts: 2 });
      const res = await workFetch(`${plan.provider}${CALL}`);
      await res.body?.cancel();
      if (res.status !== 200 && res.status !== 402) console.log(`the tool answered ${res.status}`);
    } catch (err) {
      totals.errors++;
      idle = true;
      console.log(`error: ${(err as Error).message}`);
    }
    if (cutOff) {
      console.log(`\nWork is no longer offered to ${agentId}: fewer than half of its jobs passed. It can still pay for calls.`);
      console.log(summary());
      return 2;
    }
    if (plan.jobs !== null && totals.jobs >= plan.jobs) {
      console.log(`\nDone. ${summary()}`);
      return totals.rejected > 0 && totals.accepted === 0 ? 1 : 0;
    }
    if (plan.maxUsd !== null && spend.usd >= plan.maxUsd) {
      console.log(`\nStopped at the --max-usd limit. ${summary()}`);
      return 0;
    }
    if (idle) totals.idle++;
    await sleep(idle ? plan.idleSeconds * 1_000 * (0.75 + Math.random() * 0.5) : 1_000 + Math.random() * 2_000);
  }
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
let plan: RunPlan;
try {
  plan = planRun(argv, process.env);
} catch (err) {
  console.error(`${(err as Error).message}\n\n${USAGE}`);
  process.exit(1);
}
process.exit(await run(plan));
