import type { PolicyBlock, Quote } from "../report/types.js";

/** Folds the differences a model introduces when copying text: case, curly quotes, dashes, spacing. */
export function normalizeForMatch(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[​-‍﻿­]/g, "")
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/…/g, "...")
    .replace(/[●•▪◦]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const MIN_QUOTE_CHARS = 12;

export interface ProposedQuote {
  block_id: string;
  text: string;
}

/**
 * Keeps only quotes that appear word for word in the policy. A quote attributed
 * to the wrong block is kept and re-pointed at the block that contains it.
 * Returned text is the policy's own wording, not the model's copy.
 */
export function verifyQuotes(proposed: ProposedQuote[], blocks: PolicyBlock[], index: Map<string, PolicyBlock>): { quotes: Quote[]; rejected: number } {
  const quotes: Quote[] = [];
  let rejected = 0;
  for (const p of proposed) {
    const needle = normalizeForMatch(p.text.replace(/^["'“”]+|["'“”]+$/g, "").replace(/\s*(\.\.\.|…)\s*$/, ""));
    if (needle.length < MIN_QUOTE_CHARS) {
      rejected++;
      continue;
    }
    const claimed = index.get(p.block_id);
    const block = claimed && normalizeForMatch(claimed.text).includes(needle) ? claimed : blocks.find((b) => normalizeForMatch(b.text).includes(needle));
    if (!block) {
      rejected++;
      continue;
    }
    if (quotes.some((q) => q.blockId === block.id && normalizeForMatch(q.text) === needle)) continue;
    quotes.push({ blockId: block.id, text: originalSpan(block.text, needle) ?? p.text, section: block.section });
  }
  return { quotes, rejected };
}

/** Finds the span of the original block text whose normalized form equals the needle. */
function originalSpan(text: string, needle: string): string | undefined {
  const words = text.split(/\s+/);
  const first = needle.split(" ")[0];
  for (let i = 0; i < words.length; i++) {
    if (!normalizeForMatch(words[i]).startsWith(first.slice(0, Math.min(first.length, 4)))) continue;
    let acc = "";
    for (let j = i; j < words.length; j++) {
      acc = acc ? `${acc} ${words[j]}` : words[j];
      const n = normalizeForMatch(acc);
      if (n.length >= needle.length) {
        if (n.startsWith(needle)) return acc;
        break;
      }
    }
  }
  return undefined;
}

// Phrases that only make sense as instructions to an AI. Policy text is treated
// as data either way; these are surfaced so a reader knows the page tried.
const INJECTION_PATTERNS = [
  /ignore (all |any )?(previous|prior|above) (instructions|prompts)/i,
  /disregard (the |all )?(previous|prior|above|system)/i,
  /you are (now )?(an? )?(ai|assistant|language model|chatgpt|claude)/i,
  /(system|developer) prompt/i,
  /\b(as an ai|ai (model|assistant)s?,? (must|should))\b/i,
  /respond (only )?with ["']?(safe|compliant|no issues)/i,
];

export function findInjectionAttempts(blocks: PolicyBlock[]): string[] {
  const hits: string[] = [];
  for (const b of blocks) {
    if (INJECTION_PATTERNS.some((re) => re.test(b.text))) hits.push(b.text.slice(0, 240));
    if (hits.length >= 5) break;
  }
  return hits;
}
