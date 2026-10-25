// End-to-end check of automatic mode against a running Privany server: loads
// dist/ into Chrome, opens each site WITHOUT clicking the icon, then reports
// the badge, the risk reasons, and whether the danger panel appeared.
// Usage: npm run build -w extension && node extension/scripts/auto-e2e.mjs https://www.papajohns.com/ [more urls]
import puppeteer from "puppeteer";
import { fileURLToPath } from "node:url";

const urls = process.argv.slice(2);
const dist = fileURLToPath(new URL("../dist", import.meta.url));
const shotDir = process.env.E2E_SHOTS;

const browser = await puppeteer.launch({
  headless: true,
  pipe: true,
  enableExtensions: true,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--enable-unsafe-extension-debugging"],
});
try {
  await new Promise((r) => setTimeout(r, 1500));
  const ext = [...(await browser.extensions()).values()].find((e) => e.name === "Privany");
  if (!ext) throw new Error("Privany extension didn't load");
  for (const url of urls) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    // Some sites block browsers that announce themselves as headless; real users don't.
    await page.setUserAgent({ userAgent: (await browser.userAgent()).replace("HeadlessChrome", "Chrome") });
    const started = Date.now();
    await page.goto(url, { waitUntil: "load", timeout: 60_000 }).catch(() => {});
    const [worker] = await ext.workers();
    const tabId = await worker.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url && t.url.startsWith(u.slice(0, 25)))?.id, page.url());
    // Wait for the second pass (about 12 s after load), which counts slower ad scripts.
    let risk;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      risk = await worker.evaluate(async (id) => (await chrome.storage.session.get(`risk:${id}`))[`risk:${id}`], tabId);
      if (risk && Date.now() - started > 16_000) break;
    }
    await new Promise((r) => setTimeout(r, 1500));
    const badge = await worker.evaluate(async (id) => chrome.action.getBadgeText({ tabId: id }), tabId);
    const panel = await page.evaluate(() => [...document.querySelectorAll("[data-privany]")].some((h) => h.previousElementSibling?.tagName !== "INPUT"));
    const fieldNotes = await page.evaluate(() =>
      [...document.querySelectorAll("[data-privany]")].filter((h) => h.previousElementSibling?.tagName === "INPUT").map((h) => {
        const i = h.previousElementSibling;
        return i.type === "email" || /mail/i.test(i.name + i.id) ? "email" : i.type === "tel" ? "phone" : i.name || i.id || i.type;
      }),
    );
    console.log(`\n${url}  (${Math.round((Date.now() - started) / 1000)}s)`);
    if (!risk) {
      console.log("  no result (server down, or the page never settled)");
    } else {
      console.log(`  level: ${risk.assessment.level}  badge: "${badge}"  danger panel shown: ${panel}`);
      console.log(`  seen: ${JSON.stringify(risk.observed)}  notes under fields: ${fieldNotes.length ? fieldNotes.join(", ") : "none"}`);
      console.log(`  policy: ${risk.quick?.policy?.url ?? risk.quick?.policyError}  past audit: ${risk.quick?.priorAudit ? `${risk.quick.priorAudit.gaps.length} gap(s)` : "none"}`);
      for (const r of risk.assessment.reasons) console.log(`  - [${r.severity}] ${r.title}\n      ${r.detail}`);
    }
    if (shotDir) await page.screenshot({ path: `${shotDir}/${new URL(url).hostname}.png` });
    await page.close();
  }
} finally {
  await browser.close();
}
