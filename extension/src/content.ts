/// <reference types="chrome" />
// Runs on every page (Manifest V3 content script, so no imports: it's loaded
// as a classic script). It reads only the page's structure: links that look
// like a privacy policy or terms, and whether a cookie banner is on screen.
// Nothing you type is read. When the background decides the site is risky, it
// draws a small panel on the page, inside a shadow root so the site's styles
// can't affect it (and it can't affect the site).

type Reason = { id: string; severity: "high" | "medium"; title: string; detail: string; quote?: { text: string }; basis: string };

const BANNER_SELECTORS = [
  "#onetrust-banner-sdk", "#onetrust-consent-sdk", "#CybotCookiebotDialog", "#didomi-host", "#usercentrics-root", "#qc-cmp2-ui",
  ".qc-cmp2-container", "#truste-consent-track", ".truste_box_overlay", "[id^='sp_message_container']", ".osano-cm-window",
  "div[id*='cookie' i]", "div[class*='cookie' i]", "div[id*='consent' i]", "div[class*='consent' i]", "[role='dialog'][aria-label*='cookie' i]",
];

function findBanner(): Element | null {
  for (const sel of BANNER_SELECTORS) {
    let nodes: NodeListOf<Element>;
    try {
      nodes = document.querySelectorAll(sel);
    } catch {
      continue;
    }
    for (const el of Array.from(nodes)) {
      if (el.closest("[data-privany]")) continue;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      const text = ((el as HTMLElement).innerText || "").toLowerCase();
      if (r.width > 100 && r.height > 30 && s.display !== "none" && s.visibility !== "hidden" && /accept|agree|reject|decline|consent|cookie/.test(text) && text.length < 5000) return el;
    }
  }
  return null;
}

