import type { Page, Target } from "puppeteer";
import type { ClickPopup, ClickTest } from "../report/types.js";
import { blockDownloads, getBrowser, loadPage, preparePage, scrollThrough } from "./browser.js";
import { classifyCookie, isTracking, registrableDomain } from "./cookies.js";

// The visits in run.ts never click page content. Many sites, especially
// streaming and download sites, attach their pop-up ads to a visitor's first
// clicks ("Play", or anywhere on the page). This test clicks the way a visitor
// would, in a separate throwaway browser profile, and records what that set
// off. It goes beyond PrivAudit, which doesn't click page content.
//
// Safety: a pop-up's first request is recorded and then blocked, so its page
// never loads or runs, and the window is closed. Downloads are refused, and
// the main page keeps the private-address guard from preparePage().

const CLICKS = 2;
const WAIT_AFTER_CLICK_MS = 4_000;
const NAV_TIMEOUT_MS = 25_000;

type Target_ = { x: number; y: number; kind: NonNullable<ClickTest["target"]>["kind"]; label?: string };

/** Finds what a visitor would click: a Play-like button, else a video player, else the middle of the screen. */
async function findTarget(page: Page): Promise<Target_> {
  const found = await page.evaluate(() => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 20 && r.height > 20 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.1;
    };
    const center = (el: Element) => {
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    };
    const playWords = /\b(play|watch(?: now| online| free)?|stream(?: now)?|start watching)\b/i;
    const buttons = Array.from(document.querySelectorAll("button, a, [role=button], [class*='play' i], [id*='play' i]"));
    for (const el of buttons) {
      const label = ((el as HTMLElement).innerText || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\s+/g, " ").trim();
      const isPlayClass = /(^|[-_\s])play(-?btn|-?button|er-?button|_icon|-icon)?($|[-_\s])/i.test(`${el.className} ${el.id}`);
      if (visible(el) && ((label && label.length < 40 && playWords.test(label)) || isPlayClass)) {
        return { ...center(el), kind: "play_button" as const, label: label.slice(0, 40) || "Play" };
      }
    }
    const players = Array.from(document.querySelectorAll("video, iframe[src*='player' i], iframe[src*='embed' i], iframe[src*='video' i], [class*='player' i], [id*='player' i]"));
    for (const el of players) {
      const r = el.getBoundingClientRect();
      if (visible(el) && r.width >= 200 && r.height >= 120) return { ...center(el), kind: "video_player" as const, label: el.tagName.toLowerCase() === "video" ? "video" : "video player" };
    }
    return null;
  });
  if (found) return found;
  const vp = page.viewport() ?? { width: 1366, height: 900 };
  return { x: Math.round(vp.width / 2), y: Math.round(vp.height / 2), kind: "page_center" };
}

/** Records where a newly opened window was headed, stops it from loading, and closes it. */
async function capturePopup(target: Target, popups: ClickPopup[], click: number): Promise<void> {
  if (target.type() !== "page") return;
  const page = await target.page().catch(() => null);
  if (!page) return;
  let recorded = false;
  const record = (url: string) => {
    if (recorded || !/^https?:/i.test(url)) return;
    recorded = true;
    popups.push({ url: url.slice(0, 300), host: new URL(url).hostname, afterClick: click });
  };
  try {
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()) record(req.url());
      void req.abort("blockedbyclient").catch(() => {});
    });
    // The URL may already be set if the window opened before interception was ready.
    record(target.url());
    await new Promise((r) => setTimeout(r, 1_500));
    record(target.url());
  } finally {
    await page.close().catch(() => {});
  }
}

export async function runClickTest(site: URL, innerUrl?: string): Promise<ClickTest> {
  const started = Date.now();
  const browser = await getBrowser();
  const context = await browser.createBrowserContext();
  const siteDomain = registrableDomain(site.hostname);
  const hosts = new Set<string>();
  const popups: ClickPopup[] = [];
  let click = 0;
  const pending: Promise<void>[] = [];
  context.on("targetcreated", (t) => {
    if (t.type() === "page" && t.opener()) pending.push(capturePopup(t, popups, click));
  });
  try {
    const page = await context.newPage();
    await blockDownloads(page);
    await preparePage(page, (h) => {
      if (registrableDomain(h) !== siteDomain) hosts.add(h);
    });

    // A content page (e.g. a movie page) is where Play buttons live; use it when it has a player.
    let target: Target_ | undefined;
    for (const url of [innerUrl, site.toString()].filter((u): u is string => Boolean(u))) {
      await loadPage(page, url, NAV_TIMEOUT_MS);
      await new Promise((r) => setTimeout(r, 2_000));
      target = await findTarget(page).catch(() => undefined);
      if (target && target.kind !== "page_center") break;
    }
    if (!target) target = await findTarget(page);
    const pageUrl = page.url();
    const hostsBefore = new Set(hosts);
    const key = (c: { name: string; domain: string }) => `${c.name}@${c.domain}`;
    const cookiesBefore = new Set((await context.cookies()).map(key));

    for (click = 1; click <= CLICKS; click++) {
      // A real mouse click: browsers only let pages open pop-ups in response to one.
      await page.bringToFront().catch(() => {});
      await page.mouse.click(target.x, target.y).catch(() => {});
      await new Promise((r) => setTimeout(r, WAIT_AFTER_CLICK_MS));
      if (registrableDomain(new URL(page.url()).hostname) !== siteDomain) break;
      // Re-find the target in case the page changed after the first click.
      if (click < CLICKS) target = (await findTarget(page).catch(() => undefined)) ?? target;
    }
    await Promise.allSettled(pending);
    await scrollThrough(page);

    const finalHost = new URL(page.url()).hostname;
    const redirectedTo = registrableDomain(finalHost) !== siteDomain ? page.url().slice(0, 300) : undefined;
    const after = await context.cookies();
    const newTrackingCookies = after
      .filter((c) => !cookiesBefore.has(key(c)))
      .map((c) => classifyCookie({ name: c.name, value: c.value, domain: c.domain, expires: c.expires, session: c.session }, site.hostname))
      .filter(isTracking);
    const newHosts = [...hosts].filter((h) => !hostsBefore.has(h)).sort();
    return {
      ok: true,
      pageUrl,
      target: { kind: target.kind, label: target.label },
      clicks: Math.min(click, CLICKS),
      popups,
      redirectedTo,
      newHosts,
      newTrackingCookies,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.split("\n")[0].slice(0, 200) : String(err), clicks: 0, popups, newHosts: [], newTrackingCookies: [], durationMs: Date.now() - started };
  } finally {
    await context.close().catch(() => {});
  }
}
