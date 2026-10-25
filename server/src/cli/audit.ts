// Runs only the browser audit for one site and prints a summary.
// Usage: npm run audit -w server -- example.com
import { runBrowserAudit } from "../audit/run.js";
import { closeBrowser } from "../audit/browser.js";
import { assertPublicUrl, normalizeUrl } from "../safety/url.js";

const url = normalizeUrl(process.argv[2] ?? "");
await assertPublicUrl(url);
const audit = await runBrowserAudit(url, { onProgress: (d) => console.error(`… ${d}`) });
for (const run of audit.runs) {
  console.log(`\n[${run.config}] ok=${run.ok} partial=${run.partial} ${run.durationMs}ms ${run.error ?? ""}`);
  for (const c of run.cookies.filter((c) => c.consentValue)) console.log(`  ${c.thirdParty ? "3P" : "1P"} ${c.category.padEnd(11)} ${c.name} @ ${c.domain}${c.platform ? ` (${c.platform})` : ""}${c.consentValue ? ` = ${c.consentValue}` : ""}`);
}
console.log("\nbanner", audit.consentBanner, "\ngpc.json", audit.gpcJson, "\nlinks", audit.homepageLinks, "\nbrowser", audit.browserVersion);
await closeBrowser();
