// End-to-end check of the extension against a running Privany server:
// loads dist/ into Chrome, opens a site, clicks the Privany icon, waits for the
// report, and saves a screenshot of the side panel.
// Usage: npm run build -w extension && node extension/scripts/e2e.mjs https://duckduckgo.com/privacy [out.png]
import puppeteer from "puppeteer";
import { fileURLToPath } from "node:url";

const target = process.argv[2] ?? "https://duckduckgo.com/privacy";
const shot = process.argv[3] ?? "panel.png";
const dist = fileURLToPath(new URL("../dist", import.meta.url));

// Headless Chrome crashes when Puppeteer installs extensions over a pipe, so load it with launch flags.
const browser = await puppeteer.launch({
  headless: true,
  pipe: true,
  enableExtensions: true,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--enable-unsafe-extension-debugging"],
});
await new Promise((r) => setTimeout(r, 1500));
try {
  const ext = [...(await browser.extensions()).values()].find((e) => e.name === "Privany");
  if (!ext) throw new Error("Privany extension didn't load");
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(target, { waitUntil: "networkidle2", timeout: 60_000 }).catch(() => {});
  await ext.triggerAction(page);

  const [worker] = await ext.workers();
  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url && t.url.startsWith(url.split("#")[0].slice(0, 30)))?.id, page.url());
  console.log(`extension ${ext.id}, tab ${tabId}`);

  const started = Date.now();
  let state;
  for (;;) {
    state = await worker.evaluate(async (id) => (await chrome.storage.session.get(`tab:${id}`))[`tab:${id}`], tabId);
    if (process.env.E2E_DEBUG) console.log(Math.round((Date.now() - started) / 1000), JSON.stringify(state));
    if (state?.phase === "error") break;
    if (state?.phase === "running") {
      const job = await (await fetch(`http://127.0.0.1:8787/api/jobs/${state.jobId}`)).json();
      if (process.env.E2E_DEBUG) console.log("   job", job.state ?? job.error, (job.steps ?? []).map((s) => s.state[0]).join(""));
      if (job.state === "done" || job.state === "failed") {
        console.log(job.steps.map((s) => `${s.state.padEnd(7)} ${s.label}${s.detail ? ` (${s.detail})` : ""}`).join("\n"));
        break;
      }
    }
    if (Date.now() - started > 360_000) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`state: ${JSON.stringify(state)} after ${Math.round((Date.now() - started) / 1000)}s`);

  const panel = await browser.newPage();
  await panel.setViewport({ width: 420, height: 900 });
  await panel.goto(`chrome-extension://${ext.id}/sidepanel.html?tab=${tabId}`);
  await panel.waitForFunction(() => !document.body.innerText.includes("About a minute"), { timeout: 30_000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  await panel.screenshot({ path: shot, fullPage: true });
  console.log(`panel text:\n${(await panel.evaluate(() => document.body.innerText)).slice(0, 1500)}`);
} finally {
  await browser.close();
}
