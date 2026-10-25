import { useCallback, useEffect, useMemo, useState } from "react";
import { ext, send } from "../lib/api";
import { backend } from "../lib/backend";
import { deleteReceipt, getReceipts, getSettings } from "../lib/settings";
import type { AnalysisResult, Claim, Receipt, TabState } from "../lib/types";
import { FlagItem, Glyph, Quote, verdictGlyph } from "../ui/parts";

type Tab = "overview" | "sayvsdo" | "fine" | "receipts" | "compare";
const CAT_LABEL: Record<string, string> = {
  data_selling: "Selling your data", third_party_sharing: "Sharing with others", advertising_tracking: "Ad tracking",
  data_retention: "How long they keep it", deletion_rights: "Deleting your data", access_rights: "Seeing your data",
  location_data: "Location data", sensitive_data: "Sensitive data", children: "Kids' data", international_transfer: "Sent abroad",
  ai_training: "AI training on your stuff", content_license: "Rights to your content", arbitration: "Forced arbitration",
  class_action_waiver: "No class actions", auto_renewal: "Auto-renewal", cancellation_refunds: "Cancelling and refunds",
  liability_limits: "Liability limits", account_termination: "Account termination", policy_changes: "Changing the terms",
};

export default function App() {
  const params = new URLSearchParams(location.search);
  const full = params.get("full") === "1";
  const [tabId, setTabId] = useState<number | null>(params.get("tab") ? Number(params.get("tab")) : null);
  const [state, setState] = useState<TabState | null>(null);
  const [view, setView] = useState<Tab>("overview");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (tabId !== null) return;
    ext.tabs.query({ active: true, currentWindow: true }).then(([t]) => setTabId(t?.id ?? -1));
  }, [tabId]);

  const refresh = useCallback(async () => {
    if (tabId === null || tabId < 0) { setLoaded(true); return; }
    setState(await send<TabState | null>({ type: "get_state", tabId }));
    setLoaded(true);
  }, [tabId]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 1500);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <div className={`bg-paper font-sans text-ink ${full ? "min-h-screen" : "w-[400px]"}`}>
      <div className={full ? "mx-auto max-w-[720px] px-6 py-8" : ""}>
        <Header state={state} loaded={loaded} tabId={tabId} />
        {state?.analysis && (
          <>
            <nav className="flex overflow-x-auto border-b border-ink/10 px-3" role="tablist">
              {([["overview", "Overview"], ["sayvsdo", "Say vs Do"], ["fine", "Fine print"], ["receipts", "Receipts"], ["compare", "Compare"]] as [Tab, string][]).map(([k, label]) => (
                <button key={k} role="tab" aria-selected={view === k} onClick={() => setView(k)}
                  className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-[7px] py-2 text-[13px] font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-ink ${view === k ? "border-ink text-ink" : "border-transparent text-ink-faint hover:text-ink"}`}>
                  {label}
                </button>
              ))}
            </nav>
            <main className={`${full ? "" : "max-h-[460px]"} overflow-y-auto px-4 py-3`}>
              {view === "overview" && <Overview state={state} />}
              {view === "sayvsdo" && <SayVsDo state={state} />}
              {view === "fine" && <FinePrint state={state} />}
              {view === "receipts" && <Receipts state={state} />}
              {view === "compare" && <Compare state={state} />}
            </main>
          </>
        )}
        <Footer state={state} full={full} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ header
function Header({ state, loaded, tabId }: { state: TabState | null; loaded: boolean; tabId: number | null }) {
  const a = state?.assessment;
  const gaps = a?.flags.filter((f) => f.kind === "gap").length ?? 0;
  let line: React.ReactNode = null;
  let headline = a?.headline ?? "";

  if (!loaded) headline = "Loading...";
  else if (!state) headline = "Open a website and Privany checks it as the page loads.";
  else if (state.status === "analyzing") headline = "Reading this site's privacy policy and terms...";
  else if (state.status === "paused") headline = "Paused on this site.";
  else if (state.status === "skipped") {
    headline = "Not checked yet.";
    line = <span>You're in decision-moments mode. <button className="underline" onClick={() => tabId && send({ type: "reanalyze", tabId })}>Check this site now</button></span>;
  } else if (state.status === "error") {
    headline = state.error ?? "Something went wrong.";
    line = <span>Check that the Privany server is running, then <button className="underline" onClick={() => tabId && send({ type: "reanalyze", tabId })}>try again</button>.</span>;
  } else if (state.analysis && !state.analysis.analysis) {
    headline = "Couldn't find or read a privacy policy here.";
    line = <span>{state.analysis.errors[0]}</span>;
  }

  return (
    <header className="flex items-start gap-3 px-4 pb-3 pt-4">
      <Glyph kind={state?.status === "ready" ? verdictGlyph(a?.verdict, gaps > 0) : "unsure"} className="text-glyph w-9 text-center" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-ink-faint">{state?.siteKey ?? "Privany"}</div>
        <h1 className="m-0 mt-0.5 text-lg font-bold leading-snug text-ink">{headline}</h1>
        {line && <p className="m-0 mt-1 text-xs text-ink-soft">{line}</p>}
        {a && state?.status === "ready" && state.analysis?.analysis?.summary && (
          <p className="m-0 mt-1.5 text-sm text-ink-soft">{state.analysis.analysis.summary}</p>
        )}
      </div>
    </header>
  );
}

// ------------------------------------------------------------------ overview
function Overview({ state }: { state: TabState }) {
  const a = state.assessment;
  if (!a) return <p className="text-sm text-ink-faint">Comparing what the site says with what it does...</p>;
  return (
    <div className="space-y-4">
      {a.flags.length > 0 ? (
        <ul className="m-0 divide-y divide-ink/10 p-0">
          {a.flags.map((f, i) => <FlagItem key={f.id} f={f} open={i === 0 && f.kind === "gap"} />)}
        </ul>
      ) : (
        <p className="m-0 text-sm text-ink-soft">Nothing here clashes with the priorities you set.</p>
      )}
      {a.good_signs.length > 0 && (
        <section>
          <h2 className="m-0 mb-1.5 text-sm font-bold">Good signs</h2>
          <ul className="m-0 space-y-1 p-0">
            {a.good_signs.map((g) => (
              <li key={g.id} className="flex list-none gap-2 text-sm">
                <Glyph kind="kept" className="w-3 text-base" />
                <span><span className="font-semibold">{g.title}.</span> <span className="text-ink-soft">{g.detail}</span></span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {a.unknowns.length > 0 && (
        <section>
          <h2 className="m-0 mb-1.5 text-sm font-bold">The policy doesn't say</h2>
          <p className="m-0 text-sm text-ink-soft">{a.unknowns.map((u) => u.label.toLowerCase()).join(", ")}. Silence isn't a yes or a no.</p>
        </section>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ say vs do
function plural(count: number, word: string, many?: string) {
  return `${count} ${count === 1 ? word : many ?? word + "s"}`;
}

function claimText(c?: Claim) {
  if (!c || c.value === "unspecified") return null;
  return c;
}

function SayVsDo({ state }: { state: TabState }) {
  const claims = state.analysis?.analysis?.claims ?? {};
  const cookies = Object.values(state.cookies);
  const adCookies = cookies.filter((c) => c.ad_platform);
  const adTrackers = Object.values(state.trackers).filter((t) => t.ad);
  const before = [...adCookies.filter((c) => c.before_choice), ...adTrackers.filter((t) => t.before_choice)];
  const gpc = state.gpc;
  const audit = gpc?.result;
  const red = audit?.targeting_reduction;
  const rc = state.assessment?.reject_check;

  const rows: { key: string; title: string; claim?: Claim | null; mark: "miss" | "kept" | "unsure"; saw: React.ReactNode }[] = [];

  // 1. GPC
  const gpcClaim = claimText(claims.honors_gpc);
  let gpcMark: "miss" | "kept" | "unsure" = "unsure";
  if (audit && !audit.inconclusive.length && gpcClaim?.value === "true") gpcMark = (red ?? 0) < 0.2 && audit.default.counts.targeting > 0 ? "miss" : "kept";
  rows.push({
    key: "gpc", title: "Global Privacy Control", claim: gpcClaim, mark: gpcMark,
    saw: gpc?.status === "running" ? <span>Running a controlled test in two fresh browsers, GPC off and on...</span>
      : audit ? (
        <span>
          Targeting cookies with GPC off: <b className="tabular-nums">{audit.default.counts.targeting}</b>, with GPC on: <b className="tabular-nums">{audit.gpc.counts.targeting}</b>
          {red !== null && red !== undefined && <> ({Math.max(red, 0) * 100 < 1 ? "no" : `${Math.round(red * 100)}%`} drop)</>}.
          {audit.inconclusive.length > 0 && <span className="block text-amber">{audit.inconclusive.join(" ")}</span>}
          {audit.well_known_gpc && <span className="block text-ink-faint">Site publishes a GPC support file: {audit.well_known_gpc.gpc ? "yes" : "no"}.</span>}
        </span>
      ) : gpc?.status === "error" ? <span className="text-amber">Test failed: {gpc.error}</span>
      : <span>Not tested yet.</span>,
  });

  // 2. selling
  const sell = claimText(claims.sells_data);
  rows.push({
    key: "sell", title: "Selling your data", claim: sell,
    mark: sell?.value === "false" && (adCookies.length || adTrackers.length) ? "miss" : sell?.value === "false" ? "kept" : "unsure",
    saw: adCookies.length || adTrackers.length ? (
      <span>Ad platforms on this page: {[...new Set([...adCookies.map((c) => c.owner), ...adTrackers.map((t) => t.owner)].filter(Boolean))].join(", ") || "unnamed"}.
        <span className="block text-ink-faint">{plural(adCookies.length, "ad cookie")}, {plural(adTrackers.length, "ad tracker")}.</span></span>
    ) : <span>No ad-platform cookies or trackers seen on this page.</span>,
  });

  // 3. before consent
  const consentClaim = claimText(claims.uses_tracking_only_after_consent) ?? claimText(claims.sets_cookies_before_consent);
  const bannerFound = !!state.page?.banner.found;
  // no banner on this visit (you already answered it): fall back to the controlled test,
  // where nobody ever touches the banner
  const testBanner = audit?.default.banner.found;
  const testPre = audit?.default.counts.ad_platform ?? 0;
  const promised = consentClaim?.value === "true" || claims.sets_cookies_before_consent?.value === "false";
  rows.push({
    key: "consent", title: "Tracking before you choose", claim: consentClaim,
    mark: bannerFound
      ? (before.length && promised ? "miss" : before.length ? "unsure" : "kept")
      : testBanner ? (testPre && promised ? "miss" : testPre ? "unsure" : "kept") : "unsure",
    saw: bannerFound
      ? (before.length ? <span>{plural(before.length, "ad cookie or tracker", "ad cookies and trackers")} loaded before you answered the banner.</span>
        : <span>Nothing ad-related loaded before you answered.</span>)
      : testBanner ? <span>In our controlled visit nobody touched the banner, and {plural(testPre, "ad-platform cookie")} got set anyway.</span>
      : <span>No cookie banner on this page, and our test hasn't seen one either.</span>,
  });

  // 4. reject
  const rejectClaim = claimText(claims.deletes_cookies_on_rejection) ?? claimText(claims.sets_cookies_after_rejecting_consent) ?? claimText(claims.uses_tracking_only_after_consent);
  rows.push({
    key: "reject", title: "When you hit Reject", claim: rejectClaim,
    mark: rc?.verdict === "broken" ? "miss" : rc?.verdict === "held" ? "kept" : "unsure",
    saw: rc?.status === "done" ? <span>{rc.detail}{rc.observed && <span className="block text-ink-faint">{rc.observed.slice(0, 3).join("; ")}</span>}</span>
      : state.reject?.status === "watching" ? <span>Watching right now...</span>
      : <span>{bannerFound ? "Click Reject on the site's cookie banner and Privany watches the next 8 seconds." : "No banner to test here."}</span>,
  });

  return (
    <div className="space-y-1">
      <p className="m-0 mb-2 text-xs text-ink-faint">Left: their words, quoted exactly. Right: what actually happened in your browser and in our controlled test.</p>
      <ul className="m-0 divide-y divide-ink/10 p-0">
        {rows.map((r) => (
          <li key={r.key} className="grid list-none grid-cols-[1fr_28px_1fr] gap-2 py-3">
            <div className="min-w-0">
              <div className="mb-1 text-xs font-semibold">{r.title}</div>
              {r.claim?.evidence.quote ? <Quote ev={r.claim.evidence} /> : <span className="text-sm italic text-ink-faint">Their policy doesn't say.</span>}
            </div>
            <div className="flex items-start justify-center pt-5"><Glyph kind={r.mark} className="text-2xl" /></div>
            <div className="min-w-0 pt-5 text-sm text-ink-soft">{r.saw}</div>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-3 pt-2">
        <button disabled={gpc?.status === "running"} onClick={() => send({ type: "run_gpc_test", tabId: state.tabId })}
          className="rounded-lg bg-ink px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-marker">
          {gpc?.status === "running" ? "Testing..." : audit ? "Run the GPC test again" : "Run the GPC test"}
        </button>
        {audit && <span className="text-xs text-ink-faint">{audit.browser}, {new Date(audit.ran_at).toLocaleString()}</span>}
      </div>
      {audit && (
        <details className="mt-2 text-xs text-ink-soft">
          <summary className="cursor-pointer font-semibold text-ink">How the test works</summary>
          <p className="m-0 mt-1">{audit.method}</p>
          <ul className="m-0 mt-1 p-0">{audit.limits.map((l, i) => <li key={i} className="list-none">{l}</li>)}</ul>
          <p className="m-0 mt-1">Cookies with GPC on: {audit.gpc.cookies.map((c) => `${c.name} (${c.category})`).join(", ") || "none"}.</p>
        </details>
      )}
      <PriorAuditCard state={state} />
    </div>
  );
}

function PriorAuditCard({ state }: { state: TabState }) {
  const p = state.analysis?.prior_audit;
  if (!p) return null;
  return (
    <section className="mt-4 rounded-lg bg-paper-deep p-3">
      <h2 className="m-0 text-sm font-bold">This site was in the PrivAudit study</h2>
      <p className="m-0 mt-1 text-xs text-ink-soft">
        Researchers at UC Santa Cruz crawled it{p.crawl_date ? ` on ${p.crawl_date}` : ""} (PrivAudit, ACM CCS 2026).
        {p.cookies && <> Targeting cookies then: {p.cookies.tgt_default} normally, {p.cookies.tgt_gpc} with GPC.</>}
      </p>
      {p.gaps.length > 0 ? (
        <ul className="m-0 mt-2 space-y-1 p-0">{p.gaps.map((g) => (
          <li key={g.rule} className="flex list-none gap-2 text-xs"><Glyph kind="miss" className="text-sm" /> {g.detail}</li>
        ))}</ul>
      ) : <p className="m-0 mt-1 text-xs text-ink-soft">No disclosure–behavior gaps were flagged for it.</p>}
    </section>
  );
}

// ------------------------------------------------------------------ fine print
function FinePrint({ state }: { state: TabState }) {
  const an = state.analysis!;
  const a = an.analysis!;
  const findings = a.findings.filter((f) => f.evidence.verified);
  const unverified = a.findings.length - findings.length;
  return (
    <div className="space-y-4">
      <ul className="m-0 divide-y divide-ink/10 p-0">
        {findings.map((f, i) => (
          <li key={i} className="list-none py-2.5">
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-semibold">{CAT_LABEL[f.category] ?? f.category}</span>
              <span className="text-xs text-ink-faint">{{ permits: "allowed", prohibits: "ruled out", provides_right: "your right", unclear: "vague" }[f.stance]}</span>
            </div>
            <p className="m-0 mb-1.5 mt-0.5 text-sm text-ink-soft">{f.statement}</p>
            <Quote ev={f.evidence} />
          </li>
        ))}
      </ul>
      {a.opt_outs.some((o) => o.evidence.verified) && (
        <section>
          <h2 className="m-0 mb-1.5 text-sm font-bold">Choices they describe</h2>
          <ul className="m-0 space-y-2 p-0">
            {a.opt_outs.filter((o) => o.evidence.verified).map((o, i) => (
              <li key={i} className="list-none text-sm"><span className="font-semibold">{o.label}.</span> <span className="text-ink-soft">{o.how}</span></li>
            ))}
          </ul>
        </section>
      )}
      <section className="text-xs text-ink-faint">
        <p className="m-0">
          {a.quote_check.verified} of {a.quote_check.total} quotes matched the source word for word{unverified > 0 && `; ${unverified} that didn't were left out`}.
          {" "}Read by {an.engine?.startsWith("gemini") ? `Gemini (${an.engine.split(":")[1]})` : "keyword rules (no AI model)"}{an.cached ? ", cached" : ""}.
        </p>
        <ul className="m-0 mt-1 p-0">
          {an.documents.map((d) => (
            <li key={d.url} className="list-none">
              <a className="underline" href={d.url} target="_blank" rel="noreferrer">{d.kind === "terms" ? "Terms" : d.kind === "cookies" ? "Cookie policy" : "Privacy policy"}</a>
              {", "}{d.paragraphs} paragraphs, fetched {new Date(d.retrieved_at).toLocaleDateString()}
              {d.rendered && <span> (built with JavaScript, so Privany rendered it in a browser)</span>}
              {d.partial && <span className="text-amber"> (partial: {d.notes.filter((n) => !n.includes("rendered it")).join(" ")})</span>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ receipts
function Receipts({ state }: { state: TabState }) {
  const [all, setAll] = useState<Receipt[]>([]);
  const [diffs, setDiffs] = useState<Record<string, { changed: boolean; added?: string[]; removed?: string[]; error?: string } | "loading">>({});
  useEffect(() => { getReceipts().then(setAll); }, []);
  const mine = useMemo(() => all.filter((r) => r.siteKey === state.siteKey), [all, state.siteKey]);

  async function check(r: Receipt) {
    const base = (await getSettings()).backendUrl;
    for (const d of r.documents) {
      const key = `${r.id}|${d.url}`;
      setDiffs((x) => ({ ...x, [key]: "loading" }));
      try {
        const res = await backend.diff(base, d.url, d.content_hash, d.paragraphs);
        setDiffs((x) => ({ ...x, [key]: res }));
      } catch (e) {
        setDiffs((x) => ({ ...x, [key]: { changed: false, error: String((e as Error).message) } }));
      }
    }
  }

  if (!mine.length) {
    return <p className="m-0 text-sm text-ink-soft">When you tick an "I agree to the terms" box or sign up here, Privany saves an exact copy of the terms on this device. Later it can show you what changed.</p>;
  }
  const changed = state.assessment?.flags.find((f) => f.id === "terms_changed");
  return (
    <div className="space-y-3">
    {changed && (
      <section className="rounded-lg bg-ink p-3 text-white">
        <h2 className="m-0 flex items-center gap-2 text-sm font-bold"><Glyph kind="miss" className="text-lg" />{changed.title}</h2>
        <p className="m-0 mt-1 text-xs text-paper/80">{changed.detail}</p>
        <ul className="m-0 mt-2 space-y-1.5 p-0">
          {changed.evidence.observed.map((l, i) => (
            <li key={i} className="list-none text-sm">{l.startsWith("Before:") ? <BeforeNow line={l} /> : l}</li>
          ))}
        </ul>
      </section>
    )}
    <ul className="m-0 space-y-3 p-0">
      {mine.map((r) => (
        <li key={r.id} className="list-none rounded-lg bg-white p-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-semibold">You agreed on {new Date(r.agreed_at).toLocaleString()}</span>
            <button className="text-xs text-ink-faint underline" onClick={async () => { await deleteReceipt(r.id); setAll(await getReceipts()); }}>Delete</button>
          </div>
          <p className="m-0 mt-0.5 text-xs text-ink-faint">Privany's read at the time: {r.headline_then || r.verdict_then}</p>
          <button onClick={() => check(r)} className="mt-2 rounded-lg bg-ink px-3 py-1.5 text-xs font-semibold text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-marker">Check for changes</button>
          {r.documents.map((d) => {
            const res = diffs[`${r.id}|${d.url}`];
            if (!res) return null;
            if (res === "loading") return <p key={d.url} className="m-0 mt-2 text-xs text-ink-faint">Checking {d.kind}...</p>;
            if (res.error) return <p key={d.url} className="m-0 mt-2 text-xs text-amber">{d.kind}: {res.error}</p>;
            if (!res.changed) return <p key={d.url} className="m-0 mt-2 flex gap-1.5 text-xs"><Glyph kind="kept" /> {d.kind === "terms" ? "Terms" : "Policy"} unchanged since you agreed.</p>;
            return (
              <div key={d.url} className="mt-2 text-xs">
                <p className="m-0 flex gap-1.5 font-semibold"><Glyph kind="miss" /> {d.kind === "terms" ? "Terms" : "Policy"} changed since you agreed</p>
                {res.added?.slice(0, 5).map((p, i) => <p key={`a${i}`} className="m-0 mt-1 font-quote"><span className="bg-marker/80 px-0.5">+ {p}</span></p>)}
                {res.removed?.slice(0, 5).map((p, i) => <p key={`r${i}`} className="m-0 mt-1 font-quote text-ink-faint line-through">− {p}</p>)}
              </div>
            );
          })}
        </li>
      ))}
    </ul>
    </div>
  );
}

/** "Before: X. Now: Y." -> X struck through, Y highlighted */
function BeforeNow({ line }: { line: string }) {
  const m = /^Before: (.*?)\. Now: (.*?)\.$/.exec(line);
  if (!m) return <>{line}</>;
  return (
    <span>
      <span className="text-paper/60 line-through decoration-miss decoration-2">{m[1]}</span>
      <span className="mx-1.5 text-paper/60" aria-hidden>→</span>
      <span className="bg-marker px-0.5 font-semibold text-ink">{m[2]}</span>
    </span>
  );
}

// ------------------------------------------------------------------ compare two sites
// Same questions, same priorities, side by side. Shows trade-offs; never crowns a site "safe".
type Row = { key: string; label: string; pref: keyof import("../lib/types").Preferences; kind: "claim" | "cat"; bad: "true" | "false" | "permits" | "missing" };
const ROWS: Row[] = [
  { key: "sells_data", label: "Sells your data", pref: "selling_sharing", kind: "claim", bad: "true" },
  { key: "shares_with_third_parties", label: "Shares with other companies", pref: "selling_sharing", kind: "claim", bad: "true" },
  { key: "honors_gpc", label: "Honors Global Privacy Control", pref: "ad_tracking", kind: "claim", bad: "false" },
  { key: "uses_tracking_only_after_consent", label: "Tracks only after you consent", pref: "ad_tracking", kind: "claim", bad: "false" },
  { key: "ai_training", label: "AI training on your uploads", pref: "ai_training", kind: "cat", bad: "permits" },
  { key: "content_license", label: "Broad rights to your content", pref: "ai_training", kind: "cat", bad: "permits" },
  { key: "arbitration", label: "Forced arbitration", pref: "legal_traps", kind: "cat", bad: "permits" },
  { key: "class_action_waiver", label: "No class actions", pref: "legal_traps", kind: "cat", bad: "permits" },
  { key: "auto_renewal", label: "Auto-renewal", pref: "legal_traps", kind: "cat", bad: "permits" },
  { key: "deletion_rights", label: "Lets you delete your data", pref: "retention_deletion", kind: "cat", bad: "missing" },
];

type Cell = { text: string; tone: "bad" | "good" | "none"; quote?: string };

function cellFor(r: Row, a: AnalysisResult["analysis"]): Cell {
  if (!a) return { text: "No policy", tone: "none" };
  if (r.kind === "claim") {
    const c = a.claims[r.key];
    const v = c?.value ?? "unspecified";
    if (v === "unspecified") return { text: "Doesn't say", tone: "none" };
    return { text: v === "true" ? "Yes" : "No", tone: v === r.bad ? "bad" : "good", quote: c.evidence.quote };
  }
  const f = a.findings.find((x) => x.category === r.key && x.evidence.verified);
  if (!f) return { text: "Doesn't say", tone: "none" };
  if (r.bad === "missing") return { text: f.stance === "provides_right" ? "Yes" : "Unclear", tone: f.stance === "provides_right" ? "good" : "none", quote: f.evidence.quote };
  if (f.stance === "prohibits") return { text: "No", tone: "good", quote: f.evidence.quote };
  return { text: f.stance === "unclear" ? "Vague" : "Yes", tone: f.stance === "permits" ? "bad" : "none", quote: f.evidence.quote };
}

/** "honestgoods.localhost:8091" -> "honestgoods", "www.nike.com" -> "nike" */
function shortName(key: string) {
  const host = key.replace(/:\d+$/, "").replace(/^www\./, "");
  return host.split(".")[0] || host;
}

function Compare({ state }: { state: TabState }) {
  const [others, setOthers] = useState<{ key: string; result: AnalysisResult }[] | null>(null);  // null = still loading
  const [pick, setPick] = useState<string>("");
  const [prefs, setPrefs] = useState<import("../lib/types").Preferences | null>(null);
  useEffect(() => {
    ext.storage.local.get(null).then((all: Record<string, unknown>) => {
      const list = Object.entries(all)
        .filter(([k, v]) => k.startsWith("analysis:") && k.slice(9) !== state.siteKey && (v as { result?: AnalysisResult }).result?.analysis)
        .map(([k, v]) => ({ key: k.slice(9), result: (v as { result: AnalysisResult }).result }));
      setOthers(list);
      if (list.length && !pick) setPick(list[0].key);
    });
    getSettings().then((s) => setPrefs(s.preferences));
  }, [state.siteKey]);

  if (others === null) return null;
  if (!others.length) {
    return <p className="m-0 text-sm text-ink-soft">Visit another site with Privany on, then come back here to put the two side by side, judged by the same priorities.</p>;
  }
  const other = others.find((o) => o.key === pick) ?? others[0];
  const rows = ROWS.filter((r) => !prefs || prefs[r.pref] > 0);
  const mine = state.analysis?.analysis ?? null;
  const better: Record<"a" | "b", string[]> = { a: [], b: [] };
  const cells = rows.map((r) => {
    const a = cellFor(r, mine);
    const b = cellFor(r, other.result.analysis);
    if (a.tone === "good" && b.tone !== "good") better.a.push(r.label.toLowerCase());
    if (b.tone === "good" && a.tone !== "good") better.b.push(r.label.toLowerCase());
    return { r, a, b, differs: a.text !== b.text };
  });
  const tone = (c: Cell) => c.tone === "bad" ? "text-miss font-semibold" : c.tone === "good" ? "text-kept font-semibold" : "text-ink-faint";

  return (
    <div className="space-y-3">
      <label className="block text-xs font-semibold" htmlFor="cmp">Compare {state.siteKey} with</label>
      <select id="cmp" value={other.key} onChange={(e) => setPick(e.target.value)}
        className="w-full rounded-lg border border-ink/20 bg-white px-2 py-1.5 text-sm">
        {others.map((o) => <option key={o.key} value={o.key}>{o.key}</option>)}
      </select>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="text-left text-xs text-ink-faint">
            <th className="py-1 pr-2 font-semibold">What their documents say</th>
            <th className="w-[26%] py-1 pr-1 font-semibold" title={state.siteKey}>{shortName(state.siteKey)}</th>
            <th className="w-[26%] py-1 font-semibold" title={other.key}>{shortName(other.key)}</th>
          </tr>
        </thead>
        <tbody>
          {cells.map(({ r, a, b, differs }) => (
            <tr key={r.key} className={`border-t border-ink/10 ${differs ? "bg-white" : ""}`}>
              <td className="py-1.5 pr-2">{r.label}</td>
              <td className={`py-1.5 ${tone(a)}`} title={a.quote}>{a.text}</td>
              <td className={`py-1.5 ${tone(b)}`} title={b.quote}>{b.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="space-y-1 text-sm text-ink-soft">
        {better.a.length > 0 && <p className="m-0"><b className="text-ink">{shortName(state.siteKey)}</b> looks better on {better.a.join(", ")}.</p>}
        {better.b.length > 0 && <p className="m-0"><b className="text-ink">{shortName(other.key)}</b> looks better on {better.b.join(", ")}.</p>}
        {!better.a.length && !better.b.length && <p className="m-0">On what you care about, their documents say about the same thing.</p>}
        <p className="m-0 text-xs text-ink-faint">Rows follow your priorities in Settings. Hover a cell for the exact quote. This compares what they wrote, not what they do.</p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ footer
function Footer({ state, full }: { state: TabState | null; full: boolean }) {
  return (
    <footer className="flex items-center gap-3 border-t border-ink/10 px-4 py-2.5 text-xs text-ink-faint">
      <span className="flex-1">The server gets this site's address, its policy links, and the names of cookies and trackers seen here. Never what you type or what's inside a cookie.</span>
      {!full && state && (
        <button className="underline" onClick={() => send({ type: "open_report", tabId: state.tabId })}>Full report</button>
      )}
      <button className="underline" onClick={() => ext.runtime.openOptionsPage()}>Settings</button>
    </footer>
  );
}
