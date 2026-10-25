/**
 * Background worker.
 *
 * Watches, per tab, what actually happens while a page is open:
 *   - cookie writes (HTTP Set-Cookie and document.cookie)
 *   - requests to known trackers (DuckDuckGo Tracker Radar list)
 *   - whether that happened before or after you answered the cookie banner
 *   - the 8 seconds after you hit "Reject"
 *
 * Then asks the backend to read the site's policy, compares the two, and
 * paints the toolbar badge. Cookie *values* are never read or sent.
 */
import { ext, IS_FIREFOX, type Msg } from "../lib/api";
import { backend } from "../lib/backend";
import { classifyCookie, siteKey, siteOf, trackerFor } from "../lib/classify";
import { addReceipt, getSettings, latestReceipt } from "../lib/settings";
import type { AnalysisResult, PageInfo, Receipt, Settings, TabState } from "../lib/types";

const REJECT_WINDOW_S = 8;
const ANALYSIS_TTL_MS = 7 * 24 * 3600 * 1000;
const tabs = new Map<number, TabState>();
const persistTimers = new Map<number, ReturnType<typeof setTimeout>>();

// ------------------------------------------------------------------ state persistence
// Chrome can put the worker to sleep; keep tab state in session storage.
function persist(tabId: number) {
  clearTimeout(persistTimers.get(tabId));
  persistTimers.set(tabId, setTimeout(() => {
    const s = tabs.get(tabId);
    if (s) ext.storage.session?.set({ [`tab:${tabId}`]: s }).catch(() => {});
  }, 250));
}

async function load(tabId: number): Promise<TabState | undefined> {
  if (tabs.has(tabId)) return tabs.get(tabId);
  try {
    const got = (await ext.storage.session.get(`tab:${tabId}`)) as Record<string, TabState>;
    const s = got[`tab:${tabId}`];
    if (s) tabs.set(tabId, s);
    return s;
  } catch {
    return undefined;
  }
}

// worker woke back up: bring tab state back before events start arriving
ext.storage.session?.get(null).then((all: Record<string, unknown>) => {
  for (const [k, v] of Object.entries(all || {})) {
    if (k.startsWith("tab:") && !tabs.has(Number(k.slice(4)))) tabs.set(Number(k.slice(4)), v as TabState);
  }
}).catch(() => {});

function fresh(tabId: number, url: string): TabState {
  const u = new URL(url);
  return {
    tabId, url, origin: u.origin, site: siteOf(u.hostname), siteKey: siteKey(url), startedAt: Date.now(),
    cookies: {}, trackers: {}, choice: { value: "none", at: null }, status: "idle",
  };
}

function trackable(url?: string): boolean {
  return !!url && /^https?:\/\//.test(url);
}

// ------------------------------------------------------------------ badge
const BADGE: Record<string, [string, string]> = {
  red: ["!", "#dc2626"], yellow: ["!", "#d97706"], green: ["✓", "#16a34a"], unknown: ["?", "#6b7280"],
  analyzing: ["…", "#6b7280"], paused: ["", "#6b7280"], error: ["×", "#6b7280"],
};

function paint(s: TabState) {
  const key = s.status === "analyzing" ? "analyzing" : s.status === "paused" || s.status === "skipped" ? "paused"
    : s.status === "error" ? "error" : s.assessment?.verdict ?? "unknown";
  const [text, color] = BADGE[key];
  let t = text;
  if (key === "red") {
    const n = s.assessment!.flags.filter((f) => f.severity === "high").length;
    t = n > 1 ? String(n) : "!";
  }
  ext.action.setBadgeText({ tabId: s.tabId, text: t }).catch(() => {});
  ext.action.setBadgeBackgroundColor({ tabId: s.tabId, color }).catch(() => {});
  const title = s.assessment ? `Privany: ${s.assessment.headline}` :
    s.status === "analyzing" ? "Privany: reading this site's policy..." :
    s.status === "error" ? `Privany: ${s.error ?? "something went wrong"}` : "Privany";
  ext.action.setTitle({ tabId: s.tabId, title }).catch(() => {});
}

