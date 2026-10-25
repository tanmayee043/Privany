/// <reference types="chrome" />
import { capturePage } from "./capture";
import { muteSite } from "./settings";
import { API_BASE, type TabState } from "./shared";
import { assessTab, startWatching } from "./watch";

// Two ways in. Automatic: every page gets a quick check (watch.ts) and risky
// sites show a panel on the page. On demand: clicking the toolbar icon (or the
// panel's "Full report") opens Privany's side panel for that tab and runs the
// full check with test visits.

startWatching();

function openFullReport(tabId: number) {
  // Both calls must run straight away, inside the user's click, for Chrome to allow opening the panel.
  void chrome.sidePanel.setOptions({ tabId, path: `sidepanel.html?tab=${tabId}`, enabled: true });
  const opened = chrome.sidePanel.open({ tabId });
  void startCheck(tabId);
  return opened;
}

chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  void openFullReport(tab.id);
});

type Msg = { type?: string; tabId?: number; url?: string; policyLinks?: string[]; bannerVisible?: boolean; site?: string };

chrome.runtime.onMessage.addListener((msg: Msg, sender, reply) => {
  const tabId = sender.tab?.id;
  // "Check again" skips the server's cache of recent results.
  if (msg.type === "privany:recheck" && typeof msg.tabId === "number") void startCheck(msg.tabId, { fresh: true });
  if (msg.type === "privany:page" && tabId !== undefined && msg.url) {
    void assessTab(tabId, { url: msg.url, policyLinks: msg.policyLinks ?? [], bannerVisible: Boolean(msg.bannerVisible) });
  }
  if (msg.type === "privany:mute" && msg.site) void muteSite(msg.site);
  if (msg.type === "privany:open-report" && tabId !== undefined) {
    // The click on the page's panel counts as the user's gesture; if Chrome
    // still refuses, the panel tells the user to use the toolbar icon.
    openFullReport(tabId).then(
      () => reply(true),
      () => reply(false),
    );
    return true;
  }
  return false;
});

// Moving the tab to a different site clears its result; reloads and in-site
// navigation (which many sites do on their own) keep it.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.url) return;
  const host = siteOf(info.url)?.hostname;
  void chrome.storage.session.get(key(tabId)).then((r) => {
    const state = r[key(tabId)] as TabState | undefined;
    if (state && "site" in state && state.site && host !== state.site) void chrome.storage.session.remove(key(tabId));
  });
});
chrome.tabs.onRemoved.addListener((tabId) => void chrome.storage.session.remove(key(tabId)));

const key = (tabId: number) => `tab:${tabId}`;

async function setState(tabId: number, state: TabState) {
  await chrome.storage.session.set({ [key(tabId)]: state });
}

async function startCheck(tabId: number, opts: { fresh?: boolean } = {}) {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  const site = siteOf(tab.url);
  if (!site) {
    await setState(tabId, { phase: "error", error: "Privany can only check regular websites (http or https pages).", at: Date.now() });
    return;
  }
  await setState(tabId, { phase: "reading", site: site.hostname, at: Date.now() });

  let page: ReturnType<typeof capturePage>;
  try {
    const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: capturePage });
    page = result.result as ReturnType<typeof capturePage>;
  } catch {
    await setState(tabId, {
      phase: "error",
      site: site.hostname,
      error: "Chrome didn't let Privany read this page. Click the Privany icon again while this tab is open.",
      at: Date.now(),
    });
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // The homepage is what gets tested; the open page supplies the policy text.
      body: JSON.stringify({ url: site.origin, page, fresh: opts.fresh === true }),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
    if (!res.ok || !body.id) throw new Error(body.error ?? `The Privany server answered ${res.status}.`);
    await setState(tabId, { phase: "running", site: site.hostname, jobId: body.id, pageUrl: page.url, at: Date.now() });
  } catch (err) {
    const offline = err instanceof TypeError;
    await setState(tabId, {
      phase: "error",
      site: site.hostname,
      error: offline ? "The Privany server isn't running. Start it with `npm run dev` in the Privany folder, then try again." : (err as Error).message,
      offline,
      at: Date.now(),
    });
  }
}

function siteOf(url: string | undefined): URL | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u : undefined;
  } catch {
    return undefined;
  }
}
