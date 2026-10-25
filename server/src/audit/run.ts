import type { Page } from "puppeteer";
import type { AuditConfigKey, AuditRun, BrowserAudit, ConfigSummary, CookieTotals } from "../report/types.js";
import { isTransientNavError } from "../limits.js";
import { safeFetchText } from "../safety/url.js";
import { blockDownloads, getBrowser, loadPage, preparePage, scrollThrough } from "./browser.js";
import { runClickTest } from "./clicktest.js";
import { clickConsent, type ConsentChoice } from "./consent.js";
import { classifyCookie, registrableDomain, totals } from "./cookies.js";

// The measurement follows PrivAudit's crawler (crawler/scripts/cookie_profile_test.js):
// each configuration gets a fresh browser profile, loads the homepage, waits for
// the network to settle plus a short pause, then records the cookies that were
// written. The GPC configuration sends the `Sec-GPC: 1` header and exposes
// navigator.globalPrivacyControl = true, exactly as PrivAudit's "Profile 5" does.
// Unlike PrivAudit, which reads page.cookies() (first-party URL only), we read
// every cookie in the profile so third-party cookies are counted too.

const CONFIGS: { key: AuditConfigKey; label: string; gpc: boolean }[] = [
  { key: "baseline", label: "Default browser, no privacy signal", gpc: false },
  { key: "gpc", label: "Global Privacy Control on", gpc: true },
];
// Run once each, and only on sites where a consent banner was detected.
const CONSENT_CONFIGS: { key: AuditConfigKey; label: string; gpc: false; consent: ConsentChoice }[] = [
  { key: "reject_all", label: "Clicked Reject All on the consent banner", gpc: false, consent: "reject" },
  { key: "accept_all", label: "Clicked Accept All on the consent banner", gpc: false, consent: "accept" },
];
type Config = { key: AuditConfigKey; label: string; gpc: boolean; consent?: ConsentChoice };

// Ad-heavy pages rarely go quiet; after this long we keep what has loaded and mark the run partial.
const NAV_TIMEOUT_MS = 25_000;
const SETTLE_MS = 2_500;
// Ad auctions make every page load different, so one visit per configuration
// can't separate the effect of GPC from chance. Each configuration is loaded
// this many times and verdicts rely on cookies seen in every one of its runs.
const REPEATS = Math.max(1, Math.min(4, Number(process.env.PRIVANY_AUDIT_REPEATS ?? 2)));

interface Discovery {
  privacyPolicy: string[];
  optOut: { text: string; href: string }[];
  banner: { detected: boolean; vendor?: string };
}

