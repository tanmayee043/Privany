// Same lookups as backend/privany/classify.py, so the extension can label
// what it sees without sending anything anywhere.
import { getDomain, getHostname } from "tldts";
import trackers from "../data/trackers.json";
import cookies from "../data/cookies.json";

type TrackerRow = { o: string; c: string[]; ad: boolean; fp: number };
const T = trackers as unknown as Record<string, TrackerRow>;
const C = cookies as unknown as { exact: Record<string, string>; prefix: [string, string, string][]; platform: Record<string, string> };

export function siteOf(host: string): string {
  const h = (host || "").replace(/^\./, "").toLowerCase();
  return getDomain(h, { allowPrivateDomains: false }) || h;
}

export function siteKey(url: string): string {
  try {
    const u = new URL(url);
    const base = siteOf(u.hostname);
    const local = u.hostname === "localhost" || /^[\d.]+$/.test(u.hostname);
    return local && u.port ? `${base}:${u.port}` : base;
  } catch {
    return "";
  }
}

export function hostOf(url: string): string {
  return getHostname(url) || "";
}

export function trackerFor(host: string): { domain: string; owner: string; categories: string[]; ad: boolean } | null {
  const parts = (host || "").replace(/^\./, "").toLowerCase().split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    const cand = parts.slice(i).join(".");
    const row = T[cand];
    if (row) return { domain: cand, owner: row.o, categories: row.c, ad: row.ad };
  }
  return null;
}

export function cookieCategory(name: string, domain = ""): { category: string; platform: string | null } {
  const n = (name || "").toLowerCase();
  const platform = C.platform[n] ?? null;
  if (n in C.exact) return { category: C.exact[n], platform };
  for (const [prefix, cat, owner] of C.prefix) {
    if (n.startsWith(prefix)) return { category: cat, platform: owner || null };
  }
  const tr = trackerFor(domain);
  if (tr?.ad) return { category: "targeting", platform: tr.owner };
  return { category: "unknown", platform };
}

export function classifyCookie(name: string, domain: string, pageSite: string) {
  const cookieSite = siteOf(domain);
  const tr = trackerFor(domain);
  const { category, platform } = cookieCategory(name, domain);
  const third_party = !!cookieSite && cookieSite !== pageSite;
  return {
    name,
    domain: domain.replace(/^\./, ""),
    category,
    third_party,
    owner: tr?.owner ?? platform,
    ad_platform: category === "targeting" && (third_party || !!platform),
  };
}
