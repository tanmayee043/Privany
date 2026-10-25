import { getDomain } from "tldts";
import trackers from "./data/trackers.json";
import cookies from "./data/cookies.json";

// Labels what a page loads, entirely inside the extension. The data files are
// built by privany/data-pipeline/build_data.py (features-updated branch):
// tracker domains and owners from DuckDuckGo's Tracker Radar data, and cookie
// categories from PrivAudit's crawl plus the Open Cookie Database. See NOTICE.md.

type TrackerRow = { o: string; c: string[]; ad: boolean; fp: number };
const T = trackers as unknown as Record<string, TrackerRow>;
const C = cookies as unknown as { exact: Record<string, string>; prefix: [string, string, string][]; platform: Record<string, string> };

export function siteOf(host: string): string {
  const h = (host || "").replace(/^\./, "").toLowerCase();
  return getDomain(h) || h;
}

// A domain counts as ad-tech only when its own categories say so. The list's
// broader "ad" flag also covers some infrastructure (e.g. Cloudflare's
// site-speed analytics), which would make warnings name the wrong companies.
const AD_CATEGORIES = new Set(["Advertising", "Ad Motivated Tracking", "Action Pixels", "Third-Party Analytics Marketing", "Audience Measurement"]);

/** The tracker-list entry for a host or any of its parent domains. */
export function trackerFor(host: string): { domain: string; owner: string; ad: boolean } | null {
  const parts = (host || "").replace(/^\./, "").toLowerCase().split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    const cand = parts.slice(i).join(".");
    const row = T[cand];
    if (row) return { domain: cand, owner: row.o, ad: row.c.some((c) => AD_CATEGORIES.has(c)) };
  }
  return null;
}

/** PrivAudit's four buckets: necessary, functional, performance (analytics), targeting (advertising). */
export function cookieCategory(name: string, domain = ""): { category: string; owner?: string } {
  const n = (name || "").toLowerCase();
  const platform = C.platform[n];
  if (n in C.exact) return { category: C.exact[n], owner: platform };
  for (const [prefix, cat, owner] of C.prefix) if (n.startsWith(prefix)) return { category: cat, owner: owner || platform };
  const tr = trackerFor(domain);
  if (tr?.ad) return { category: "targeting", owner: tr.owner };
  return { category: "unknown", owner: platform };
}

export const isTrackingCategory = (c: string) => c === "targeting" || c === "performance";
