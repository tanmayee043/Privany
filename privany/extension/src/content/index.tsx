import { createRoot, type Root } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import css from "virtual:content-css";
import { ext, send } from "../lib/api";
import { getSettings } from "../lib/settings";
import type { Assessment, Context, FieldHint, Flag, TabState } from "../lib/types";
import { FlagItem, Glyph, Quote, verdictGlyph } from "../ui/parts";
import { ACCEPT_RE, REJECT_RE, detectContexts, fieldKind, findBanner, findPolicyLinks, isAgreeBox } from "./detect";

if (!(window as unknown as { __privany?: boolean }).__privany && window.top === window) {
  (window as unknown as { __privany?: boolean }).__privany = true;
  main();
}

function main() {
  // ---------------------------------------------------------------- report the page
  let lastSent = "";
  function report() {
    const banner = findBanner();
    bannerEl = banner.el;
    const { contexts, fields, agreeBoxes } = detectContexts();
    if (banner.el) contexts.push("banner");
    const info = {
      url: location.href, title: document.title, links: findPolicyLinks(),
      banner: { found: !!banner.el, cmp: banner.cmp }, contexts, fields, agreeBoxes,
    };
    const sig = JSON.stringify(info);
    if (sig !== lastSent) {
      lastSent = sig;
      send({ type: "page_info", info }).catch(() => {});
    }
  }
  let bannerEl: Element | null = null;
  let state: TabState | null = null;
  report();
  // banners and SPA forms show up late; re-check a few times, then on DOM changes
  [800, 2000, 4500].forEach((ms) => setTimeout(report, ms));
  let mo: ReturnType<typeof setTimeout>;
  let checks = 0;
  new MutationObserver(() => {
    if (checks > 20) return;
    clearTimeout(mo);
    mo = setTimeout(() => { checks++; report(); }, 1200);
  }).observe(document.documentElement, { childList: true, subtree: true });
  addEventListener("popstate", report);

  // ---------------------------------------------------------------- the agree gate
  // On a risky site, stop the click that would agree to something (Accept on a
  // cookie banner, ticking "I agree", sending a form with personal info) and ask
  // first. Window + capture phase so we run before the page's own handlers.
  let gateOn = true;
  getSettings().then((st) => { gateOn = st.gate; });
  ext.storage.onChanged.addListener((ch) => {
    const next = ch.settings?.newValue as { gate?: boolean } | undefined;
    if (next && typeof next.gate === "boolean") gateOn = next.gate;
  });
  let bypassUntil = 0;
  let gate: Gate | null = null;

  function openGate(g: Omit<Gate, "id">) {
    gate = { ...g, id: Date.now() };
    render();
  }
  function closeGate(proceed: boolean) {
    const g = gate;
    gate = null;
    render();
    if (g && proceed) {
      try { sessionStorage.setItem(`privany_gate_ok_${g.kind}`, "1"); } catch { /* storage blocked */ }
      bypassUntil = Date.now() + 1000;
      g.resume();
    }
  }

  addEventListener("click", (e) => {
    if (Date.now() < bypassUntil || !e.isTrusted) return;
    const t = (e.target as Element)?.closest?.("input[type='checkbox'], button, a, [role='button'], input[type='button'], input[type='submit']");
    if (!t || t.closest("[data-privany]")) return;
    let kind: GateKind | null = null;
    if (t instanceof HTMLInputElement && t.type === "checkbox") {
      // the browser flips the box before the click event, so checked === "about to be ticked"
      if (t.checked && isAgreeBox(t)) kind = "terms";
    } else {
      const label = ((t as HTMLElement).innerText || (t as HTMLInputElement).value || t.getAttribute("aria-label") || "").trim().slice(0, 80);
      const inBanner = !!(bannerEl && bannerEl.contains(t));
      if (inBanner && ACCEPT_RE.test(label) && !REJECT_RE.test(label)) kind = "cookies";
    }
    if (!kind || !shouldGate(kind, [])) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const el = t as HTMLElement;
    openGate({ kind, fields: [], resume: () => el.click() });
  }, true);

  addEventListener("submit", (e) => {
    if (Date.now() < bypassUntil) return;
    const f = e.target as HTMLFormElement;
    if (!(f instanceof HTMLFormElement) || f.closest("[data-privany]")) return;
    // the personal fields you actually filled in
    const fields = [...new Set([...f.querySelectorAll<HTMLInputElement>("input")]
      .filter((i) => i.type !== "hidden" && i.value.trim())
      .map((i) => fieldKind(i)).filter((k): k is string => !!k && SENSITIVE.includes(k)))];
    const agrees = [...f.querySelectorAll<HTMLInputElement>("input[type=checkbox]")].some(isAgreeBox);
    if (!fields.length && !agrees) return;
    if (!shouldGate("form", fields)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const submitter = (e as SubmitEvent).submitter as HTMLElement | null;
    openGate({ kind: "form", fields, resume: () => (f.requestSubmit ? f.requestSubmit(submitter ?? undefined) : f.submit()) });
  }, true);

  function shouldGate(kind: GateKind, fields: string[]): boolean {
    if (!gateOn || !state || state.status === "paused") return false;
    try { if (sessionStorage.getItem(`privany_gate_ok_${kind}`) === "1") return false; } catch { /* storage blocked */ }
    const a = state.assessment;
    // no policy at all, and they want your personal info: that's worth a pause
    if (!a || a.verdict === "unknown") return kind === "form" && fields.length > 0 && !!state.analysis && !state.analysis.analysis;
    if (a.verdict === "red") return true;
    if (a.verdict === "green") return false;
    const ctx = GATE_CONTEXTS[kind];
    const serious = a.flags.some((fl) => fl.severity !== "low" && fl.severity !== "info" && fl.contexts.some((c) => ctx.includes(c)));
    const sharedFields = fields.some((k) => a.field_hints?.[k]?.shared_for_ads === "true");
    return serious || sharedFields;
  }

  // ---------------------------------------------------------------- consent clicks
  document.addEventListener("click", (e) => {
    const t = (e.target as Element)?.closest?.("button, a, [role='button'], input[type='button'], input[type='submit']");
    if (!t || t.closest("[data-privany]")) return;
    const label = ((t as HTMLElement).innerText || (t as HTMLInputElement).value || t.getAttribute("aria-label") || "").trim().slice(0, 80);
    if (!label) return;
    const inBanner = !!(bannerEl && bannerEl.contains(t)) || !!t.closest("[id*='cookie' i], [class*='cookie' i], [id*='consent' i], [class*='consent' i], [class*='cmp' i]");
    if (!inBanner && !/reject all|decline all|accept all|accept cookies/i.test(label)) return;
    if (REJECT_RE.test(label)) send({ type: "consent_click", choice: "rejected" }).catch(() => {});
    else if (ACCEPT_RE.test(label)) send({ type: "consent_click", choice: "accepted" }).catch(() => {});
  }, true);

  // ---------------------------------------------------------------- "I agree" moments -> receipt
  let lastAgree = 0;
  document.addEventListener("change", (e) => {
    const i = e.target as HTMLInputElement;
    if (i?.tagName === "INPUT" && i.checked && isAgreeBox(i) && Date.now() - lastAgree > 10_000) {
      lastAgree = Date.now();
      send({ type: "agreed", how: "checkbox" }).catch(() => {});
    }
  }, true);
  document.addEventListener("submit", (e) => {
    const f = e.target as HTMLFormElement;
    const agreeText = /by (signing up|creating|continuing|clicking)[^.]{0,80}(agree|accept)/i.test(f.innerText || "");
    const checked = [...f.querySelectorAll<HTMLInputElement>("input[type=checkbox]")].some((i) => i.checked && isAgreeBox(i));
    if ((agreeText || checked) && Date.now() - lastAgree > 10_000) {
      lastAgree = Date.now();
      send({ type: "agreed", how: "submit" }).catch(() => {});
    }
  }, true);

  // ---------------------------------------------------------------- UI host
  const host = document.createElement("div");
  host.setAttribute("data-privany", "");
  // pointer-events off on the host so empty space never blocks the page;
  // the panel and toasts turn them back on for themselves
  host.style.cssText = "all: initial; position: fixed; z-index: 2147483646; right: 16px; bottom: 16px; pointer-events: none;";
  const shadow = host.attachShadow({ mode: (globalThis as any).__PRIVANY_DEBUG__ ? "open" : "closed" });
  const style = document.createElement("style");
  style.textContent = css;
  shadow.appendChild(style);
  const mount = document.createElement("div");
  shadow.appendChild(mount);
  (document.body || document.documentElement).appendChild(host);
  const root = createRoot(mount);

  let receiptToast = 0;
  const render = () => {
    // never sit on top of the site's own cookie banner: you need to reach its buttons
    const bannerUp = !!(bannerEl && bannerEl.isConnected && bannerEl.getBoundingClientRect().height > 0);
    host.style.top = bannerUp ? "16px" : "auto";
    host.style.bottom = bannerUp ? "auto" : "16px";
    root.render(<Overlay state={state} receiptAt={receiptToast} gate={gate} onGate={closeGate} />);
  };
  // banner gets answered -> slide back down
  setInterval(() => { if (state) render(); }, 1500);

  ext.runtime.onMessage.addListener((msg: { type: string; state?: TabState }) => {
    if (msg.type === "state" && msg.state) {
      state = msg.state;
      render();
      decorateFields(state.assessment);
    }
    if (msg.type === "receipt_saved") {
      receiptToast = Date.now();
      render();
    }
  });
  send<TabState | null>({ type: "get_state" }).then((s) => { if (s) { state = s; render(); decorateFields(s.assessment); } }).catch(() => {});
}

// ================================================================== the panel
const DISMISS_KEY = "privany_dismissed";

type GateKind = "cookies" | "terms" | "form";
type Gate = { id: number; kind: GateKind; fields: string[]; resume: () => void };
const SENSITIVE = ["phone", "birthday", "address", "government_id", "location", "gender"];
const GATE_CONTEXTS: Record<GateKind, Context[]> = {
  cookies: ["banner", "any"], terms: ["signup", "any"], form: ["signup", "checkout", "any"],
};

function Overlay({ state, receiptAt, gate, onGate }: { state: TabState | null; receiptAt: number; gate: Gate | null; onGate: (proceed: boolean) => void }) {
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem(DISMISS_KEY) === "1"; } catch { return false; }
  });
  const [showReceipt, setShowReceipt] = useState(false);
  useEffect(() => {
    if (!receiptAt) return;
    setShowReceipt(true);
    const t = setTimeout(() => setShowReceipt(false), 5000);
    return () => clearTimeout(t);
  }, [receiptAt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !gate) dismiss(); };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  function dismiss() {
    setDismissed(true);
    try { sessionStorage.setItem(DISMISS_KEY, "1"); } catch { /* storage blocked */ }
  }

  if (!state) return null;
  const a = state.assessment;
  // once you've answered the banner, it's no longer the moment we're warning about
  const moments = (state.page?.contexts ?? []).filter((c) => c !== "any" && !(c === "banner" && state.choice.value !== "none"));
  const reject = a?.reject_check ?? (state.reject?.status === "watching" ? { status: "watching" } : null);

  return (
    <div className="font-sans flex w-[360px] max-w-[calc(100vw-32px)] flex-col items-end gap-2 [&>*]:pointer-events-auto">
      {gate && <GateDialog key={gate.id} gate={gate} state={state} onClose={onGate} />}
      {showReceipt && (
        <Toast glyph="kept">Saved a copy of the terms you just agreed to. Privany will tell you if they change.</Toast>
      )}
      {reject && <RejectToast check={reject as Assessment["reject_check"] & { status: string }} windowS={state.reject?.window_s ?? 8} />}
      {!dismissed && a && <Panel state={state} a={a} moments={moments} onDismiss={dismiss} />}
    </div>
  );
}