function pushToPage(s: TabState) {
  ext.tabs.sendMessage(s.tabId, { type: "state", state: s }).catch(() => {});
}

// ------------------------------------------------------------------ observation
function observation(s: TabState) {
  return {
    gpc_sent: currentSettings?.sendGpc ?? false,
    banner: { found: !!s.page?.banner.found, choice: s.choice.value },
    cookies: Object.values(s.cookies).map(({ name, domain, before_choice }) => ({ name, domain, before_choice })),
    trackers: Object.values(s.trackers).map(({ domain, owner, ad, requests, before_choice }) =>
      ({ domain, owner, ad, requests, before_choice })),
    reject_check: s.reject ? { ...s.reject } : null,
  };
}

function recordCookie(s: TabState, name: string, domain: string, via: "http" | "js") {
  const now = Date.now();
  const c = classifyCookie(name, domain, s.site);
  const key = `${c.name}|${c.domain}`;
  const beforeChoice = s.choice.value === "none";
  if (!s.cookies[key]) {
    s.cookies[key] = { ...c, at: now, before_choice: beforeChoice, via };
  }
  // the Reject watch: anything ad-related written after the click
  if (s.reject && s.reject.status === "watching" && now > s.reject.clicked_at + 300 && c.ad_platform) {
    if (!s.reject.new_cookies.some((x) => x.name === c.name && x.domain === c.domain)) {
      s.reject.new_cookies.push({ name: c.name, domain: c.domain, owner: c.owner });
    }
  }
  persist(s.tabId);
}

function recordTracker(s: TabState, host: string) {
  const tr = trackerFor(host);
  if (!tr) return;
  const now = Date.now();
  const t = s.trackers[tr.domain] ?? (s.trackers[tr.domain] = {
    domain: tr.domain, owner: tr.owner, ad: tr.ad, requests: 0, first_at: now, before_choice: s.choice.value === "none",
  });
  t.requests++;
  if (s.reject && s.reject.status === "watching" && now > s.reject.clicked_at + 300 && tr.ad) {
    const r = s.reject.ad_requests.find((x) => x.domain === tr.domain);
    if (r) r.requests++;
    else s.reject.ad_requests.push({ domain: tr.domain, owner: tr.owner, ad: tr.ad, requests: 1 });
  }
  persist(s.tabId);
}

// main-frame navigations reset a tab (except a same-site reload right after Reject)
ext.webRequest.onBeforeRequest.addListener((d) => {
  if (d.tabId < 0 || !trackable(d.url)) return;
  if (d.type === "main_frame") {
    const prev = tabs.get(d.tabId);
    const next = fresh(d.tabId, d.url);
    if (prev?.reject?.status === "watching" && prev.siteKey === next.siteKey) {
      next.reject = prev.reject;
      next.choice = prev.choice;
    }
    tabs.set(d.tabId, next);
    persist(d.tabId);
    return;
  }
  const s = tabs.get(d.tabId);
  if (!s) return;
  const host = new URL(d.url).hostname;
  if (siteOf(host) !== s.site) recordTracker(s, host);
}, { urls: ["<all_urls>"] });

// HTTP cookies: Chrome only shows Set-Cookie with "extraHeaders"; Firefox always does
const headerSpec = (IS_FIREFOX ? ["responseHeaders"] : ["responseHeaders", "extraHeaders"]) as chrome.webRequest.OnHeadersReceivedOptions[];
ext.webRequest.onHeadersReceived.addListener((d) => {
  if (d.tabId < 0) return;
  const s = tabs.get(d.tabId);
  if (!s || !d.responseHeaders) return;
  const reqHost = new URL(d.url).hostname;
  for (const h of d.responseHeaders) {
    if (h.name.toLowerCase() !== "set-cookie" || !h.value) continue;
    // Firefox joins multiple Set-Cookie headers with newlines
    for (const line of h.value.split("\n")) {
      const name = line.split("=")[0]?.trim();
      if (!name) continue;
      const dm = /;\s*domain=([^;]+)/i.exec(line);
      recordCookie(s, name, dm ? dm[1].trim() : reqHost, "http");
    }
  }
}, { urls: ["<all_urls>"] }, headerSpec);