async function discoverOnPage(page: Page): Promise<Discovery> {
  return page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[];
    const policy: { href: string; score: number }[] = [];
    const optOut: { text: string; href: string }[] = [];
    for (const a of anchors) {
      const text = (a.innerText || a.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
      const href = a.href;
      if (!href.startsWith("http")) continue;
      const t = text.toLowerCase();
      const h = href.toLowerCase();
      if (/do not sell|don't sell|do not share|your privacy choices|opt[- ]out|cookie (settings|preferences)|privacy (choices|settings)/.test(t)) {
        optOut.push({ text: text.slice(0, 120), href });
        continue;
      }
      let score = 0;
      if (/^(?:our |the )?privacy (?:policy|notice|statement)$/.test(t.trim())) score += 16;
      else if (/privacy (policy|notice|statement)/.test(t)) score += 10;
      else if (/privacy/.test(t)) score += 5;
      if (/\/(?:our-)?privacy(?:-policy|-notice|-statement)?\/?(?:[?#]|$)|\/legal\/privacy/.test(h)) score += 8;
      else if (/privacy[-_]?(policy|notice|statement)/.test(h)) score += 4;
      else if (/privacy/.test(h)) score += 2;
      // Product, template and article pages about privacy aren't the site's own policy
      // (same rules as server/src/policy/links.ts).
      if (/generator|template|builder|\bsamples?\b|\bexamples?\b|\/products?\/|\/solutions?\/|\/resources?\/|\/blog\/|\/learn\/|\/guides?\/|laws?-tracker|data-privacy-laws|privacy-center|trust-center|verification|commitment/.test(`${t} ${h}`)) score -= 14;
      if (a.closest("footer") || /\bagree\b/.test((a.parentElement?.textContent || "").toLowerCase())) score += 3;
      if (/cookie/.test(t) && !/privacy/.test(t)) score -= 3;
      if (score > 0) policy.push({ href, score });
    }
    policy.sort((a, b) => b.score - a.score);
    const vendors: [string, string][] = [
      ["#onetrust-banner-sdk, #onetrust-consent-sdk", "OneTrust"],
      ["#CybotCookiebotDialog", "Cookiebot"],
      ["#truste-consent-track, .truste_box_overlay, #consent_blackbar", "TrustArc"],
      ["#didomi-host", "Didomi"],
      ["#qc-cmp2-ui, .qc-cmp2-container", "Quantcast"],
      ["#usercentrics-root", "Usercentrics"],
      ["#sp_message_container, [id^='sp_message_container']", "Sourcepoint"],
      [".osano-cm-window", "Osano"],
      ["#termly-code-snippet-support", "Termly"],
    ];
    let banner: { detected: boolean; vendor?: string } = { detected: false };
    for (const [sel, name] of vendors) {
      if (document.querySelector(sel)) {
        banner = { detected: true, vendor: name };
        break;
      }
    }
    if (!banner.detected) {
      const generic = Array.from(document.querySelectorAll("[id*='cookie' i], [class*='cookie' i], [id*='consent' i], [class*='consent' i]"));
      if (generic.some((el) => (el as HTMLElement).offsetHeight > 40 && /accept|agree|reject|decline/i.test((el as HTMLElement).innerText || ""))) {
        banner = { detected: true };
      }
    }
    return {
      privacyPolicy: Array.from(new Set(policy.map((p) => p.href))).slice(0, 5),
      optOut: optOut.filter((o, i, all) => all.findIndex((x) => x.href === o.href) === i).slice(0, 6),
      banner,
    };
  });
}

/** One visit, retried once when it fails for a reason that looks like a network blip. */
async function runConfigWithRetry(site: URL, cfg: Config, repeat: number, wantDiscovery: boolean, innerUrl: string | undefined) {
  const first = await runConfig(site, cfg, repeat, wantDiscovery, innerUrl);
  if (first.run.ok || !first.run.error || !isTransientNavError(first.run.error)) return first;
  await new Promise((r) => setTimeout(r, 2_000));
  return runConfig(site, cfg, repeat, wantDiscovery, innerUrl);
}

async function runConfig(
  site: URL,
  cfg: Config,
  repeat: number,
  wantDiscovery: boolean,
  innerUrl: string | undefined,
): Promise<{ run: AuditRun; discovery?: Discovery; inner?: string }> {
  const browser = await getBrowser();
  const context = await browser.createBrowserContext();
  const started = Date.now();
  const hosts = new Set<string>();
  const siteDomain = registrableDomain(site.hostname);
  // These visits click nothing but consent-banner buttons, but a page can still try to open
  // windows on its own; close any it opens so they can't run further code.
  context.on("targetcreated", (t) => {
    if (t.type() === "page" && t.opener()) void t.page().then((p) => p?.close()).catch(() => {});
  });
  try {
    const page = await context.newPage();
    await blockDownloads(page);
    await preparePage(page, (h) => {
      if (registrableDomain(h) !== siteDomain) hosts.add(h);
    });
    if (cfg.gpc) {
      await page.setExtraHTTPHeaders({ "Sec-GPC": "1" });
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(Navigator.prototype, "globalPrivacyControl", { get: () => true, configurable: true });
      });
    }
    let partial = !(await loadPage(page, site.toString(), NAV_TIMEOUT_MS));
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    let consent: AuditRun["consent"];
    if (cfg.consent) {
      consent = await clickConsent(page, cfg.consent);
      // Cookies written in response to the choice need time to land.
      if (consent.clicked) await new Promise((r) => setTimeout(r, SETTLE_MS));
    }
    const finalUrl = page.url();
    const discovery = wantDiscovery ? await discoverOnPage(page).catch(() => undefined) : undefined;
    await scrollThrough(page);

    // Then one inner page of the same site, the way PrivAudit's inner_page step
    // looks past the homepage. Every run opens the same page so runs stay comparable.
    const pagesVisited = [finalUrl];
    const inner = innerUrl ?? (await pickInnerPage(page, registrableDomain(new URL(finalUrl).hostname)).catch(() => undefined));
    if (inner) {
      partial = !(await loadPage(page, inner, NAV_TIMEOUT_MS)) || partial;
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      await scrollThrough(page);
      pagesVisited.push(page.url());
    }

    const raw = await context.cookies();
    const cookies = raw.map((c) => classifyCookie({ name: c.name, value: c.value, domain: c.domain, expires: c.expires, session: c.session }, new URL(finalUrl).hostname));
    return {
      run: { config: cfg.key, repeat, label: cfg.label, consent, ok: true, finalUrl, partial, pagesVisited, durationMs: Date.now() - started, cookies, thirdPartyHosts: [...hosts].sort() },
      discovery,
      inner,
    };
  } catch (err) {
    return {
      run: { config: cfg.key, repeat, label: cfg.label, ok: false, error: describeNavError(err), partial: false, durationMs: Date.now() - started, cookies: [], thirdPartyHosts: [] },
    };
  } finally {
    await context.close().catch(() => {});
  }
}