// At a decision moment, what matters for *that* moment leads (auto-renewal at
// checkout, AI training at upload), then the say-vs-do gaps.
function relevant(flags: Flag[], moments: string[]): Flag[] {
  if (!moments.length) return flags.filter((f) => f.severity === "high");
  const specific = moments.filter((m) => m !== "banner");
  const forMoment = flags.filter((f) => f.kind !== "gap" && f.contexts.some((c) => specific.includes(c)));
  const gaps = flags.filter((f) => f.kind === "gap");
  const rest = flags.filter((f) => !forMoment.includes(f) && !gaps.includes(f) && f.contexts.some((c) => moments.includes(c)));
  return forMoment.length ? [...forMoment.slice(0, 3), ...gaps.slice(0, 2), ...rest] : [...gaps, ...rest];
}

function Panel({ state, a, moments, onDismiss }: { state: TabState; a: Assessment; moments: string[]; onDismiss: () => void }) {
  const flags = relevant(a.flags, moments).slice(0, 4);
  const gaps = a.flags.filter((f) => f.kind === "gap").length;
  // stay quiet unless there's something to decide on
  const show = a.verdict === "red" || (moments.length > 0 && (a.verdict === "yellow" || flags.length > 0));
  const [mini, setMini] = useState(false);
  if (!show && moments.length && a.verdict === "green") return <GreenPill text={a.headline} />;
  if (!show) return null;

  const g = verdictGlyph(a.verdict, gaps > 0);
  const momentLine = moments.includes("checkout") ? "Before you pay" : moments.includes("signup") ? "Before you sign up"
    : moments.includes("upload") ? "Before you upload" : moments.includes("banner") ? "Before you answer the cookie banner" : "On this site";

  if (mini) {
    return (
      <button type="button" onClick={() => setMini(false)}
        className="flex items-center gap-2 rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white shadow-[0_6px_24px_rgba(20,33,61,.35)] focus:outline-none focus-visible:ring-2 focus-visible:ring-marker">
        <Glyph kind={g} className="text-lg" /> Privany: {a.flags.length} to review
      </button>
    );
  }

  return (
    <section role="dialog" aria-label="Privany check" className="animate-rise w-full overflow-hidden rounded-[14px] bg-ink text-white shadow-[0_18px_50px_rgba(20,33,61,.45)]">
      <header className="flex items-start gap-3 px-4 pb-3 pt-4">
        <Glyph kind={g} className="text-glyph -mt-0.5 w-8 text-center" />
        <div className="min-w-0 flex-1">
          <div className="text-xs2 text-paper/70">{momentLine}, {state.site}</div>
          <h2 className="m-0 mt-0.5 text-base font-bold leading-snug text-white">{a.headline}</h2>
        </div>
        <button type="button" onClick={() => setMini(true)} aria-label="Minimize"
          className="rounded px-1.5 text-lg leading-none text-paper/60 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-marker">–</button>
      </header>

      {flags.length > 0 && (
        <ul className="m-0 max-h-[46vh] overflow-y-auto border-t border-white/10 px-4 py-1">
          {flags.map((f, i) => <FlagItem key={f.id} f={f} dark open={i === 0 && f.id === "terms_changed"} />)}
        </ul>
      )}
      {a.flags.length > flags.length && (
        <p className="m-0 px-4 pb-1 text-xs text-paper/70">{a.flags.length - flags.length} more in the full report.</p>
      )}

      <footer className="flex flex-wrap items-center gap-2 border-t border-white/10 px-4 py-3">
        <button type="button" onClick={onDismiss}
          className="rounded-lg bg-white px-3 py-1.5 text-sm font-semibold text-ink hover:bg-paper focus:outline-none focus-visible:ring-2 focus-visible:ring-marker">
          Continue anyway
        </button>
        <button type="button" onClick={() => history.length > 1 ? history.back() : window.close()}
          className="rounded-lg border border-white/25 px-3 py-1.5 text-sm font-semibold text-white hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-marker">
          Leave this page
        </button>
        <button type="button" onClick={() => send({ type: "open_report" })}
          className="ml-auto text-sm text-paper/80 underline underline-offset-2 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-marker">
          Full report
        </button>
      </footer>
    </section>
  );
}

