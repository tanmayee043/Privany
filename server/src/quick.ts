import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PriorAudit, QuickCheck } from "./report/types.js";
import { registrableDomain } from "./audit/cookies.js";
import { findPolicy } from "./pipeline.js";
import { rankPolicyLinks } from "./policy/links.js";
import { readPolicyWithRules } from "./policy/rules.js";
import { PolicyFetchError } from "./policy/extract.js";
import { normalizeUrl, UnsafeUrlError } from "./safety/url.js";

// The quick check runs automatically for every site the extension sees, so it
// skips the test visits: it reads the policy with the free rule-based reader
// and adds PrivAudit's own 2025 audit of the site when the paper covered it.
// What the page actually does is observed by the extension in the user's tab.

const TTL_MS = Math.max(60_000, Number(process.env.PRIVANY_QUICK_CACHE_MS ?? 24 * 60 * 60_000));
const MAX_PARALLEL = Math.max(1, Number(process.env.PRIVANY_QUICK_PARALLEL ?? 2));

// From PrivAudit's released data (Zenodo 10.5281/zenodo.22682191, CC BY 4.0),
// prepared by privany/data-pipeline/build_data.py on the features-updated branch.
const PRIOR_PATH = fileURLToPath(new URL("../data/privaudit-prior-audits.json", import.meta.url));
let prior: Record<string, { crawl_date?: string; policy_url?: string; gaps?: { rule: string; detail: string }[] }> | null = null;

export function priorAudit(site: string): PriorAudit | undefined {
  prior ??= JSON.parse(readFileSync(PRIOR_PATH, "utf8"));
  const row = prior![registrableDomain(site)];
  if (!row) return undefined;
  return { crawlDate: row.crawl_date ?? "2025", policyUrl: row.policy_url, gaps: row.gaps ?? [] };
}

// A failed read (no policy found) is kept only briefly, and is retried as soon as
// the extension sends links it hasn't tried: footers often load late.
const FAILURE_TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; result: QuickCheck; links: string }>();
const inflight = new Map<string, Promise<QuickCheck>>();
let running = 0;
const waiting: (() => void)[] = [];

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

export function quickCheck(url: string, policyLinks: string[]): Promise<QuickCheck> {
  const site = normalizeUrl(url);
  const key = registrableDomain(site.hostname);
  // Rank before trimming: a site's own policy can be the last of several privacy links.
  const links = rankPolicyLinks(policyLinks.filter((l) => /^https?:\/\//i.test(l))).slice(0, 4);
  const hit = cache.get(key);
  if (hit) {
    const fresh = Date.now() - hit.at < (hit.result.policy ? TTL_MS : FAILURE_TTL_MS);
    const newLinks = !hit.result.policy && links.some((l) => !hit.links.includes(l));
    if (fresh && !newLinks) return Promise.resolve(hit.result);
  }
  const pending = inflight.get(key);
  if (pending) return pending;
  const task = slot(() => runQuick(site, links))
    .then((result) => {
      cache.set(key, { at: Date.now(), result, links: links.join(" ") });
      if (cache.size > 2000) cache.delete(cache.keys().next().value!);
      return result;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}

async function runQuick(site: URL, policyLinks: string[]): Promise<QuickCheck> {
  const result: QuickCheck = { site: site.hostname, checkedAt: new Date().toISOString(), priorAudit: priorAudit(site.hostname) };
  try {
    const extracted = await findPolicy(new URL(site.origin), policyLinks, () => {});
    const analysis = readPolicyWithRules(extracted, { pasted: false });
    result.policy = {
      url: extracted.url,
      title: extracted.title,
      isPrivacyPolicy: analysis.isPrivacyPolicy,
      claims: analysis.claims.map((c) => ({ key: c.key, value: c.value, summary: c.summary, quote: c.quotes[0] })),
      topics: analysis.topics.map((t) => ({ key: t.key, status: t.status })),
      optOuts: analysis.optOuts.map((o) => ({ kind: o.kind, label: o.label })),
      fieldUses: analysis.fieldUses ?? [],
    };
  } catch (err) {
    result.policyError = err instanceof PolicyFetchError || err instanceof UnsafeUrlError ? err.message : "The privacy policy couldn't be read.";
  }
  return result;
}
