// Runs inside the user's tab (injected with chrome.scripting.executeScript), so
// it must be self-contained: no imports, no references to outer variables.
// It reads the visible text of the page as headings and paragraphs, and the
// links that look like a privacy policy, and nothing else: no cookies, form
// values or page storage.
export function capturePage(): {
  url: string;
  title: string;
  blocks: { kind: "heading" | "text"; text: string }[];
  policyLinks: string[];
} {
  const BLOCK = "h1,h2,h3,h4,h5,h6,p,li,td,th,dt,dd,blockquote,pre,div,section,article";
  const textLen = (el: Element | null) => (el ? ((el as HTMLElement).innerText || "").length : 0);
  const candidates = [document.querySelector("main"), document.querySelector("article"), document.querySelector("[role=main]"), document.querySelector("#content, .content")];
  let root: Element = document.body;
  for (const c of candidates) {
    if (c && textLen(c) > 2000) {
      root = c;
      break;
    }
  }
  const skipChrome = root === document.body;
  const blocks: { kind: "heading" | "text"; text: string }[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let node = walker.currentNode as Element | null; node; node = walker.nextNode() as Element | null) {
    const el = node as HTMLElement;
    if (!el.matches || !el.matches(BLOCK)) continue;
    if (skipChrome && el.closest("nav, header, footer, aside, script, style, noscript, [aria-hidden=true]")) continue;
    if (el.closest("input, textarea, select, [contenteditable=true]")) continue;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    if (/^H[1-6]$/.test(el.tagName)) {
      const t = el.innerText.trim();
      if (t) blocks.push({ kind: "heading", text: t });
      continue;
    }
    if (el.parentElement && el.parentElement.closest("h1,h2,h3,h4,h5,h6")) continue;
    let t: string;
    if (el.querySelector(BLOCK)) {
      t = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent || "")
        .join(" ")
        .trim();
      if (t.length < 40) continue;
    } else {
      t = el.innerText.trim();
    }
    if (t.length >= 2) blocks.push({ kind: "text", text: t.slice(0, 20000) });
    if (blocks.length >= 6000) break;
  }

  const scored: { href: string; score: number }[] = [];
  for (const a of Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[]) {
    if (!/^https?:/.test(a.href)) continue;
    const t = (a.innerText || a.getAttribute("aria-label") || "").toLowerCase();
    const h = a.href.toLowerCase();
    let score = 0;
    if (/privacy (policy|notice|statement)/.test(t)) score += 10;
    else if (/privacy/.test(t)) score += 5;
    if (/privacy[-_]?(policy|notice|statement)/.test(h)) score += 4;
    else if (/privacy/.test(h)) score += 2;
    if (/choices|settings|do not sell|opt[- ]out/.test(t)) score -= 6;
    if (score > 0) scored.push({ href: a.href.split("#")[0], score });
  }
  scored.sort((x, y) => y.score - x.score);
  const policyLinks = Array.from(new Set(scored.map((s) => s.href))).slice(0, 5);

  return { url: location.href, title: document.title, blocks, policyLinks };
}