// JS cookies (document.cookie): attribute to tabs on that site
ext.cookies.onChanged.addListener(({ cookie, removed, cause }) => {
  if (removed || cause === "expired" || cause === "evicted") return;
  const cs = siteOf(cookie.domain);
  for (const s of tabs.values()) {
    if (s.site === cs && !s.cookies[`${cookie.name}|${cookie.domain.replace(/^\./, "")}`]) {
      recordCookie(s, cookie.name, cookie.domain, "js");
    }
  }
});

ext.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
  ext.storage.session?.remove(`tab:${tabId}`).catch(() => {});
});

// ------------------------------------------------------------------ analysis + assessment
let currentSettings: Settings | null = null;
getSettings().then((s) => { currentSettings = s; applyGpc(s.sendGpc); });

async function cachedAnalysis(key: string): Promise<AnalysisResult | null> {
  const got = (await ext.storage.local.get(`analysis:${key}`)) as Record<string, { at: number; result: AnalysisResult }>;
  const row = got[`analysis:${key}`];
  return row && Date.now() - row.at < ANALYSIS_TTL_MS ? row.result : null;
}

async function analyzeTab(s: TabState, force = false) {
  const settings = currentSettings ?? (await getSettings());
  if (settings.paused.includes(s.siteKey)) {
    s.status = "paused";
    paint(s);
    pushToPage(s);
    return;
  }
  const atMoment = (s.page?.contexts ?? []).some((c) => c !== "any");
  if (settings.mode === "moments" && !atMoment && !force) {
    s.status = "skipped";
    paint(s);
    return;
  }

  s.status = "analyzing";
  paint(s);
  try {
    // You agreed to this site's terms before: always check whether they changed.
    // Cheap: the server refetches the documents and only re-reads them if the text differs.
    const recheck = !!(await latestReceipt(s.siteKey));
    let result = force || recheck ? null : await cachedAnalysis(s.siteKey);
    if (!result) {
      result = await backend.analyze(settings.backendUrl, s.origin + "/", s.page?.links ?? { privacy: [], terms: [], cookies: [] }, force, recheck);
      if (result.analysis) await ext.storage.local.set({ [`analysis:${s.siteKey}`]: { at: Date.now(), result } });
    }
    s.analysis = result;
    s.status = "ready";
    await assessTab(s);
    maybeStartGpcTest(s);
  } catch (e) {
    s.status = "error";
    s.error = String((e as Error).message || e).includes("fetch")
      ? "Can't reach the Privany server. Is it running?" : String((e as Error).message || e);
    paint(s);
    pushToPage(s);
  }
  persist(s.tabId);
}

async function assessTab(s: TabState) {
  if (!s.analysis) return;
  const settings = currentSettings ?? (await getSettings());
  const receipt = await latestReceipt(s.siteKey);
  try {
    s.assessment = await backend.assess(settings.backendUrl, {
      site: s.origin + "/",
      analysis: s.analysis.analysis,
      documents: s.analysis.documents,
      observation: observation(s),
      preferences: settings.preferences,
      receipt: receipt ? {
        agreed_at: receipt.agreed_at,
        hashes: Object.fromEntries(receipt.documents.map((d) => [d.url, d.content_hash])),
        claims_then: receipt.claims_then,
        findings_then: receipt.findings_then,
      } : null,
    });
  } catch (e) {
    s.error = String((e as Error).message || e);
  }
  paint(s);
  pushToPage(s);
  persist(s.tabId);
}

