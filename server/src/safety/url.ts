import { lookup } from "node:dns/promises";
import net from "node:net";

export class UnsafeUrlError extends Error {}

const MAX_URL_LENGTH = 2048;

/** Accepts "example.com" or a full URL; returns a normalized https/http URL. */
export function normalizeUrl(input: string): URL {
  const raw = input.trim();
  if (!raw) throw new UnsafeUrlError("Enter a website address.");
  if (raw.length > MAX_URL_LENGTH) throw new UnsafeUrlError("That address is too long.");
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new UnsafeUrlError("That doesn't look like a website address.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UnsafeUrlError("Only http and https addresses can be checked.");
  }
  if (url.username || url.password) throw new UnsafeUrlError("Addresses with credentials can't be checked.");
  if (!url.hostname.includes(".")) throw new UnsafeUrlError("Enter a public website address.");
  url.hash = "";
  return url;
}

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::" || v === "::1") return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb") || v.startsWith("ff");
  }
  return true;
}

const hostCache = new Map<string, Promise<boolean>>();

/** True when every address the hostname resolves to is public. */
export function isPublicHost(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return Promise.resolve(!isPrivateAddress(host));
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return Promise.resolve(false);
  }
  let pending = hostCache.get(host);
  if (!pending) {
    pending = lookup(host, { all: true })
      .then((addrs) => addrs.length > 0 && addrs.every((a) => !isPrivateAddress(a.address)))
      .catch(() => false);
    hostCache.set(host, pending);
    if (hostCache.size > 5000) hostCache.clear();
  }
  return pending;
}

export async function assertPublicUrl(url: URL): Promise<void> {
  if (!(await isPublicHost(url.hostname))) {
    throw new UnsafeUrlError(`${url.hostname} isn't a reachable public website.`);
  }
}

/** fetch() that refuses private hosts, including on redirects, and caps the body size. */
export async function safeFetchText(url: URL, opts: { maxBytes: number; timeoutMs: number; accept?: string }): Promise<{ status: number; text: string; finalUrl: string; contentType: string }> {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    await assertPublicUrl(current);
    const res = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs),
      headers: { accept: opts.accept ?? "*/*", "user-agent": "Privany/0.1 (privacy policy checker)" },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location")!, current);
      if (current.protocol !== "https:" && current.protocol !== "http:") throw new UnsafeUrlError("Redirected to an unsupported address.");
      continue;
    }
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > opts.maxBytes) {
          await reader.cancel();
          throw new UnsafeUrlError("The response was too large.");
        }
        chunks.push(value);
      }
    }
    return {
      status: res.status,
      text: Buffer.concat(chunks).toString("utf8"),
      finalUrl: current.toString(),
      contentType: res.headers.get("content-type") ?? "",
    };
  }
  throw new UnsafeUrlError("Too many redirects.");
}
