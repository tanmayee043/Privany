import puppeteer, { type Browser, type Page } from "puppeteer";
import { isPublicHost } from "../safety/url.js";

let shared: Promise<Browser> | null = null;

export function getBrowser(): Promise<Browser> {
  if (!shared) {
    shared = puppeteer.launch({
      headless: true,
      args: ["--no-first-run", "--no-default-browser-check", "--disable-features=Translate"],
    });
    shared.then((b) => b.on("disconnected", () => (shared = null))).catch(() => (shared = null));
  }
  return shared;
}

export async function closeBrowser(): Promise<void> {
  const b = await shared?.catch(() => null);
  shared = null;
  await b?.close().catch(() => {});
}

/**
 * Prepares a page for auditing: a regular (non-headless) user agent, a desktop
 * viewport, and a guard that aborts any request to a private network address,
 * so a public page can't be used to reach machines behind this server.
 */
export async function preparePage(page: Page, onRequestHost?: (host: string) => void): Promise<void> {
  const ua = (await page.browser().userAgent()).replace("HeadlessChrome", "Chrome");
  await page.setUserAgent({ userAgent: ua });
  await page.setViewport({ width: 1366, height: 900 });
  // tsx compiles with esbuild's keepNames, which wraps functions passed to
  // page.evaluate() in a __name() helper that doesn't exist in the page.
  await page.evaluateOnNewDocument("globalThis.__name = globalThis.__name || ((f) => f);");
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (req.isInterceptResolutionHandled()) return;
    let url: URL;
    try {
      url = new URL(req.url());
    } catch {
      void req.abort().catch(() => {});
      return;
    }
    if (url.protocol === "data:" || url.protocol === "blob:") {
      void req.continue().catch(() => {});
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      void req.abort().catch(() => {});
      return;
    }
    onRequestHost?.(url.hostname);
    isPublicHost(url.hostname).then(
      (ok) => (ok ? req.continue() : req.abort("blockedbyclient")).catch(() => {}),
      () => req.abort().catch(() => {}),
    );
  });
}