// re-assess when the picture changes, but not on every single cookie
const reassessTimers = new Map<number, ReturnType<typeof setTimeout>>();
function reassessSoon(s: TabState, ms = 1500) {
  clearTimeout(reassessTimers.get(s.tabId));
  reassessTimers.set(s.tabId, setTimeout(() => assessTab(s), ms));
}

// Only test the GPC claim when there is one to test
function maybeStartGpcTest(s: TabState, manual = false) {
  const claim = s.analysis?.analysis?.claims?.honors_gpc?.value;
  if (!manual && (claim !== "true" || !currentSettings?.autoGpcTest)) return;
  if (s.gpc?.status === "running" || (s.gpc?.status === "done" && !manual)) return;
  runGpcTest(s, manual);
}

async function runGpcTest(s: TabState, manual: boolean) {
  const base = (currentSettings ?? (await getSettings())).backendUrl;
  s.gpc = { status: "running" };
  pushToPage(s);
  try {
    let r = await backend.startGpc(base, s.origin + "/", manual);
    const until = Date.now() + 150_000;
    while (r.status === "running" && Date.now() < until) {
      await new Promise((res) => setTimeout(res, 3000));
      r = await backend.pollGpc(base, s.siteKey);
    }
    if (r.status === "done" && r.result) s.gpc = { status: "done", result: r.result };
    else s.gpc = { status: "error", error: r.error ?? "The test didn't finish." };
  } catch (e) {
    s.gpc = { status: "error", error: String((e as Error).message || e) };
  }
  await assessTab(s);
}

// ------------------------------------------------------------------ GPC signal
const GPC_RULE_ID = 1;
async function applyGpc(on: boolean) {
  try {
    await ext.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [GPC_RULE_ID],
      addRules: on ? [{
        id: GPC_RULE_ID, priority: 1,
        action: { type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
          requestHeaders: [{ header: "Sec-GPC", operation: "set" as chrome.declarativeNetRequest.HeaderOperation, value: "1" }] },
        condition: { resourceTypes: ["main_frame", "sub_frame", "script", "xmlhttprequest", "image", "ping", "other"] as chrome.declarativeNetRequest.ResourceType[] },
      }] : [],
    });
    const existing = await ext.scripting.getRegisteredContentScripts({ ids: ["privany-gpc"] }).catch(() => []);
    if (on && !existing.length) {
      await ext.scripting.registerContentScripts([{
        id: "privany-gpc", js: ["gpc-main.js"], matches: ["<all_urls>"], runAt: "document_start", allFrames: true,
        world: "MAIN" as chrome.scripting.ExecutionWorld,
      }]);
    } else if (!on && existing.length) {
      await ext.scripting.unregisterContentScripts({ ids: ["privany-gpc"] });
    }
  } catch (e) {
    console.warn("Privany: couldn't toggle GPC", e);
  }
}

// ------------------------------------------------------------------ consent receipts
async function saveReceipt(s: TabState, how: Receipt["how"]) {
  if (!s.analysis?.documents.length) return;
  const settings = currentSettings ?? (await getSettings());
  try {
    const snap = await backend.snapshot(settings.backendUrl, s.analysis.documents.map((d) => d.url));
    if (!snap.documents.length) return;
    await addReceipt({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      siteKey: s.siteKey, site: s.site, agreed_at: new Date().toISOString(), page_url: s.url, how,
      documents: snap.documents.map((d) => ({ ...d, paragraphs: d.paragraphs.slice(0, 2000) })),
      verdict_then: s.assessment?.verdict ?? "unknown", headline_then: s.assessment?.headline ?? "",
      claims_then: Object.fromEntries(Object.entries(s.analysis.analysis?.claims ?? {})
        .map(([k, c]) => [k, { value: c.value, quote: c.evidence.quote }])),
      findings_then: (s.analysis.analysis?.findings ?? [])
        .filter((f) => f.evidence.verified).map((f) => ({ category: f.category, stance: f.stance })),
    });
    ext.tabs.sendMessage(s.tabId, { type: "receipt_saved" }).catch(() => {});
  } catch (e) {
    console.warn("Privany: receipt failed", e);
  }
}

