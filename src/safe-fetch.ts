import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// Fetch for addresses that come from jobs. Blocks private, loopback and link-local addresses so a
// job can never point your agent at your own network or a cloud metadata service, and re-checks
// every redirect hop. Known gap: DNS could change between the check and the connect (rebinding);
// pinning the resolved IP needs a custom undici dispatcher, which is a later step.

export class FetchBlockedError extends Error {}

export interface SafeFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  accept?: string;
  userAgent?: string;
  /** Extra request headers, e.g. If-None-Match to skip an unchanged page. */
  headers?: Record<string, string>;
  /** GET by default; HEAD to ask whether something exists without downloading it. */
  method?: "GET" | "HEAD";
}

export interface SafeFetchResult {
  url: string;
  status: number;
  contentType: string;
  body: string;
  etag: string | null;
  lastModified: string | null;
  contentEncoding: string | null;
  cacheControl: string | null;
  contentLength: number | null;
  contentRange: string | null;
  /** Bytes of body received (after decompression), up to maxBytes. */
  bytesRead: number;
  /** From the first request to the final response's headers, and to its last byte, in ms. */
  ttfbMs: number;
  totalMs: number;
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

function inRange(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    return [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ].some(([base, bits]) => inRange(ip, base as string, bits as number));
  }
  const lower = ip.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isPrivateAddress(mapped[1]);
  return lower === "::" || lower === "::1" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
}

export async function assertPublicHost(url: URL): Promise<void> {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new FetchBlockedError(`scheme ${url.protocol} not allowed`);
  if (url.port && url.port !== "80" && url.port !== "443") throw new FetchBlockedError(`port ${url.port} not allowed`);
  if (url.username || url.password) throw new FetchBlockedError("credentials in URL not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (addresses.length === 0) throw new FetchBlockedError(`${host} does not resolve`);
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) throw new FetchBlockedError(`${host} resolves to a private address`);
  }
}

export async function safeFetch(input: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const maxBytes = options.maxBytes ?? 2_000_000;
  const maxRedirects = options.maxRedirects ?? 3;
  const started = performance.now();
  let url = new URL(input);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicHost(url);
    const res = await fetch(url, {
      method: options.method ?? "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      headers: {
        ...options.headers,
        "user-agent": options.userAgent ?? "UsefulWorkBot/0.1",
        accept: options.accept ?? "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
      },
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel();
      if (!location) throw new FetchBlockedError("redirect without a location");
      url = new URL(location, url);
      continue;
    }
    const ttfbMs = Math.round(performance.now() - started);
    const { text: body, bytes: bytesRead } = await readLimited(res, maxBytes);
    const length = Number(res.headers.get("content-length"));
    return {
      url: url.toString(),
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      body,
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
      contentEncoding: res.headers.get("content-encoding"),
      cacheControl: res.headers.get("cache-control"),
      contentLength: Number.isFinite(length) && length > 0 ? length : null,
      contentRange: res.headers.get("content-range"),
      bytesRead,
      ttfbMs,
      totalMs: Math.round(performance.now() - started),
    };
  }
  throw new FetchBlockedError(`more than ${maxRedirects} redirects`);
}

async function readLimited(res: Response, maxBytes: number): Promise<{ text: string; bytes: number }> {
  if (!res.body) return { text: "", bytes: 0 };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), bytes: total };
}