function policyLinks(): string[] {
  const scored: { href: string; score: number }[] = [];
  for (const a of Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[]) {
    if (!/^https?:/.test(a.href)) continue;
    const t = (a.innerText || a.getAttribute("aria-label") || "").toLowerCase();
    const h = a.href.toLowerCase();
    let score = 0;
    if (/^(?:our |the )?privacy (?:policy|notice|statement)$/.test(t.trim())) score += 16;
    else if (/privacy (policy|notice|statement)/.test(t)) score += 10;
    else if (/privacy/.test(t)) score += 5;
    if (/\/(?:our-)?privacy(?:-policy|-notice|-statement)?\/?(?:[?#]|$)|\/legal\/privacy/.test(h)) score += 8;
    else if (/privacy[-_]?(policy|notice|statement)/.test(h)) score += 4;
    else if (/privacy/.test(h)) score += 2;
    // Product, template and article pages about privacy aren't the site's own policy
    // (same rules as server/src/policy/links.ts).
    if (/generator|template|builder|\bsamples?\b|\bexamples?\b|\/products?\/|\/solutions?\/|\/resources?\/|\/blog\/|\/learn\/|\/guides?\/|laws?-tracker|data-privacy-laws|privacy-center|trust-center|verification|commitment/.test(`${t} ${h}`)) score -= 14;
    if (a.closest("footer") || /\bagree\b/.test((a.parentElement?.textContent || "").toLowerCase())) score += 3;
    if (/choices|settings|do not sell|opt[- ]out/.test(t)) score -= 6;
    if (score > 0) scored.push({ href: a.href.split("#")[0], score });
  }
  scored.sort((x, y) => y.score - x.score);
  return Array.from(new Set(scored.map((s) => s.href))).slice(0, 5);
}

function report() {
  if (window.top !== window) return;
  void chrome.runtime.sendMessage({ type: "privany:page", url: location.href, policyLinks: policyLinks(), bannerVisible: Boolean(findBanner()) }).catch(() => {});
}

// Once the page has settled, and again a little later so slower ad scripts are counted.
const start = () => {
  setTimeout(report, 3_000);
  setTimeout(report, 12_000);
};
if (document.readyState === "complete") start();
else window.addEventListener("load", start, { once: true });

const BASIS: Record<string, string> = {
  policy: "From the policy",
  page: "Seen on this page",
  policy_and_page: "Policy vs. this page",
  research: "PrivAudit research",
};

const PANEL_CSS = `
:host { all: initial; }
.box { position: fixed; right: 16px; z-index: 2147483647; width: min(360px, calc(100vw - 32px)); max-height: 70vh; overflow: auto;
  background: #fff; color: #111; border: 2px solid #111; box-shadow: 0 12px 32px rgba(17,17,17,.28);
  font: 14px/1.45 "Archivo", system-ui, -apple-system, "Segoe UI", sans-serif; animation: in 200ms cubic-bezier(.16,1,.3,1) both; }
.top { top: 16px; } .bottom { bottom: 16px; }
@keyframes in { from { opacity: 0; transform: translateY(-8px); } }
@media (prefers-reduced-motion: reduce) { .box { animation: none; } }
.bar { display: flex; align-items: center; gap: 8px; background: #111; color: #fff; padding: 8px 10px 8px 12px; }
.bar b { font-size: 14px; font-weight: 800; }
.bar .x { margin-left: auto; background: transparent; border: 0; color: #fff; font: inherit; font-size: 18px; line-height: 1; cursor: pointer; padding: 4px 6px; }
.body { padding: 12px 14px 14px; }
h2 { margin: 0; font-size: 20px; line-height: 1.2; font-weight: 800; letter-spacing: -.01em; }
.site { margin: 2px 0 10px; color: #3d4250; font-size: 13px; }
ul { list-style: none; margin: 0; padding: 0; border-top: 5px solid #111; }
li { border-bottom: 1px solid #d4d9e2; padding: 9px 0; display: grid; grid-template-columns: 18px 1fr; gap: 0 8px; }
.mark { margin-top: 9px; height: 0; border-top: 4px solid #b42318; }
.mark.medium { border-top: 3px dashed #b42318; }
.t { font-weight: 700; }
.d { color: #3d4250; font-size: 13px; margin-top: 2px; }
.q { margin-top: 4px; padding-left: 8px; border-left: 2px solid #1d4ed8; font-size: 13px; color: #111; }
.b { margin-top: 3px; font-size: 11px; color: #5b6170; text-transform: uppercase; letter-spacing: .06em; }
.more { margin: 8px 0 0; color: #3d4250; font-size: 12px; }
.actions { display: flex; gap: 8px; margin-top: 12px; }
button.p, button.s { font: inherit; font-weight: 700; padding: 8px 12px; cursor: pointer; border: 2px solid #111; }
button.p { background: #111; color: #fff; } button.p:hover { background: #2b2b2b; }
button.s { background: #fff; color: #111; } button.s:hover { background: #e9edf3; }
button.mute { display: block; margin-top: 10px; background: none; border: 0; padding: 0; color: #1d4ed8; font: inherit; font-size: 12px; text-decoration: underline; cursor: pointer; }
button:focus-visible { outline: 3px solid #1d4ed8; outline-offset: 2px; }
.note { margin-top: 8px; font-size: 12px; color: #3d4250; }
`;

let host: HTMLElement | null = null;

function close() {
  host?.remove();
  host = null;
  document.removeEventListener("keydown", onKey, true);
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape" && host) close();
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function showDanger(site: string, reasons: Reason[], total: number) {
  close();
  host = document.createElement("div");
  host.setAttribute("data-privany", "");
  const root = host.attachShadow({ mode: "closed" });
  const style = el("style");
  style.textContent = PANEL_CSS;
  const banner = findBanner();
  const place = banner && banner.getBoundingClientRect().top < 200 ? "bottom" : "top";
  const box = el("section", `box ${place}`);
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "false");
  box.setAttribute("aria-labelledby", "privany-title");

  const bar = el("div", "bar");
  bar.append(el("b", undefined, "Privany"));
  const x = el("button", "x", "×");
  x.setAttribute("aria-label", "Close");
  x.addEventListener("click", close);
  bar.append(x);

  const body = el("div", "body");
  const h = el("h2", undefined, "This site looks risky");
  h.id = "privany-title";
  body.append(h, el("p", "site", `${site.replace(/^www\./, "")} · ${total} finding${total === 1 ? "" : "s"}`));
  const list = el("ul");
  for (const r of reasons) {
    const li = el("li");
    li.append(el("i", `mark ${r.severity}`));
    const main = el("div");
    main.append(el("div", "t", r.title), el("div", "d", r.detail));
    if (r.quote?.text) main.append(el("div", "q", `“${r.quote.text.length > 180 ? `${r.quote.text.slice(0, 177)}…` : r.quote.text}”`));
    main.append(el("div", "b", BASIS[r.basis] ?? ""));
    li.append(main);
    list.append(li);
  }
  body.append(list);
  if (total > reasons.length) body.append(el("p", "more", `${total - reasons.length} more in the full report.`));

  const actions = el("div", "actions");
  const full = el("button", "p", "Full report");
  const note = el("p", "note");
  full.addEventListener("click", () => {
    void chrome.runtime.sendMessage({ type: "privany:open-report" }).then((ok: boolean) => {
      if (ok) close();
      else note.textContent = "Click the Privany icon in your toolbar to open the full report.";
    });
  });
  const later = el("button", "s", "Not now");
  later.addEventListener("click", close);
  actions.append(full, later);
  const mute = el("button", "mute", "Don't warn me on this site");
  mute.addEventListener("click", () => {
    void chrome.runtime.sendMessage({ type: "privany:mute", site });
    close();
  });
  body.append(actions, note, mute);
  box.append(bar, body);
  root.append(style, box);
  document.documentElement.append(host);
  document.addEventListener("keydown", onKey, true);
}

// ---- Notes under form fields -------------------------------------------------
// Sign-up and checkout forms: under fields for personal details the policy says
// it uses for marketing, ads, sharing or sale, a short note with the policy's own
// sentence. Fields are recognised from their type, autocomplete hint, name and
// visible label; what you type is never read. Matchers follow the
// features-updated branch (privany/extension/src/content/detect.ts).

type FieldUse = { field: string; purposes: string[]; note: string; quote: { text: string } };

function labelOf(i: HTMLInputElement): string {
  const byFor = i.id ? document.querySelector(`label[for="${CSS.escape(i.id)}"]`)?.textContent : "";
  const byAria = i.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
  return [i.getAttribute("aria-label"), i.placeholder, byFor, i.closest("label")?.textContent, byAria].filter(Boolean).join(" ");
}

const FIELD_MATCHERS: [string, (i: HTMLInputElement, hint: string) => boolean][] = [
  ["phone", (i, h) => i.type === "tel" || /\btel\b|phone|mobile|cell/i.test(h)],
  ["birthday", (_i, h) => /bday|birth|\bdob\b/i.test(h)],
  ["payment", (_i, h) => /cc-(number|name|exp|csc)|card ?number|credit card|cvv|cvc/i.test(h)],
  ["email", (i, h) => i.type === "email" || /e-?mail/i.test(h)],
  ["address", (_i, h) => /street-address|address-line|address|street/i.test(h) && !/e-?mail/i.test(h)],
  ["gender", (_i, h) => /\bsex\b|gender/i.test(h)],
  ["location", (_i, h) => /postal-code|\bzip\b|postcode|location/i.test(h)],
  ["government_id", (_i, h) => /\bssn\b|social.?security|passport|driver.?s? ?licen/i.test(h)],
  ["photo", (i, h) => i.type === "file" && (/image/.test(i.accept) || /photo|picture|avatar/i.test(h))],
];

const SKIP_TYPES = new Set(["hidden", "password", "checkbox", "radio", "submit", "button", "reset", "search", "range", "color", "image"]);

function fieldKind(i: HTMLInputElement): string | null {
  if (SKIP_TYPES.has(i.type)) return null;
  const hint = `${i.autocomplete} ${i.name} ${i.id} ${labelOf(i)}`;
  for (const [kind, test] of FIELD_MATCHERS) if (test(i, hint)) return kind;
  return null;
}

const NOTE_CSS = `
:host { all: initial; display: block; }
.n { margin: 6px 0 10px; padding: 7px 10px; background: #fef0c7; color: #3d2a00; border-radius: 4px;
  font: 13px/1.4 "Archivo", system-ui, -apple-system, "Segoe UI", sans-serif; }
.n b { font-weight: 800; }
button { margin-left: 4px; background: none; border: 0; padding: 0; font: inherit; color: #1d4ed8; text-decoration: underline; cursor: pointer; }
button:focus-visible { outline: 2px solid #1d4ed8; outline-offset: 2px; }
blockquote { margin: 6px 0 0; padding-left: 8px; border-left: 2px solid #1d4ed8; color: #111; }
`;

let fieldUses = new Map<string, FieldUse>();
const decorated = new WeakSet<Element>();

function noteFor(use: FieldUse): HTMLElement {
  const hostEl = document.createElement("div");
  hostEl.setAttribute("data-privany", "");
  const root = hostEl.attachShadow({ mode: "closed" });
  const style = el("style");
  style.textContent = NOTE_CSS;
  const box = el("div", "n");
  box.setAttribute("role", "note");
  box.append(el("b", undefined, "Privany: "), document.createTextNode(use.note));
  const quote = el("blockquote", undefined, `“${use.quote.text}”`);
  quote.hidden = true;
  const toggle = el("button", undefined, "Their words");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  toggle.addEventListener("click", () => {
    quote.hidden = !quote.hidden;
    toggle.setAttribute("aria-expanded", String(!quote.hidden));
    toggle.textContent = quote.hidden ? "Their words" : "Hide";
  });
  box.append(toggle, quote);
  root.append(style, box);
  return hostEl;
}

function decorateFields() {
  if (!fieldUses.size) return;
  for (const input of Array.from(document.querySelectorAll("input")) as HTMLInputElement[]) {
    if (decorated.has(input) || input.closest("[data-privany]")) continue;
    const r = input.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const kind = fieldKind(input);
    const use = kind ? fieldUses.get(kind) : undefined;
    if (!use) continue;
    decorated.add(input);
    input.insertAdjacentElement("afterend", noteFor(use));
  }
}

// Sign-up forms often appear later (dialogs, multi-step flows).
let decorateTimer: ReturnType<typeof setTimeout> | undefined;
const fieldObserver = new MutationObserver(() => {
  clearTimeout(decorateTimer);
  decorateTimer = setTimeout(decorateFields, 400);
});

chrome.runtime.onMessage.addListener((msg: { type?: string; site?: string; reasons?: Reason[]; total?: number; uses?: FieldUse[] }) => {
  if (msg.type === "privany:danger" && msg.site && msg.reasons) showDanger(msg.site, msg.reasons, msg.total ?? msg.reasons.length);
  if (msg.type === "privany:fields" && msg.uses?.length) {
    fieldUses = new Map(msg.uses.map((u) => [u.field, u]));
    decorateFields();
    fieldObserver.observe(document.body, { childList: true, subtree: true });
  }
});
