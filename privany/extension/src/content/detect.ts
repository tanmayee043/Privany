/**
 * Reads the page to find: policy/terms links, cookie banners, and the moments
 * where you're about to hand something over (signup, checkout, upload).
 * Only structure is read here. Nothing you type is ever read.
 */
import type { Context, PageInfo } from "../lib/types";

// PrivAudit banner_detection/config.json selectors, plus a text check
const BANNER_SELECTORS = [
  "div[id*='cookie']", "div[class*='cmp']", "div[class*='cookie']", "div[id*='consent']",
  "div[class*='consent']", "div[class*='gdpr']", "div[id*='onetrust-banner-sdk']",
  "div[class*='truste']", "div[id*='trustarc']", "[role='dialog'][aria-label*='cookie' i]",
  "#CybotCookiebotDialog", "#didomi-host", "#usercentrics-root", ".osano-cm-window",
];
const CMP_HINTS: [string, RegExp][] = [
  ["OneTrust", /onetrust|optanon/], ["TrustArc", /trustarc|truste/], ["Cookiebot", /cookiebot|cybot/],
  ["Didomi", /didomi/], ["Quantcast", /quantcast/], ["Sourcepoint", /sourcepoint|sp_message/],
  ["Usercentrics", /usercentrics/], ["Osano", /osano/], ["Termly", /termly/],
];

export const REJECT_RE = /\b(reject|decline|refuse|deny|disagree|opt[- ]?out)\b|necessary only|only (strictly )?necessary|essential only|only essential|continue without (accepting|agreeing)|do not (sell|share)/i;
export const ACCEPT_RE = /\b(accept|agree|allow|consent|got it|i understand|okay|ok)\b/i;

function visible(el: Element): boolean {
  const st = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return st.display !== "none" && st.visibility !== "hidden" && st.opacity !== "0" && r.width > 100 && r.height > 10;
}

export function findBanner(): { el: Element | null; cmp: string | null } {
  for (const sel of BANNER_SELECTORS) {
    let nodes: NodeListOf<Element>;
    try { nodes = document.querySelectorAll(sel); } catch { continue; }
    for (const el of nodes) {
      if (el.closest("[data-privany]")) continue;
      const t = (el as HTMLElement).innerText?.toLowerCase() ?? "";
      if (visible(el) && /cookie|privacy|consent|tracking/.test(t) && t.length < 4000) {
        const html = el.outerHTML.slice(0, 3000).toLowerCase() + " " +
          [...document.scripts].map((s) => s.src).join(" ").toLowerCase();
        const cmp = CMP_HINTS.find(([, re]) => re.test(html))?.[0] ?? null;
        return { el, cmp };
      }
    }
  }
  return { el: null, cmp: null };
}

// ---------------------------------------------------------------- links
const PRIVACY = /privacy|datenschutz|confidentialit|privacidad/i;
const TERMS = /terms|conditions|user agreement|\btos\b|nutzungsbedingungen|legal notice/i;
const COOKIE = /cookie (policy|notice)/i;

function classifyLink(text: string, href: string): "privacy" | "terms" | "cookies" | null {
  const blob = `${text} ${href}`;
  if (COOKIE.test(blob)) return "cookies";
  if (PRIVACY.test(blob) && !/privacy (choices|settings|center|preferences)/i.test(text)) return "privacy";
  if (TERMS.test(blob)) return "terms";
  return null;
}

export function findPolicyLinks(): PageInfo["links"] {
  const out: PageInfo["links"] = { privacy: [], terms: [], cookies: [] };
  const add = (k: keyof typeof out, href: string) => {
    try {
      const u = new URL(href, location.href);
      if (!/^https?:$/.test(u.protocol)) return;
      u.hash = "";
      if (!out[k].includes(u.href)) out[k].push(u.href);
    } catch { /* bad URL */ }
  };
  document.querySelectorAll<HTMLLinkElement>('link[rel~="privacy-policy"]').forEach((l) => add("privacy", l.href));
  document.querySelectorAll<HTMLLinkElement>('link[rel~="terms-of-service"]').forEach((l) => add("terms", l.href));
  // you're on the policy page itself
  const here = classifyLink(document.title, location.pathname);
  if (here) add(here, location.href);
  // footer links first: that's where policies live
  const anchors = [...document.querySelectorAll<HTMLAnchorElement>("footer a[href], a[href]")];
  for (const a of anchors) {
    const k = classifyLink((a.textContent || "").trim().slice(0, 80), a.getAttribute("href") || "");
    if (k) add(k, a.href);
  }
  return { privacy: out.privacy.slice(0, 3), terms: out.terms.slice(0, 3), cookies: out.cookies.slice(0, 2) };
}

// ---------------------------------------------------------------- decision moments
export const FIELD_MATCHERS: [string, (i: HTMLInputElement) => boolean][] = [
  ["phone", (i) => i.type === "tel" || /tel|phone|mobile/i.test(i.autocomplete + i.name + i.id)],
  ["birthday", (i) => /bday|birth|dob/i.test(i.autocomplete + i.name + i.id)],
  ["address", (i) => /street-address|address-line|address|street/i.test(i.autocomplete + i.name + i.id) && !/email/i.test(i.name + i.id)],
  ["gender", (i) => /sex|gender/i.test(i.autocomplete + i.name + i.id)],
  ["email", (i) => i.type === "email" || /email/i.test(i.autocomplete + i.name + i.id)],
  ["location", (i) => /location|zip|postal/i.test(i.autocomplete + i.name + i.id)],
  ["government_id", (i) => /ssn|social.?security|passport|license/i.test(i.name + i.id)],
  ["photo", (i) => i.type === "file" && /image/.test(i.accept)],
];

export function fieldKind(i: HTMLInputElement): string | null {
  for (const [k, test] of FIELD_MATCHERS) if (test(i)) return k;
  return null;
}

export function isAgreeBox(i: HTMLInputElement): boolean {
  if (i.type !== "checkbox") return false;
  const label = (i.closest("label")?.textContent || (i.id && document.querySelector(`label[for="${CSS.escape(i.id)}"]`)?.textContent) || "").toLowerCase();
  return /agree|accept/.test(label) && /terms|privacy|conditions|policy/.test(label);
}

export function detectContexts(): { contexts: Context[]; fields: string[]; agreeBoxes: number } {
  const contexts = new Set<Context>(["any"]);
  const fields = new Set<string>();
  const inputs = [...document.querySelectorAll<HTMLInputElement>("input")].filter((i) => i.type !== "hidden");
  const hasPassword = inputs.some((i) => i.type === "password");
  const signupText = /sign ?up|register|create (an |your )?account|join/i.test(document.title + " " + (document.querySelector("h1")?.textContent || ""));
  if (hasPassword && (signupText || inputs.some((i) => i.autocomplete === "new-password"))) contexts.add("signup");
  if (inputs.some((i) => /cc-number|cc-exp|cc-csc/.test(i.autocomplete) || /card.?number|cardnumber/i.test(i.name + i.id))
      || /checkout|payment|billing/i.test(location.pathname)) contexts.add("checkout");
  if (inputs.some((i) => i.type === "file")) contexts.add("upload");
  for (const i of inputs) {
    const k = fieldKind(i);
    if (k) fields.add(k);
  }
  const agreeBoxes = inputs.filter(isAgreeBox).length;
  if (agreeBoxes && !contexts.has("checkout")) contexts.add("signup");
  return { contexts: [...contexts], fields: [...fields], agreeBoxes };
}
