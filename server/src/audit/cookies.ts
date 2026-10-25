import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import { getDomain } from "tldts";
import type { CookieCategory, CookieTotals, ObservedCookie } from "../report/types.js";

// Cookie purposes come from the Open Cookie Database (Apache-2.0), one of the
// sources PrivAudit uses for its cookie categorization step.
const OCD_PATH = fileURLToPath(new URL("../../data/open-cookie-database.csv", import.meta.url));

interface OcdEntry {
  name: string;
  domain: string;
  category: CookieCategory;
  platform: string;
  description: string;
  wildcard: boolean;
}

// Same buckets as PrivAudit's standardize_category(): necessary, functional,
// performance (analytics) and targeting (advertising).
const CATEGORY_MAP: Record<string, CookieCategory> = {
  Necessary: "necessary",
  Security: "necessary",
  Functional: "functional",
  Personalization: "functional",
  Analytics: "analytics",
  Marketing: "advertising",
};

let exact: Map<string, OcdEntry[]> | null = null;
let prefixes: OcdEntry[] = [];

function load() {
  if (exact) return;
  const rows = parse(readFileSync(OCD_PATH, "utf8"), { columns: true, skip_empty_lines: true }) as Record<string, string>[];
  exact = new Map();
  for (const row of rows) {
    const entry: OcdEntry = {
      name: row["Cookie / Data Key name"],
      domain: (row["Domain"] ?? "").replace(/^\./, "").toLowerCase(),
      category: CATEGORY_MAP[row["Category"]] ?? "unknown",
      platform: row["Platform"] ?? "",
      description: row["Description"] ?? "",
      wildcard: row["Wildcard match"] === "1",
    };
    if (!entry.name) continue;
    if (entry.wildcard) prefixes.push(entry);
    else {
      const list = exact.get(entry.name) ?? [];
      list.push(entry);
      exact.set(entry.name, list);
    }
  }
  prefixes = prefixes.sort((a, b) => b.name.length - a.name.length);
}

function pick(entries: OcdEntry[], cookieDomain: string): OcdEntry {
  return entries.find((e) => e.domain && cookieDomain.endsWith(e.domain)) ?? entries[0];
}

export function lookupCookie(name: string, cookieDomain: string): OcdEntry | undefined {
  load();
  const hits = exact!.get(name);
  if (hits?.length) return pick(hits, cookieDomain);
  const pre = prefixes.filter((p) => name.startsWith(p.name));
  return pre.length ? pick(pre, cookieDomain) : undefined;
}

export function registrableDomain(host: string): string {
  const h = host.replace(/^\./, "").toLowerCase();
  return getDomain(h) ?? h;
}

export interface RawCookie {
  name: string;
  value: string;
  domain: string;
  expires: number;
  session: boolean;
}

// Cookies whose value records a privacy choice rather than identifying the
// visitor. Keeping their value lets the report show whether the site logged an
// opt-out, e.g. the IAB US Privacy string "1YYN" (third character Y = opted out of sale).
const CONSENT_STATE_COOKIES = new Set(["usprivacy", "SecGpc", "OptanonConsent", "us_privacy"]);

function consentValue(name: string, value: string): string | undefined {
  if (!CONSENT_STATE_COOKIES.has(name)) return undefined;
  if (name === "OptanonConsent") {
    const groups = safeDecode(value).match(/(?:^|&)groups=([^&]*)/)?.[1];
    return groups ? `groups=${groups}` : undefined;
  }
  return safeDecode(value).slice(0, 40);
}

export function classifyCookie(raw: RawCookie, siteHost: string): ObservedCookie {
  const domain = raw.domain.replace(/^\./, "").toLowerCase();
  const thirdParty = registrableDomain(domain) !== registrableDomain(siteHost);
  const hit = lookupCookie(raw.name, domain);
  const expiresInDays = !raw.session && raw.expires > 0 ? Math.max(0, Math.round((raw.expires * 1000 - Date.now()) / 86_400_000)) : undefined;
  return {
    name: raw.name,
    domain,
    thirdParty,
    category: hit?.category ?? "unknown",
    platform: hit?.platform || undefined,
    description: hit?.description || undefined,
    session: raw.session,
    expiresInDays,
    consentValue: consentValue(raw.name, raw.value),
  };
}

export function isTracking(c: ObservedCookie): boolean {
  return c.category === "advertising" || c.category === "analytics";
}

export function totals(cookies: ObservedCookie[]): CookieTotals {
  return {
    total: cookies.length,
    thirdParty: cookies.filter((c) => c.thirdParty).length,
    advertising: cookies.filter((c) => c.category === "advertising").length,
    analytics: cookies.filter((c) => c.category === "analytics").length,
    thirdPartyTracking: cookies.filter((c) => c.thirdParty && isTracking(c)).length,
  };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
