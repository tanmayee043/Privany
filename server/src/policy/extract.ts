import { createHash } from "node:crypto";
import type { PolicyBlock } from "../report/types.js";
import { getBrowser, preparePage } from "../audit/browser.js";

// Long policies fit in Claude's context, but past this size we stop and say the
// analysis covered only part of the document instead of silently truncating.
export const MAX_POLICY_CHARS = 200_000;

export interface ExtractedPolicy {
  url?: string;
  title?: string;
  blocks: PolicyBlock[];
  chars: number;
  truncated: boolean;
  sha256: string;
  retrievedAt: string;
}

export class PolicyFetchError extends Error {}

/** Loads the policy in a real browser (many are rendered by JavaScript) and splits it into blocks. */
export async function fetchPolicy(url: URL): Promise<ExtractedPolicy> {
  const browser = await getBrowser();
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    await preparePage(page);
    const res = await page.goto(url.toString(), { waitUntil: "networkidle2", timeout: 45_000 }).catch(async (err) => {
      if (err instanceof Error && err.name === "TimeoutError") return null;
      throw new PolicyFetchError(`The policy page couldn't be loaded (${err instanceof Error ? err.message.split("\n")[0] : err}).`);
    });
    if (res && res.status() >= 400) throw new PolicyFetchError(`The policy page returned HTTP ${res.status()}.`);
    const type = res?.headers()["content-type"] ?? "";
    if (type.includes("pdf")) throw new PolicyFetchError("This policy is a PDF, which isn't supported yet. Paste its text instead.");
    const { title, raw } = await page.evaluate(collectBlocksInPage);
    return finish(raw, { url: page.url(), title });
  } finally {
    await context.close().catch(() => {});
  }
}

/** Splits pasted policy text into blocks: lines that look like headings, and paragraphs. */
export function policyFromText(text: string): ExtractedPolicy {
  const raw: { kind: "heading" | "text"; text: string }[] = [];
  for (const para of text.replace(/\r\n?/g, "\n").split(/\n\s*\n|\n(?=\s*(?:[-•*]|\d+[.)])\s)/)) {
    const t = para.replace(/\s+/g, " ").trim();
    if (!t) continue;
    const heading = t.length < 90 && !/[.:;,]$/.test(t) && /^[A-Z0-9]/.test(t) && t.split(" ").length <= 12;
    raw.push({ kind: heading ? "heading" : "text", text: t });
  }
  return finish(raw, {});
}

export type RawBlock = { kind: "heading" | "text"; text: string };

/** Builds a policy from blocks the extension read off the open tab; undefined when there's too little text. */
export function tryPolicyFromBlocks(raw: RawBlock[], meta: { url?: string; title?: string }): ExtractedPolicy | undefined {
  try {
    return finish(raw, meta);
  } catch (err) {
    if (err instanceof PolicyFetchError) return undefined;
    throw err;
  }
}

/** A quick check that a page is a privacy policy and not, say, a homepage. */
export function looksLikePolicy(p: ExtractedPolicy): boolean {
  const text = p.blocks.map((b) => b.text).join(" ");
  const hits = text.match(/personal (?:information|data)|privacy|cookies?|third[- ]part(?:y|ies)|opt[- ]?out|retain|disclos/gi)?.length ?? 0;
  return p.chars >= 2000 && hits >= 15;
}

function finish(raw: RawBlock[], meta: { url?: string; title?: string }): ExtractedPolicy {
  const blocks: PolicyBlock[] = [];
  let section: string | undefined;
  let chars = 0;
  let truncated = false;
  const seen = new Set<string>();
  for (const r of raw) {
    // Braille blanks and no-break spaces are used as invisible bullets on some sites.
    const text = r.text.replace(/[⠀ ]+/g, " ").replace(/\s+/g, " ").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    if (chars + text.length > MAX_POLICY_CHARS) {
      truncated = true;
      break;
    }
    chars += text.length;
    if (r.kind === "heading") section = text.slice(0, 160);
    blocks.push({ id: `b${blocks.length + 1}`, kind: r.kind, text, section: r.kind === "text" ? section : undefined });
  }
  if (chars < 400) throw new PolicyFetchError("Very little text was found at that address, so it's probably not the policy itself. Try the direct policy link or paste the text.");
  const sha256 = createHash("sha256").update(blocks.map((b) => b.text).join("\n")).digest("hex");
  return { ...meta, blocks, chars, truncated, sha256, retrievedAt: new Date().toISOString() };
}

// Runs inside the page. Picks the main content area, then takes headings and
// the smallest text-bearing elements in document order so nothing is counted twice.
function collectBlocksInPage(): { title: string; raw: { kind: "heading" | "text"; text: string }[] } {
  const BLOCK = "h1,h2,h3,h4,h5,h6,p,li,td,th,dt,dd,blockquote,pre,div,section,article";
  const HEADING = /^H[1-6]$/;
  const textLen = (el: Element | null) => (el ? ((el as HTMLElement).innerText || "").length : 0);
  const candidates = [document.querySelector("main"), document.querySelector("article"), document.querySelector("[role=main]"), document.querySelector("#content, .content")];
  let root: Element = document.body;
  for (const c of candidates) if (c && textLen(c) > 2000) { root = c; break; }
  const skip = (el: Element) => !!el.closest("nav, header, footer, aside, script, style, noscript, [aria-hidden=true]") && root === document.body;
  const out: { kind: "heading" | "text"; text: string }[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let node = walker.currentNode as Element | null; node; node = walker.nextNode() as Element | null) {
    const el = node as HTMLElement;
    if (!el.matches?.(BLOCK) || skip(el)) continue;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    if (HEADING.test(el.tagName)) {
      const t = el.innerText.trim();
      if (t) out.push({ kind: "heading", text: t });
      continue;
    }
    if (el.parentElement?.closest("h1,h2,h3,h4,h5,h6")) continue;
    // Containers with child blocks contribute only their own loose text; the
    // children are collected separately so nothing is counted twice.
    let t: string;
    if (el.querySelector(BLOCK)) {
      t = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? "").join(" ").trim();
      if (t.length < 40) continue;
    } else {
      t = el.innerText.trim();
    }
    if (t.length >= 2) out.push({ kind: "text", text: t });
  }
  return { title: document.title, raw: out };
}