function GreenPill({ text }: { text: string }) {
  const [on, setOn] = useState(true);
  useEffect(() => { const t = setTimeout(() => setOn(false), 4500); return () => clearTimeout(t); }, []);
  if (!on) return null;
  return <Toast glyph="kept">{text}</Toast>;
}

function Toast({ glyph, children }: { glyph: "miss" | "kept" | "unsure" | "warn"; children: React.ReactNode }) {
  return (
    <div role="status" className="animate-rise flex w-full items-start gap-3 rounded-[12px] bg-ink px-4 py-3 text-sm text-white shadow-[0_10px_30px_rgba(20,33,61,.35)]">
      <Glyph kind={glyph} className="text-xl" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function RejectToast({ check, windowS }: { check: { status: string; verdict?: string | null; detail?: string; observed?: string[] }; windowS: number }) {
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (check.status === "done" && check.verdict === "held") {
      const t = setTimeout(() => setGone(true), 6000);
      return () => clearTimeout(t);
    }
  }, [check.status, check.verdict]);
  if (gone) return null;

  if (check.status === "watching") {
    return (
      <div role="status" className="animate-rise w-full overflow-hidden rounded-[12px] bg-ink text-sm text-white shadow-[0_10px_30px_rgba(20,33,61,.35)]">
        <div className="flex items-center gap-3 px-4 py-3">
          <Glyph kind="unsure" className="text-xl" />
          <span>You hit Reject. Watching whether the site listens...</span>
        </div>
        <div className="h-1 origin-left bg-marker" style={{ animation: `drain ${windowS}s linear forwards` }} />
      </div>
    );
  }
  const broken = check.verdict === "broken";
  return (
    <div role="status" className={`animate-rise w-full rounded-[12px] px-4 py-3 text-sm shadow-[0_10px_30px_rgba(20,33,61,.35)] ${broken ? "bg-miss text-white" : "bg-ink text-white"}`}>
      <div className="flex items-start gap-3">
        <Glyph kind={broken ? "miss" : "kept"} className={`text-xl ${broken ? "!text-white" : ""}`} />
        <div className="min-w-0 flex-1">
          <div className="font-bold">{broken ? "Your Reject didn't stop the tracking" : "Your Reject held"}</div>
          <div className="mt-0.5 text-white/90">{check.detail}</div>
          {broken && check.observed && (
            <ul className="m-0 mt-1.5 space-y-0.5 p-0 text-xs text-white/85">
              {check.observed.slice(0, 4).map((o, i) => <li key={i} className="list-none">{o}</li>)}
            </ul>
          )}
        </div>
        <button type="button" onClick={() => setGone(true)} aria-label="Close"
          className="text-lg leading-none text-white/70 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-marker">×</button>
      </div>
    </div>
  );
}

