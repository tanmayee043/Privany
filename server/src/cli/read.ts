// Fetches a policy and runs the free rule-based reader on it.
// Usage: npm run read -w server -- https://example.com/privacy
import { closeBrowser } from "../audit/browser.js";
import { fetchPolicy } from "../policy/extract.js";
import { readPolicyWithRules } from "../policy/rules.js";
import { assertPublicUrl, normalizeUrl } from "../safety/url.js";

const url = normalizeUrl(process.argv[2] ?? "");
await assertPublicUrl(url);
const r = readPolicyWithRules(await fetchPolicy(url), { pasted: false });
console.log(`privacy policy: ${r.isPrivacyPolicy}; quotes ${r.evidence.verified}/${r.evidence.proposed}`);
for (const c of r.claims) console.log(`\n[${c.value}] ${c.key}: ${c.summary}\n${c.quotes.map((q) => `   > ${q.text}`).join("\n")}`);
for (const t of r.topics) console.log(`\n(${t.status}) ${t.key}\n${t.quotes.map((q) => `   > ${q.text.slice(0, 160)}`).join("\n")}`);
for (const o of r.optOuts) console.log(`\nOPT-OUT ${o.kind}: ${o.label}\n   > ${o.quotes[0]?.text.slice(0, 160)}`);
await closeBrowser();
