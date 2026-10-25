/// <reference types="chrome" />
import { capturePage } from "./capture";
import { API_BASE, type TabState } from "./shared";

// Clicking the toolbar icon opens Privany's side panel for that tab only and
// starts a check of the page the user is looking at. Privany sees a page only
// when its icon is clicked on it (the activeTab permission).

chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  const tabId = tab.id;
  // Both calls must run straight away, inside the click, for Chrome to allow opening the panel.
  void chrome.sidePanel.setOptions({ tabId, path: `sidepanel.html?tab=${tabId}`, enabled: true });
  void chrome.sidePanel.open({ tabId });
  void startCheck(tabId);
});

chrome.runtime.onMessage.addListener((msg: { type?: string; tabId?: number }) => {
  // "Check again" skips the server's cache of recent results.
  if (msg.type === "privany:recheck" && typeof msg.tabId === "number") void startCheck(msg.tabId, { fresh: true });
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
