/// <reference types="chrome" />
import type { QuickCheck } from "../../server/src/report/types";
import { cookieCategory, isTrackingCategory, siteOf, trackerFor } from "./classify";
import { assessRisk, type Assessment, type Observed } from "./risk";
import { autoCheckEnabled, mutedSites } from "./settings";
import { API_BASE } from "./shared";

// Automatic checking. For every page the user opens, the extension notes which
// outside ad-tech companies it contacts and which tracking cookies it sets
// (in this browser, on this device), asks the local Privany server what the
// site's policy promises (cached per site), and works out a risk level. The
// toolbar badge always shows it; only risky (red) sites get a panel on the page.
// Nothing leaves the computer: the server runs on localhost.

interface TabWatch {
  site: string;
  pageUrl: string;
  startedAt: number;
  adTrackers: Map<string, { domain: string; owner: string }>;
  cookies: Map<string, { name: string; owner?: string }>;
  bannerVisible: boolean;
  policyLinks: string[];
  assessment?: Assessment;
  quick?: QuickCheck;
  shown: boolean;
}

export interface TabRisk {
  site: string;
  assessment: Assessment;
  quick?: QuickCheck;
  observed: { adTrackers: number; trackingCookies: number; bannerVisible: boolean; policyLinks: number };
  at: number;
}

const tabs = new Map<number, TabWatch>();
const QUICK_TTL_MS = 12 * 60 * 60_000;
const quickMemo = new Map<string, { at: number; q: QuickCheck }>();

const watchable = (url: string | undefined) => {
  if (!url) return false;
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && !url.startsWith(API_BASE) && u.hostname !== "localhost" && u.hostname !== "127.0.0.1";
  } catch {
    return false;
  }
};

function reset(tabId: number, url: string): TabWatch {
  const w: TabWatch = { site: siteOf(new URL(url).hostname), pageUrl: url, startedAt: Date.now(), adTrackers: new Map(), cookies: new Map(), bannerVisible: false, policyLinks: [], shown: false };
  tabs.set(tabId, w);
  void chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  return w;
}

function noteCookie(w: TabWatch, name: string, domain: string) {
  const { category, owner } = cookieCategory(name, domain);
  if (isTrackingCategory(category)) w.cookies.set(`${name}@${domain}`, { name, owner });
}

export function startWatching() {
  chrome.webRequest.onBeforeRequest.addListener(
    (d) => {
      if (d.tabId < 0) return;
      if (d.type === "main_frame") {
        if (watchable(d.url)) reset(d.tabId, d.url);
        else tabs.delete(d.tabId);
        return;
      }
      const w = tabs.get(d.tabId);
      if (!w) return;
      let host: string;
      try {
        host = new URL(d.url).hostname;
      } catch {
        return;
      }
      if (siteOf(host) === w.site) return;
      const t = trackerFor(host);
      if (t?.ad) w.adTrackers.set(t.domain, { domain: t.domain, owner: t.owner });
    },
    { urls: ["http://*/*", "https://*/*"] },
  );

  // Cookies set by servers (Set-Cookie). Cookies set by page scripts, like
  // Facebook's _fbp, are read from the cookie store when the check runs.
  chrome.webRequest.onHeadersReceived.addListener(
    (d) => {
      const w = d.tabId >= 0 ? tabs.get(d.tabId) : undefined;
      if (!w || !d.responseHeaders) return;
      let host = "";
      try {
        host = new URL(d.url).hostname;
      } catch {
        return;
      }
      for (const h of d.responseHeaders) {
        if (h.name.toLowerCase() !== "set-cookie" || !h.value) continue;
        for (const line of h.value.split("\n")) {
          const name = line.split("=")[0]?.trim();
          const domain = /;\s*domain=([^;]+)/i.exec(line)?.[1]?.trim().replace(/^\./, "") ?? host;
          if (name) noteCookie(w, name, domain);
        }
      }
    },
    { urls: ["http://*/*", "https://*/*"] },
    ["responseHeaders", "extraHeaders"],
  );

  chrome.tabs.onRemoved.addListener((tabId) => tabs.delete(tabId));
}