// ================================================================== the agree gate dialog
const FIELD_NAMES: Record<string, string> = {
  phone: "phone number", birthday: "birthday", address: "home address", government_id: "ID number",
  location: "location", gender: "gender",
};

function siteName(state: TabState) {
  const host = state.siteKey.replace(/:\d+$/, "").replace(/^www\./, "");
  const first = host.split(".")[0] || host;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function listWords(xs: string[]) {
  return xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

function GateDialog({ gate, state, onClose }: { gate: Gate; state: TabState; onClose: (proceed: boolean) => void }) {
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    back.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(false); } };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, []);

  const a = state.assessment;
  const name = siteName(state);
  const fieldWords = gate.fields.map((f) => FIELD_NAMES[f] ?? f);
  const title = gate.kind === "cookies" ? `Before you accept ${name}'s cookies`
    : gate.kind === "terms" ? `Before you agree to ${name}'s terms`
    : fieldWords.length ? `Before you give ${name} your ${listWords(fieldWords)}` : `Before you send this to ${name}`;
  const go = gate.kind === "cookies" ? "Accept anyway" : gate.kind === "terms" ? "Agree anyway" : "Send anyway";
  const ctx = GATE_CONTEXTS[gate.kind];
  const flags = (a?.flags ?? []).filter((f) => f.contexts.some((c) => ctx.includes(c)) || f.kind === "gap" || f.kind === "change").slice(0, 3);
  const hasGaps = (a?.flags ?? []).some((f) => f.kind === "gap");
  const rejectBroken = a?.reject_check?.verdict === "broken";

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-ink/55 p-4 pointer-events-auto" onClick={(e) => { if (e.target === e.currentTarget) onClose(false); }}>
      <section role="alertdialog" aria-modal="true" aria-labelledby="pv-gate-title"
        className="max-h-[90vh] w-[min(540px,100%)] overflow-y-auto rounded-2xl bg-ink text-white shadow-[0_24px_70px_rgba(20,33,61,.55)]">
        <header className="flex items-start gap-4 px-6 pb-3 pt-6">
          <Glyph kind={a ? verdictGlyph(a.verdict, hasGaps) : "warn"} className="text-[52px] leading-none" />
          <div className="min-w-0 flex-1">
            <div className="text-xs text-paper/70">Privany paused this so you can decide</div>
            <h2 id="pv-gate-title" className="m-0 mt-1 text-xl font-bold leading-tight text-white">{title}</h2>
            <p className="m-0 mt-1.5 text-sm text-paper/85">
              {a ? a.headline : "We couldn't find a privacy policy for this site, so there's no way to know what they'll do with it."}
            </p>
          </div>
        </header>

        {gate.kind === "form" && a && gate.fields.some((f) => a.field_hints?.[f]) && (
          <div className="mx-6 mb-2 space-y-2 rounded-xl bg-white/5 p-3">
            {gate.fields.filter((f) => a.field_hints?.[f]).map((f) => {
              const h = a.field_hints[f];
              return (
                <div key={f} className="text-sm">
                  <span className="font-semibold">Your {FIELD_NAMES[f] ?? f}:</span>{" "}
                  <span className={h.shared_for_ads === "true" ? "bg-marker px-0.5 font-semibold text-ink" : "text-paper/90"}>
                    {h.shared_for_ads === "true" ? "may be shared for ads and marketing" : h.use.replace(/\.$/, "").toLowerCase()}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {flags.length > 0 && (
          <div className="px-6">
            <div className="mb-1 text-xs font-semibold text-paper/80">What you'd be agreeing to</div>
            <ul className="m-0 p-0">{flags.map((f) => <FlagItem key={f.id} f={f} dark />)}</ul>
          </div>
        )}

        {gate.kind === "cookies" && (
          <p className="m-0 mx-6 mt-2 rounded-lg bg-white/5 px-3 py-2 text-sm text-paper/90">
            Their banner has a Reject option too.{rejectBroken && " Heads up: when you tried it here, Reject didn't stop the tracking either."}
          </p>
        )}

        <footer className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/10 px-6 py-4">
          <button ref={back} type="button" onClick={() => onClose(false)}
            className="rounded-lg bg-white px-4 py-2 text-sm font-bold text-ink hover:bg-paper focus:outline-none focus-visible:ring-2 focus-visible:ring-marker">
            Go back
          </button>
          <button type="button" onClick={() => onClose(true)}
            className="rounded-lg border border-white/30 px-4 py-2 text-sm font-semibold text-white hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-marker">
            {go}
          </button>
          <button type="button" onClick={() => send({ type: "open_report" })}
            className="ml-auto text-sm text-paper/80 underline underline-offset-2 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-marker">
            Full report
          </button>
        </footer>
        <p className="m-0 px-6 pb-4 text-xs2 text-paper/60">Privany only pauses on sites that look risky for what you care about. You can turn this off in Settings.</p>
      </section>
    </div>
  );
}

// ================================================================== inline field + upload hints
const decorated = new WeakSet<Element>();
const chipRoots: Root[] = [];
const FIELD_LABEL: Record<string, string> = {
  phone: "phone number", birthday: "birthday", address: "address", email: "email", gender: "gender",
  location: "location", government_id: "ID number", photo: "photo",
};

function decorateFields(a?: Assessment) {
  if (!a) return;
  const hints = a.field_hints || {};
  const aiFlag = a.flags.find((f) => f.id === "policy_ai_training") || a.flags.find((f) => f.id === "policy_content_license");
  for (const input of document.querySelectorAll<HTMLInputElement>("input")) {
    if (decorated.has(input) || input.type === "hidden") continue;
    if (input.type === "file" && aiFlag) {
      decorated.add(input);
      attachChip(input, <UploadChip flag={aiFlag} />);
      continue;
    }
    const k = fieldKind(input);
    const hint = k ? hints[k] : undefined;
    if (!k || !hint || k === "email") continue;  // email is everywhere; don't nag about it
    decorated.add(input);
    attachChip(input, <FieldChip field={k} hint={hint} />);
  }
}

function attachChip(input: HTMLElement, node: React.ReactNode) {
  const hostEl = document.createElement("div");
  hostEl.setAttribute("data-privany", "");
  hostEl.style.cssText = "all: initial; display: block; margin: 4px 0 2px;";
  const sh = hostEl.attachShadow({ mode: "closed" });
  const st = document.createElement("style");
  st.textContent = css;
  sh.appendChild(st);
  const m = document.createElement("div");
  sh.appendChild(m);
  input.insertAdjacentElement("afterend", hostEl);
  const r = createRoot(m);
  r.render(node);
  chipRoots.push(r);
}

function FieldChip({ field, hint }: { field: string; hint: FieldHint }) {
  const [open, setOpen] = useState(false);
  const ads = hint.shared_for_ads === "true";
  return (
    <div className="font-sans text-xs text-ink">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-left font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-ink ${ads ? "bg-marker text-ink" : "bg-paper-deep text-ink-soft"}`}>
        <span aria-hidden className="font-quote font-bold">{ads ? "!" : "i"}</span>
        <span>Privany: their policy says your {FIELD_LABEL[field] ?? field} is {ads ? "shared for ads/marketing" : "used for"}: {hint.use.replace(/\.$/, "").toLowerCase()}</span>
      </button>
      {open && (
        <div className="mt-1.5 max-w-[460px] rounded-md bg-white p-2.5 shadow-[0_4px_16px_rgba(20,33,61,.15)]">
          <Quote ev={hint.quote} />
          <p className="m-0 mt-1.5 text-xs2 text-ink-faint">If this field isn't required, you can leave it blank.</p>
        </div>
      )}
    </div>
  );
}

function UploadChip({ flag }: { flag: Flag }) {
  const [open, setOpen] = useState(false);
  const q = flag.evidence.quotes[0];
  return (
    <div className="font-sans text-xs text-ink">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-md bg-marker px-2 py-1 font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-ink">
        <span aria-hidden className="font-quote font-bold">!</span>
        <span>Privany: {flag.title.charAt(0).toLowerCase() + flag.title.slice(1)}</span>
      </button>
      {open && q && (
        <div className="mt-1.5 max-w-[460px] rounded-md bg-white p-2.5 shadow-[0_4px_16px_rgba(20,33,61,.15)]">
          <Quote ev={q} />
        </div>
      )}
    </div>
  );
}
