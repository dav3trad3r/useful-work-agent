import { z } from "zod";

// The "useful-work" x402 extension, as an agent sees it. A tool's 402 reply carries a small job
// under PaymentRequired.extensions["useful-work"]; the agent retries the same request with its
// answers in the X-Useful-Work header instead of a payment.

export const EXTENSION_KEY = "useful-work";
export const WORK_HEADER = "X-Useful-Work";
/** The agent names itself (8-128 letters, digits, _ . : -). Wallet-signed identity replaces this later. */
export const AGENT_HEADER = "X-Useful-Work-Agent";
/** On the response a job unlocked: how the answer was judged. */
export const RESULT_HEADER = "X-Useful-Work-Result";
/** The job kinds an agent can do, comma-separated. Without it an agent only gets proofreading. */
export const KINDS_HEADER = "X-Useful-Work-Kinds";
export const JOB_KINDS = ["proofread", "linkcheck", "fix"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const AGENT_ID_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

export function parseKinds(header: string | undefined | null): JobKind[] {
  const kinds = (header ?? "").split(",").map((s) => s.trim()).filter((k): k is JobKind => (JOB_KINDS as readonly string[]).includes(k));
  return kinds.length > 0 ? [...new Set(kinds)] : ["proofread"];
}

export const ISSUE_TYPES = ["typo", "grammar", "outdated", "contradiction", "factual", "unclear", "other"] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

export const LIMITS = {
  itemsPerJob: 10,
  issuesPerItem: 5,
  quoteChars: 300,
  noteChars: 300,
  jobSeconds: 60,
  /** Link checks wait on other websites, so they get longer. */
  linkJobSeconds: 120,
} as const;

export const LINK_CHECKS = ["link", "image", "certificate", "speed", "domain"] as const;
export const LINK_ERRORS = ["dns", "timeout", "connection", "tls", "blocked"] as const;

export const jobItemSchema = z.object({
  item: z.string().max(16),
  text: z.string().max(2000),
});

export const linkItemSchema = z.object({
  item: z.string().max(16),
  url: z.string().url().max(2000),
  check: z.enum(LINK_CHECKS),
});

const proofreadJobSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal("proofread"),
  instructions: z.string(),
  items: z.array(jobItemSchema).min(1).max(LIMITS.itemsPerJob),
  issueTypes: z.array(z.enum(ISSUE_TYPES)),
  expiresAt: z.string(),
});

export const fixItemSchema = z.object({
  item: z.string().max(16),
  text: z.string().max(2000),
  quote: z.string().min(1).max(LIMITS.quoteChars),
  type: z.enum(ISSUE_TYPES),
  note: z.string().max(LIMITS.noteChars).optional(),
});

const fixJobSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal("fix"),
  instructions: z.string(),
  items: z.array(fixItemSchema).min(1).max(LIMITS.itemsPerJob),
  expiresAt: z.string(),
});

const linkcheckJobSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal("linkcheck"),
  instructions: z.string(),
  items: z.array(linkItemSchema).min(1).max(LIMITS.itemsPerJob),
  expiresAt: z.string(),
});

export const workOfferSchema = z.object({
  version: z.literal(1),
  job: z.discriminatedUnion("kind", [proofreadJobSchema, linkcheckJobSchema, fixJobSchema]),
  answer: z.object({
    header: z.literal(WORK_HEADER),
    encoding: z.literal("base64-json"),
  }),
  buys: z.string(),
});
export type WorkOffer = z.infer<typeof workOfferSchema>;

export const issueSchema = z.object({
  type: z.enum(ISSUE_TYPES),
  quote: z.string().min(1).max(LIMITS.quoteChars),
  note: z.string().max(LIMITS.noteChars).optional(),
});
export type Issue = z.infer<typeof issueSchema>;

/** What an agent saw at one address: the final status code, or how it failed. */
export const linkResultSchema = z.object({
  item: z.string().max(16),
  status: z.number().int().min(100).max(599).nullable(),
  error: z.enum(LINK_ERRORS).nullable(),
  /** Certificate items: when the certificate stops being valid (ISO date). */
  certValidTo: z.string().max(40).optional(),
  /** Speed items: milliseconds to the first response and to the whole page, and sizes in bytes. */
  ttfbMs: z.number().int().min(0).max(120_000).optional(),
  loadMs: z.number().int().min(0).max(120_000).optional(),
  bytes: z.number().int().min(0).max(100_000_000).optional(),
  weight: z.number().int().min(0).max(1_000_000_000).optional(),
  resources: z.number().int().min(0).max(1000).optional(),
  compressed: z.boolean().optional(),
  cacheable: z.boolean().optional(),
  heavy: z.array(z.object({ url: z.string().url().max(2000), bytes: z.number().int().min(0) })).max(5).optional(),
  /** Domain items: registration expiry (ISO date), registrar, name servers, and who hosts the site. */
  expiresAt: z.string().max(40).optional(),
  registrar: z.string().max(200).optional(),
  nameservers: z.array(z.string().max(255)).max(8).optional(),
  hostIp: z.string().max(64).optional(),
  hostOrg: z.string().max(200).optional(),
});
export type LinkResult = z.infer<typeof linkResultSchema>;

export const workAnswerSchema = z.object({
  jobId: z.string().uuid(),
  /** Proofreading answers. */
  answers: z
    .array(
      z.object({
        item: z.string().max(16),
        issues: z.array(issueSchema).max(LIMITS.issuesPerItem),
      }),
    )
    .max(LIMITS.itemsPerJob)
    .default([]),
  /** Link-check answers. */
  links: z.array(linkResultSchema).max(LIMITS.itemsPerJob).optional(),
  /** Fix answers: what replaces each item's flagged words ("" to remove them). */
  fixes: z.array(z.object({ item: z.string().max(16), fix: z.string().max(LIMITS.quoteChars) })).max(LIMITS.itemsPerJob).optional(),
});
export type WorkAnswer = z.infer<typeof workAnswerSchema>;

export const workResultSchema = z.object({
  status: z.enum(["accepted", "rejected"]),
  reason: z.string().optional(),
});
export type WorkResult = z.infer<typeof workResultSchema>;

/** What a 402 carries under extensions["useful-work"]: a job, or why there is none right now. */
export const workExtensionSchema = z.union([
  workOfferSchema.extend({ lastResult: workResultSchema.optional() }),
  z.object({
    version: z.literal(1),
    available: z.literal(false),
    reason: z.string(),
    lastResult: workResultSchema.optional(),
  }),
]);
export type WorkExtension = z.infer<typeof workExtensionSchema>;

export function encodeJsonHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function decodeJsonHeader(header: string): unknown {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}
