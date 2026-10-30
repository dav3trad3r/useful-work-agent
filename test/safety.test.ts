import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkAddress, resourceUrls } from "../src/link-check.js";
import { FetchBlockedError, isPrivateAddress, safeFetch } from "../src/safe-fetch.js";

describe("only public addresses", () => {
  it("knows private, loopback and link-local addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("won't visit this computer or its network, whatever a job asks", async () => {
    await expect(safeFetch("http://127.0.0.1/")).rejects.toBeInstanceOf(FetchBlockedError);
    await expect(safeFetch("http://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(FetchBlockedError);
    await expect(safeFetch("http://[::1]/")).rejects.toBeInstanceOf(FetchBlockedError);
    await expect(safeFetch("https://example.com:8443/")).rejects.toBeInstanceOf(FetchBlockedError);
    await expect(safeFetch("file:///etc/passwd")).rejects.toBeInstanceOf(FetchBlockedError);
    expect(await checkAddress({ url: "http://192.168.0.1/", check: "link" })).toEqual({ status: null, error: "blocked" });
  });
});

describe("speed checks", () => {
  it("find a page's images, scripts and stylesheets", () => {
    const html = `<img src="/a.png"><script src="https://cdn.example/x.js"></script><link rel="stylesheet" href="s.css"><link rel="icon" href="/f.ico"><img src="javascript:alert(1)">`;
    expect(resourceUrls(html, "https://site.example/page/")).toEqual(["https://site.example/a.png", "https://cdn.example/x.js", "https://site.example/page/s.css"]);
  });
});

describe("the kit stands alone", () => {
  const allowed = /^(\.\/|node:|zod$|node-html-parser$|@anthropic-ai\/sdk$|jose$|@x402\/core\/types$)/;
  const files = readdirSync(join(import.meta.dirname, "../src")).filter((f) => f.endsWith(".ts"));

  it("imports only its own files and its dependencies", () => {
    for (const file of files) {
      const source = readFileSync(join(import.meta.dirname, "../src", file), "utf8");
      for (const [, from] of source.matchAll(/from\s+"([^"]+)"/g)) expect(from, `${file} imports ${from}`).toMatch(allowed);
    }
  });

  it("carries nothing from the private service", () => {
    for (const file of files) {
      const source = readFileSync(join(import.meta.dirname, "../src", file), "utf8").toLowerCase();
      for (const word of ["supabase", "service_role", "provider_api_key", "private_key", "mnemonic", "stripe"]) {
        expect(source.includes(word), `${file} mentions ${word}`).toBe(false);
      }
    }
  });
});
