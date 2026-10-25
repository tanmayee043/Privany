// Runs only the click test (does clicking Play set off pop-ups?) and prints the result.
// Usage: npm run click -w server -- example.com [inner-page-url]
import { closeBrowser } from "../audit/browser.js";
import { runClickTest } from "../audit/clicktest.js";
import { assertPublicUrl, normalizeUrl } from "../safety/url.js";

const url = normalizeUrl(process.argv[2] ?? "");
await assertPublicUrl(url);
const r = await runClickTest(url, process.argv[3]);
console.log(JSON.stringify({ ...r, newTrackingCookies: r.newTrackingCookies.map((c) => `${c.platform ?? c.domain} ${c.name}`) }, null, 2));
await closeBrowser();
