import type { ExtractedPolicy } from "./extract.js";

// Picking the right page matters more than reading it well: sites that sell
// privacy tools (Termly, OneTrust, ...) are full of "Privacy Policy Generator"
// and "Privacy Policy Template" links, and reading one of those as the site's
// own policy gives confident nonsense. The same rules are inlined in the page
// scripts that collect links (extension/src/content.ts, capture.ts and
// audit/run.ts), which can't import this module.

/** Links about privacy that aren't a site's own policy: product, template and article pages. */
export const NOT_OWN_POLICY = /generator|template|builder|\bsamples?\b|\bexamples?\b|\/products?\/|\/solutions?\/|\/resources?\/|\/blog\/|\/learn\/|\/guides?\/|laws?-tracker|data-privacy-laws|privacy-center|trust-center|verification|commitment/i;

/** Ranks a candidate policy link from its URL alone (the server often has no link text). */
export function scorePolicyHref(href: string): number {
  let path = "";
  try {
    path = new URL(href).pathname.toLowerCase();
  } catch {
    return -100;
  }
  let score = 0;
  if (/\/(?:our-)?privacy(?:-policy|-notice|-statement)?\/?$/.test(path) || /\/legal\/privacy/.test(path)) score += 8;
  else if (/privacy[-_]?(?:policy|notice|statement)/.test(path)) score += 4;
  else if (/privacy/.test(path)) score += 2;
  if (NOT_OWN_POLICY.test(path)) score -= 14;
  return score;
}

/** Orders candidates best-first, keeping the page's own order for ties. */
export function rankPolicyLinks(hrefs: string[]): string[] {
  return hrefs.map((h, i) => ({ h, i, s: scorePolicyHref(h) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.h);
}

/**
 * How strongly a page reads as the site's own privacy policy: it should talk
 * about itself ("we collect", "we share") and about the reader's data ("your
 * personal information"), and not be a page that sells or explains policies.
 */
export function ownPolicyScore(p: ExtractedPolicy): { score: number; own: boolean } {
  const text = p.blocks.map((b) => b.text).join(" ");
  const heading = [p.title ?? "", ...p.blocks.filter((b) => b.kind === "heading").slice(0, 3).map((b) => b.text)].join(" ");
  const weSay = text.match(/\bwe (?:may |also |will )?(?:collect|use|share|disclose|process|retain|store|sell|receive)\b/gi)?.length ?? 0;
  const yourData = text.match(/\byour (?:personal )?(?:information|data)\b/gi)?.length ?? 0;
  const aboutPolicies = /generator|template|create (?:a|your) (?:free )?(?:privacy )?polic|polic(?:y|ies) builder/i.test(heading);
  const titled = /privacy (?:policy|notice|statement)|data (?:protection|privacy) (?:policy|notice)/i.test(heading);
  const score = Math.min(weSay, 20) + Math.min(yourData, 20) + (titled ? 6 : 0) - (aboutPolicies ? 40 : 0);
  return { score, own: !aboutPolicies && weSay >= 3 && yourData >= 2 };
}
