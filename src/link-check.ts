import { resolve4, resolveNs } from "node:dns/promises";
import { connect } from "node:tls";
import { parse } from "node-html-parser";
import type { LINK_CHECKS, LinkResult } from "./protocol.js";
import { FetchBlockedError, assertPublicHost, isPrivateAddress, safeFetch } from "./safe-fetch.js";

// Checking one address, the way the protocol asks. Useful Work spot-checks a sample of agents'
// answers with this same code, so an honest agent and the spot check see the same thing. Only
// public addresses are ever visited.

type Check = (typeof LINK_CHECKS)[number];
export type Observation = Omit<LinkResult, "item">;

const DAY = 86_400_000;
const TIMEOUT_MS = 12_000;

function failure(err: unknown): Observation {
  const e = err as { name?: string; message?: string; code?: string; cause?: { code?: string } };
  const code = e.code ?? e.cause?.code ?? "";
  if (e.name === "TimeoutError" || e.name === "AbortError" || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return { status: null, error: "timeout" };
  if (err instanceof FetchBlockedError) return { status: null, error: /does not resolve/.test(e.message ?? "") ? "dns" : "blocked" };
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ENODATA") return { status: null, error: "dns" };
  if (/CERT|SSL|TLS/i.test(code)) return { status: null, error: "tls" };
  return { status: null, error: "connection" };
}

async function visit(url: string): Promise<Observation> {
  const opts = { timeoutMs: TIMEOUT_MS, maxRedirects: 5, maxBytes: 16_384, accept: "*/*", userAgent: "UsefulWorkBot/0.1 (+link check)" };
  try {
    const head = await safeFetch(url, { ...opts, method: "HEAD" });
    // Plenty of servers refuse HEAD but serve GET happily.
    if (![400, 403, 405, 501].includes(head.status)) return { status: head.status, error: null };
    const get = await safeFetch(url, opts);
    return { status: get.status, error: null };
  } catch (err) {
    return failure(err);
  }
}

async function certificate(url: string): Promise<Observation> {
  let host: string;
  try {
    const u = new URL(url);
    host = u.hostname;
    await assertPublicHost(new URL(`https://${host}/`));
  } catch (err) {
    return failure(err);
  }
  return new Promise((resolve) => {
    const socket = connect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout: TIMEOUT_MS }, () => {
      const cert = socket.getPeerCertificate();
      const validTo = cert?.valid_to ? new Date(cert.valid_to) : null;
      const trusted = socket.authorized;
      socket.end();
      resolve({
        status: null,
        error: trusted ? null : "tls",
        ...(validTo && !Number.isNaN(validTo.getTime()) ? { certValidTo: validTo.toISOString() } : {}),
      });
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve({ status: null, error: "timeout" });
    });
    socket.on("error", (err) => resolve(failure(err)));
  });
}

const MAX_RESOURCES = 40;
const HEAVY_IMAGE_BYTES = 300_000;
const MAX_RESOURCE_BYTES = 3_000_000;

/** The images, scripts and stylesheets a page loads, as absolute addresses. */
export function resourceUrls(html: string, pageUrl: string): string[] {
  const root = parse(html);
  const out = new Set<string>();
  const add = (raw: string | undefined) => {
    if (!raw) return;
    try {
      const u = new URL(raw.trim(), pageUrl);
      if (/^https?:$/.test(u.protocol)) out.add(u.href);
    } catch {
      // ignore malformed addresses
    }
  };
  for (const el of root.querySelectorAll("img[src]")) add(el.getAttribute("src"));
  for (const el of root.querySelectorAll("script[src]")) add(el.getAttribute("src"));
  for (const el of root.querySelectorAll("link[href]")) if (/stylesheet/i.test(el.getAttribute("rel") ?? "")) add(el.getAttribute("href"));
  return [...out].slice(0, MAX_RESOURCES);
}

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

/**
 * How big a file is: HEAD's Content-Length when the server gives one, otherwise the bytes of a
 * download capped at MAX_RESOURCE_BYTES. 0 if it can't be fetched.
 */
async function sizeOf(url: string): Promise<number> {
  const opts = { timeoutMs: 10_000, maxRedirects: 3, accept: "*/*", userAgent: "UsefulWorkBot/0.1 (+speed check)" };
  try {
    const head = await safeFetch(url, { ...opts, method: "HEAD", maxBytes: 0 });
    if (head.contentLength) return head.contentLength;
    // No size given (common for compressed files behind CDNs): download it as a browser would, up to 3 MB.
    const full = await safeFetch(url, { ...opts, maxBytes: MAX_RESOURCE_BYTES });
    return full.bytesRead;
  } catch {
    return 0;
  }
}