// ------------------------------------------------------------------ messages
ext.runtime.onMessage.addListener((msg: Msg, sender, reply) => {
  (async () => {
    // an explicit tabId wins: the full report is itself a tab, but it's asking about another one
    const tabId = ("tabId" in msg && msg.tabId !== undefined) ? msg.tabId : sender.tab?.id;
    if (msg.type === "settings_changed") {
      currentSettings = await getSettings();
      await applyGpc(currentSettings.sendGpc);
      for (const s of tabs.values()) if (s.analysis) reassessSoon(s, 100);
      return reply({ ok: true });
    }
    if (tabId === undefined) return reply(null);
    let s = await load(tabId);

    switch (msg.type) {
      case "page_info": {
        if (!trackable(msg.info.url)) return reply(null);
        if (!s || siteKey(msg.info.url) !== s.siteKey) {
          s = fresh(tabId, msg.info.url);
          tabs.set(tabId, s);
        }
        const first = !s.page;
        if (first) await backfillCookies(s);
        s.page = mergePage(s.page, msg.info);
        s.url = msg.info.url;
        if (first || (!s.analysis && s.status !== "analyzing")) analyzeTab(s);
        else if (s.analysis) reassessSoon(s, 300);
        return reply({ ok: true });
      }
      case "consent_click": {
        if (!s) return reply(null);
        s.choice = { value: msg.choice, at: Date.now() };
        if (msg.choice === "rejected") {
          s.reject = { clicked_at: Date.now(), window_s: REJECT_WINDOW_S, status: "watching", new_cookies: [], ad_requests: [] };
          reassessSoon(s, 100);
          const state = s;
          setTimeout(() => {
            if (state.reject?.status === "watching") {
              state.reject.status = "done";
              assessTab(state);
            }
          }, REJECT_WINDOW_S * 1000);
        } else {
          reassessSoon(s, 500);
        }
        persist(tabId);
        return reply({ ok: true });
      }
      case "agreed":
        if (s) saveReceipt(s, msg.how);
        return reply({ ok: true });
      case "get_state":
        return reply(s ?? null);
      case "run_gpc_test":
        if (s) { s.gpc = undefined; runGpcTest(s, true); }
        return reply({ ok: true });
      case "reanalyze":
        if (s) analyzeTab(s, true);
        return reply({ ok: true });
      case "open_report":
        await ext.tabs.create({ url: ext.runtime.getURL(`popup.html?tab=${tabId}&full=1`) });
        return reply({ ok: true });
      case "dismiss_site":
        return reply({ ok: true });
    }
  })();
  return true; // async reply
});

// If the worker was asleep or just installed when the page loaded, cookie events
// were missed. Pick up the site's current cookies so nothing slips through.
async function backfillCookies(s: TabState) {
  try {
    const jar = await ext.cookies.getAll({ url: s.origin + "/" });
    for (const c of jar) {
      if (!s.cookies[`${c.name}|${c.domain.replace(/^\./, "")}`]) recordCookie(s, c.name, c.domain, "js");
    }
  } catch { /* no cookie access for this URL */ }
}

function mergePage(prev: PageInfo | undefined, next: PageInfo): PageInfo {
  if (!prev) return next;
  const uniq = (a: string[], b: string[]) => [...new Set([...a, ...b])];
  return {
    ...next,
    links: { privacy: uniq(prev.links.privacy, next.links.privacy), terms: uniq(prev.links.terms, next.links.terms),
             cookies: uniq(prev.links.cookies, next.links.cookies) },
    banner: { found: prev.banner.found || next.banner.found, cmp: next.banner.cmp ?? prev.banner.cmp },
    contexts: [...new Set([...prev.contexts, ...next.contexts])],
    fields: [...new Set([...prev.fields, ...next.fields])],
  };
}

ext.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === "install") await ext.tabs.create({ url: ext.runtime.getURL("options.html?welcome=1") });
});