/** Picks a content page on the same site: a same-domain link with real text, skipping account, legal and file links. */
export async function pickInnerPage(page: Page, siteDomain: string): Promise<string | undefined> {
  return page.evaluate((domain) => {
    const skip = /privacy|terms|legal|cookie|login|log-in|signin|sign-in|signup|sign-up|register|account|logout|cart|checkout|subscribe|download|contact|careers|jobs|help|support|faq/i;
    const fileLink = /\.(pdf|zip|exe|dmg|apk|msi|rar|7z|jpe?g|png|gif|mp4|mp3|avi|mkv|torrent)$/i;
    const here = location.href.split("#")[0];
    const candidates: { href: string; score: number }[] = [];
    for (const a of Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[]) {
      let u: URL;
      try {
        u = new URL(a.href);
      } catch {
        continue;
      }
      const host = u.hostname.toLowerCase();
      if (!/^https?:$/.test(u.protocol) || !(host === domain || host.endsWith(`.${domain}`))) continue;
      const href = u.href.split("#")[0];
      if (u.pathname === "/" || href === here || skip.test(href) || fileLink.test(u.pathname)) continue;
      const rect = a.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const text = (a.innerText || "").trim();
      let score = Math.min(text.length, 80);
      if (a.closest("main, article, [role=main]")) score += 40;
      if (a.closest("nav, header, footer")) score -= 40;
      if (u.pathname.split("/").filter(Boolean).length >= 2) score += 10;
      candidates.push({ href, score });
    }
    candidates.sort((x, y) => y.score - x.score);
    return candidates[0]?.href;
  }, siteDomain);
}

function describeNavError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/ERR_NAME_NOT_RESOLVED/.test(msg)) return "The site's address couldn't be found.";
  if (/ERR_BLOCKED_BY_CLIENT/.test(msg)) return "The site pointed to a private network address, so the test stopped.";
  if (/ERR_CONNECTION|ERR_TIMED_OUT|ERR_ADDRESS/.test(msg)) return "The site couldn't be reached.";
  if (/ERR_CERT/.test(msg)) return "The site's security certificate was rejected.";
  return msg.split("\n")[0].slice(0, 200);
}

async function checkGpcJson(site: URL): Promise<BrowserAudit["gpcJson"]> {
  try {
    const res = await safeFetchText(new URL("/.well-known/gpc.json", site.origin), { maxBytes: 64_000, timeoutMs: 8_000, accept: "application/json" });
    if (res.status !== 200) return { found: false };
    const data = JSON.parse(res.text) as { gpc?: unknown; lastUpdate?: unknown };
    return { found: true, gpc: data.gpc === true, lastUpdate: typeof data.lastUpdate === "string" ? data.lastUpdate : undefined };
  } catch (err) {
    return { found: false, error: err instanceof SyntaxError ? "File exists but isn't valid JSON." : undefined };
  }
}