/** Load a page like a visitor would, then ask its images, scripts and stylesheets how big they are. */
async function speed(url: string): Promise<Observation> {
  try {
    const page = await safeFetch(url, {
      timeoutMs: 20_000,
      maxRedirects: 5,
      maxBytes: 5_000_000,
      accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      userAgent: "UsefulWorkBot/0.1 (+speed check)",
      headers: { "accept-encoding": "gzip, deflate, br" },
    });
    const bytes = Buffer.byteLength(page.body);
    const assets = page.status === 200 && page.contentType.includes("html") ? resourceUrls(page.body, page.url) : [];
    const sizes = await inBatches(assets, 6, async (a) => ({ url: a, bytes: await sizeOf(a) }));
    const heavy = sizes
      .filter((s) => s.bytes > HEAVY_IMAGE_BYTES && /\.(jpe?g|png|gif|webp|avif|bmp|tiff?)(\?|$)/i.test(s.url))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 5);
    return {
      status: page.status,
      error: null,
      ttfbMs: page.ttfbMs,
      loadMs: page.totalMs,
      bytes,
      weight: bytes + sizes.reduce((n, s) => n + s.bytes, 0),
      resources: assets.length,
      compressed: Boolean(page.contentEncoding && !/identity/i.test(page.contentEncoding)),
      cacheable: Boolean(page.cacheControl && !/no-store/i.test(page.cacheControl)),
      heavy,
    };
  } catch (err) {
    return failure(err);
  }
}

type Rdap = {
  events?: Array<{ eventAction?: string; eventDate?: string }>;
  entities?: Array<{ roles?: string[]; vcardArray?: [string, Array<[string, unknown, string, unknown]>] }>;
  nameservers?: Array<{ ldhName?: string }>;
  name?: string;
};

/**
 * An RDAP record, "missing" when the registry says it has none, or "failed" when it couldn't be
 * asked. rdap.org and the registries behind it limit how often one address may ask, so a busy or
 * failed answer is tried again before giving up.
 */
async function rdap(path: string): Promise<Rdap | "missing" | "failed"> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, attempt * 2_000));
    try {
      const res = await safeFetch(`https://rdap.org/${path}`, { timeoutMs: 10_000, maxRedirects: 5, maxBytes: 500_000, accept: "application/rdap+json, application/json" });
      if (res.status === 200) return JSON.parse(res.body) as Rdap;
      // Busy (429) or broken (5xx): ask again. Anything else, such as the 400 or 404 registries give
      // for a name that isn't registered itself (www.example.com), is an answer.
      if (res.status !== 429 && res.status < 500) return "missing";
    } catch {
      // a timeout, a dropped connection or a garbled reply: try again
    }
  }
  return "failed";
}

function entityName(record: Rdap | null, roles: string[]): string | undefined {
  const entity = record?.entities?.find((e) => e.roles?.some((r) => roles.includes(r)));
  const fn = entity?.vcardArray?.[1]?.find((f) => f[0] === "fn")?.[3];
  return typeof fn === "string" && fn.trim() ? fn.trim().slice(0, 200) : undefined;
}

/** A domain's registration (expiry, registrar, name servers) and the network that hosts the site. */
async function domain(url: string): Promise<Observation> {
  const host = new URL(url).hostname;
  // RDAP knows registered domains, not every host name in them: drop leading labels until it answers.
  const labels = host.split(".");
  let record: Rdap | null = null;
  let failed = false;
  let registered = host;
  for (let i = 0; i <= labels.length - 2 && i < 4 && !record && !failed; i++) {
    registered = labels.slice(i).join(".");
    const found = await rdap(`domain/${registered}`);
    if (found === "failed") failed = true;
    else if (found !== "missing") record = found;
  }
  let nameservers = (record?.nameservers ?? []).map((n) => n.ldhName?.toLowerCase()).filter((n): n is string => Boolean(n));
  if (nameservers.length === 0) nameservers = await resolveNs(registered).catch(() => []);
  let hostIp: string | undefined;
  let hostOrg: string | undefined;
  try {
    [hostIp] = await resolve4(host);
    if (hostIp && !isPrivateAddress(hostIp)) {
      const found = await rdap(`ip/${hostIp}`);
      const network = typeof found === "object" ? found : null;
      hostOrg = entityName(network, ["registrant", "administrative"]) ?? network?.name?.slice(0, 200);
    }
  } catch {
    // no address: the site may not resolve at all
  }
  if (!record && !hostIp) return { status: null, error: "dns" };
  // The registry couldn't be asked just now: say so, rather than claim it publishes nothing.
  if (failed) return { status: null, error: "timeout", ...(nameservers.length ? { nameservers: nameservers.slice(0, 8) } : {}), ...(hostIp ? { hostIp } : {}) };
  const expiresAt = record?.events?.find((e) => e.eventAction === "expiration")?.eventDate;
  return {
    status: null,
    error: null,
    ...(expiresAt && !Number.isNaN(Date.parse(expiresAt)) ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
    ...(entityName(record, ["registrar"]) ? { registrar: entityName(record, ["registrar"]) } : {}),
    ...(nameservers.length ? { nameservers: nameservers.slice(0, 8) } : {}),
    ...(hostIp ? { hostIp } : {}),
    ...(hostOrg ? { hostOrg } : {}),
  };
}

/** Look at one address the way the protocol asks: a page or image, a certificate, a page's speed, or the domain. */
export function checkAddress(item: { url: string; check: Check }): Promise<Observation> {
  if (item.check === "certificate") return certificate(item.url);
  if (item.check === "speed") return speed(item.url);
  if (item.check === "domain") return domain(item.url);
  return visit(item.url);
}
