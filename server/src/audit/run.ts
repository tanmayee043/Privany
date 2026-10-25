import type { Page } from "puppeteer";
import type { AuditConfigKey, AuditRun, BrowserAudit, ConfigSummary, CookieTotals } from "../report/types.js";
import { isTransientNavError } from "../limits.js";
import { safeFetchText } from "../safety/url.js";
import { getBrowser, preparePage } from "./browser.js";
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

const NAV_TIMEOUT_MS = 45_000;
const SETTLE_MS = 3_000;
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
      if (/privacy (policy|notice|statement)/.test(t)) score += 10;
      else if (/^privacy$/.test(t) || /privacy/.test(t)) score += 5;
      if (/privacy[-_]?(policy|notice|statement)/.test(h)) score += 4;
      else if (/privacy/.test(h)) score += 2;
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
async function runConfigWithRetry(site: URL, cfg: Config, repeat: number, wantDiscovery: boolean) {
  const first = await runConfig(site, cfg, repeat, wantDiscovery);
  if (first.run.ok || !first.run.error || !isTransientNavError(first.run.error)) return first;
  await new Promise((r) => setTimeout(r, 2_000));
  return runConfig(site, cfg, repeat, wantDiscovery);
}

async function runConfig(site: URL, cfg: Config, repeat: number, wantDiscovery: boolean): Promise<{ run: AuditRun; discovery?: Discovery }> {
  const browser = await getBrowser();
  const context = await browser.createBrowserContext();
  const started = Date.now();
  const hosts = new Set<string>();
  const siteDomain = registrableDomain(site.hostname);
  try {
    const page = await context.newPage();
    await preparePage(page, (h) => {
      if (registrableDomain(h) !== siteDomain) hosts.add(h);
    });
    if (cfg.gpc) {
      await page.setExtraHTTPHeaders({ "Sec-GPC": "1" });
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(Navigator.prototype, "globalPrivacyControl", { get: () => true, configurable: true });
      });
    }
    let partial = false;
    try {
      await page.goto(site.toString(), { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS });
    } catch (err) {
      if (!(err instanceof Error && err.name === "TimeoutError")) throw err;
      partial = true;
    }
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    let consent: AuditRun["consent"];
    if (cfg.consent) {
      consent = await clickConsent(page, cfg.consent);
      // Cookies written in response to the choice need time to land.
      if (consent.clicked) await new Promise((r) => setTimeout(r, SETTLE_MS));
    }
    const finalUrl = page.url();
    const raw = await context.cookies();
    const cookies = raw.map((c) => classifyCookie({ name: c.name, value: c.value, domain: c.domain, expires: c.expires, session: c.session }, new URL(finalUrl).hostname));
    const discovery = wantDiscovery ? await discoverOnPage(page).catch(() => undefined) : undefined;
    return {
      run: { config: cfg.key, repeat, label: cfg.label, consent, ok: true, finalUrl, partial, durationMs: Date.now() - started, cookies, thirdPartyHosts: [...hosts].sort() },
      discovery,
    };
  } catch (err) {
    return {
      run: { config: cfg.key, repeat, label: cfg.label, ok: false, error: describeNavError(err), partial: false, durationMs: Date.now() - started, cookies: [], thirdPartyHosts: [] },
    };
  } finally {
    await context.close().catch(() => {});
  }
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
  // Runs alternate between configurations (baseline, GPC, baseline, GPC) so a
  // change in the site over the test window affects both equally. They run one
  // at a time so they don't compete for bandwidth; PrivAudit also visits each
  // profile in turn.
  for (let repeat = 1; repeat <= REPEATS; repeat++) {
    for (const cfg of CONFIGS) {
      hooks.onProgress?.(`${cfg.label} (visit ${repeat} of ${REPEATS})`);
      const result = await runConfigWithRetry(site, cfg, repeat, cfg.key === "baseline" && !discovery);
      runs.push(result.run);
      if (result.discovery && !discovery) {
        discovery = result.discovery;
        hooks.onDiscovery?.({ privacyPolicy: discovery.privacyPolicy, optOut: discovery.optOut });
      }
    }
  }
  if (!discovery) hooks.onDiscovery?.({ privacyPolicy: [], optOut: [] });
  if (discovery?.banner.detected) {
    for (const cfg of CONSENT_CONFIGS) {
      hooks.onProgress?.(cfg.label);
      runs.push((await runConfigWithRetry(site, cfg, 1, false)).run);
    }
  }
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
  return { config, label, runs: runs.length, okRuns: ok.length, min: fold(Math.min), max: fold(Math.max), stableCookies, stable: totals(stableCookies) };
}