export interface AuditHooks {
  onProgress?: (detail: string) => void;
  /** Called once, after the first visit, with the policy and opt-out links found on the homepage. */
  onDiscovery?: (links: BrowserAudit["homepageLinks"]) => void;
}

export async function runBrowserAudit(site: URL, hooks: AuditHooks = {}): Promise<BrowserAudit> {
  const startedAt = new Date().toISOString();
  const browser = await getBrowser();
  const gpcJson = checkGpcJson(site);
  const runs: AuditRun[] = [];
  let discovery: Discovery | undefined;
  let inner: string | undefined;
  // Each round visits with and without GPC at the same time, in separate fresh
  // profiles, so both see the site at the same moment (same ads in rotation)
  // and a check takes half as long. Later rounds reuse the inner page picked in
  // the first round's default visit so every visit loads the same pages.
  for (let repeat = 1; repeat <= REPEATS; repeat++) {
    hooks.onProgress?.(`Visit ${repeat} of ${REPEATS}, with and without GPC side by side`);
    const results = await Promise.all(CONFIGS.map((cfg) => runConfigWithRetry(site, cfg, repeat, cfg.key === "baseline" && !discovery, inner)));
    for (const result of results) {
      runs.push(result.run);
      if (result.discovery && !discovery) {
        discovery = result.discovery;
        hooks.onDiscovery?.({ privacyPolicy: discovery.privacyPolicy, optOut: discovery.optOut });
      }
    }
    inner ??= results[0].inner;
  }
  if (!discovery) hooks.onDiscovery?.({ privacyPolicy: [], optOut: [] });
  // The click test (does clicking Play set off pop-ups?) runs alongside the
  // consent-banner visits; both happen after the measured default/GPC rounds.
  hooks.onProgress?.(discovery?.banner.detected ? "Clicking the page like a visitor, and testing Reject All / Accept All" : "Clicking the page like a visitor");
  const clickTask = runClickTest(site, inner);
  if (discovery?.banner.detected) {
    // Reject All and Accept All side by side, loading the same pages as the other visits.
    const consentResults = await Promise.all(CONSENT_CONFIGS.map((cfg) => runConfigWithRetry(site, cfg, 1, false, inner)));
    for (const result of consentResults) runs.push(result.run);
  }
  const clickTest = await clickTask;
  const summary: BrowserAudit["summary"] = {};
  for (const cfg of [...CONFIGS, ...CONSENT_CONFIGS]) {
    // A consent visit where no button was found just looks like the baseline, so it isn't summarized.
    const s = summarize(cfg.key, cfg.label, runs.filter((r) => r.config === cfg.key && (!r.consent || r.consent.clicked)));
    if (s) summary[cfg.key] = s;
  }
  return {
    site: site.hostname,
    startedAt,
    browserVersion: await browser.version(),
    runs,
    summary,
    consentBanner: discovery?.banner ?? { detected: false },
    homepageLinks: { privacyPolicy: discovery?.privacyPolicy ?? [], optOut: discovery?.optOut ?? [] },
    gpcJson: await gpcJson,
    clickTest,
  };
}

function summarize(config: AuditConfigKey, label: string, runs: AuditRun[]): ConfigSummary | undefined {
  const ok = runs.filter((r) => r.ok);
  if (!ok.length) return undefined;
  const per = ok.map((r) => totals(r.cookies));
  const fold = (f: (a: number, b: number) => number): CookieTotals => {
    const keys = Object.keys(per[0]) as (keyof CookieTotals)[];
    return Object.fromEntries(keys.map((k) => [k, per.map((p) => p[k]).reduce((a, b) => f(a, b))])) as unknown as CookieTotals;
  };
  const key = (c: { name: string; domain: string }) => `${c.name}@${c.domain}`;
  const inAll = ok.slice(1).map((r) => new Set(r.cookies.map(key)));
  const stableCookies = ok[0].cookies.filter((c) => inAll.every((set) => set.has(key(c))));
  const stableHosts = ok[0].thirdPartyHosts.filter((h) => ok.every((r) => r.thirdPartyHosts.includes(h)));
  return { config, label, runs: runs.length, okRuns: ok.length, min: fold(Math.min), max: fold(Math.max), stableCookies, stable: totals(stableCookies), stableHosts };
}