async function quickFor(w: TabWatch): Promise<QuickCheck | undefined> {
  const memo = quickMemo.get(w.site);
  if (memo && Date.now() - memo.at < QUICK_TTL_MS && memo.q.policy) return memo.q;
  try {
    const res = await fetch(`${API_BASE}/api/quick`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: new URL(w.pageUrl).origin, policyLinks: w.policyLinks }),
    });
    if (!res.ok) return undefined;
    const q = (await res.json()) as QuickCheck;
    quickMemo.set(w.site, { at: Date.now(), q });
    return q;
  } catch {
    return undefined; // server not running: the badge says so
  }
}

const BADGE: Record<Assessment["level"], { text: string; color: string; title: string }> = {
  red: { text: "!", color: "#B42318", title: "Privany: this site looks risky. Click for the full report." },
  yellow: { text: "!", color: "#B54708", title: "Privany: one thing worth knowing. Click for the full report." },
  green: { text: "✓", color: "#166534", title: "Privany: nothing risky spotted. Click for the full report." },
  unknown: { text: "?", color: "#5B6170", title: "Privany: couldn't find a privacy policy. Click for the full report." },
};

/** Called by the content script once the page has settled; runs the check and shows the result. */
export async function assessTab(tabId: number, info: { url: string; policyLinks: string[]; bannerVisible: boolean }): Promise<void> {
  if (!watchable(info.url) || !(await autoCheckEnabled())) return;
  let w = tabs.get(tabId);
  if (!w || siteOf(new URL(info.url).hostname) !== w.site) w = reset(tabId, info.url);
  w.pageUrl = info.url;
  w.bannerVisible = info.bannerVisible;
  w.policyLinks = info.policyLinks;

  // Script-set cookies (e.g. _fbp, _ga) live in the cookie store for this page.
  const jar = await chrome.cookies.getAll({ url: info.url }).catch(() => [] as chrome.cookies.Cookie[]);
  for (const c of jar) noteCookie(w, c.name, c.domain.replace(/^\./, ""));

  const quick = await quickFor(w);
  if (tabs.get(tabId) !== w) return; // the user moved on while we waited
  const observed: Observed = { adTrackers: [...w.adTrackers.values()], trackingCookies: [...w.cookies.values()], bannerVisible: w.bannerVisible };
  const assessment = assessRisk(observed, quick);
  w.assessment = assessment;
  w.quick = quick;

  const badge = quick ? BADGE[assessment.level] : { text: "", color: "#5B6170", title: "Privany: the Privany server isn't running, so automatic checks are paused." };
  await chrome.action.setBadgeText({ tabId, text: badge.text }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color }).catch(() => {});
  await chrome.action.setTitle({ tabId, title: badge.title }).catch(() => {});
  const risk: TabRisk = {
    site: w.site,
    assessment,
    quick,
    observed: { adTrackers: observed.adTrackers.length, trackingCookies: observed.trackingCookies.length, bannerVisible: observed.bannerVisible, policyLinks: w.policyLinks.length },
    at: Date.now(),
  };
  await chrome.storage.session.set({ [`risk:${tabId}`]: risk }).catch(() => {});

  const muted = (await mutedSites()).includes(w.site);
  // Notes under sign-up/checkout fields: only details the policy says are used for
  // marketing, ads, sharing or sale, each with the policy's own sentence.
  const fieldUses = (quick?.policy?.fieldUses ?? []).filter((f) => f.purposes.length > 0);
  if (fieldUses.length && !muted) await chrome.tabs.sendMessage(tabId, { type: "privany:fields", site: w.site, uses: fieldUses }).catch(() => {});

  if (assessment.level === "red" && !w.shown && !muted) {
    w.shown = true;
    await chrome.tabs.sendMessage(tabId, { type: "privany:danger", site: w.site, reasons: assessment.reasons.slice(0, 3), total: assessment.reasons.length }).catch(() => {});
  }
}
