// Fetches one policy page and prints the extracted blocks.
// Usage: npm run policy -w server -- https://example.com/privacy
import { closeBrowser } from "../audit/browser.js";
import { fetchPolicy } from "../policy/extract.js";
import { assertPublicUrl, normalizeUrl } from "../safety/url.js";

const url = normalizeUrl(process.argv[2] ?? "");
await assertPublicUrl(url);
const p = await fetchPolicy(url);
console.log(`${p.title} — ${p.blocks.length} blocks, ${p.chars} chars, truncated=${p.truncated}, final=${p.url}`);
for (const b of p.blocks.slice(0, Number(process.argv[3] ?? 40))) console.log(`${b.id} ${b.kind === "heading" ? "##" : "  "} ${b.text.slice(0, 140)}`);
await closeBrowser();
