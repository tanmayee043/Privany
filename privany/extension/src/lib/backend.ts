import type { AnalysisResult, Assessment, GpcAudit, PageInfo, Preferences, Receipt } from "./types";

async function call<T>(base: string, path: string, body?: unknown, timeoutMs = 120_000): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(base.replace(/\/$/, "") + path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      let detail = text;
      try { detail = JSON.parse(text).detail ?? text; } catch { /* plain text */ }
      throw new Error(`${r.status}: ${String(detail).slice(0, 200)}`);
    }
    return (await r.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

export const backend = {
  health: (base: string) => call<{ ok: boolean; engine: string; model: string | null }>(base, "/health", undefined, 4000),

  analyze: (base: string, siteUrl: string, links: PageInfo["links"], fresh = false, revalidate = false) =>
    call<AnalysisResult>(base, "/v1/analyze", { site_url: siteUrl, links, fresh, revalidate }),

  assess: (base: string, body: {
    site: string;
    analysis: AnalysisResult["analysis"];
    documents: AnalysisResult["documents"];
    observation: unknown;
    preferences: Preferences;
    receipt: {
      agreed_at: string; hashes: Record<string, string>;
      claims_then?: Receipt["claims_then"]; findings_then?: Receipt["findings_then"];
    } | null;
  }) => call<Assessment>(base, "/v1/assess", body, 20_000),

  startGpc: (base: string, siteUrl: string, fresh = false) =>
    call<{ status: string; result?: GpcAudit; error?: string }>(base, "/v1/gpc-audit", { site_url: siteUrl, fresh }, 15_000),

  pollGpc: (base: string, siteKey: string) =>
    call<{ status: string; result?: GpcAudit; error?: string }>(base, `/v1/gpc-audit?site=${encodeURIComponent(siteKey)}`, undefined, 10_000),

  snapshot: (base: string, urls: string[]) =>
    call<{ documents: Receipt["documents"]; errors: string[] }>(base, "/v1/snapshot", { urls }),

  diff: (base: string, url: string, oldHash: string, oldParagraphs: string[]) =>
    call<{ changed: boolean; new_hash: string; added?: string[]; removed?: string[]; similarity?: number }>(
      base, "/v1/diff", { url, old_hash: oldHash, old_paragraphs: oldParagraphs }),
};
