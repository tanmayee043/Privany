/// <reference types="chrome" />
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { RefreshCw } from "lucide-react";
import "./panel.css";
import { api, type JobStatus, type Report } from "../../web/src/api";
import { FactsPanel } from "../../web/src/components/FactsPanel";
import { Evidence } from "../../web/src/components/Evidence";
import { NextSteps, PrioritiesForm } from "../../web/src/components/Personal";
import { NoGoSection, NoGoSetup, useNoGos } from "../../web/src/components/NoGos";
import { CookieTable, HowTested, Topics } from "../../web/src/components/Details";
import { ClickTestSection } from "../../web/src/components/ClickTest";
import { loadPriorities, rankComparisons, savePriorities, type Priorities } from "../../web/src/priorities";
import { siteName } from "../../web/src/words";
import type { TabState } from "./shared";

const tabId = Number(new URLSearchParams(location.search).get("tab"));
const storageKey = `tab:${tabId}`;

function useTabState(): TabState | null | undefined {
  // undefined while loading; null when this tab hasn't been checked yet.
  const [state, setState] = useState<TabState | null | undefined>(undefined);
  useEffect(() => {
    void chrome.storage.session.get(storageKey).then((r) => setState((r[storageKey] as TabState | undefined) ?? null));
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "session" && storageKey in changes) setState((changes[storageKey].newValue as TabState | undefined) ?? null);
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);
  return state;
}

function recheck() {
  void chrome.runtime.sendMessage({ type: "privany:recheck", tabId });
}

function Panel() {
  const state = useTabState();
  const [job, setJob] = useState<JobStatus | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  const jobId = state?.phase === "running" ? state.jobId : undefined;
  useEffect(() => {
    setJob(null);
    setReport(null);
    setError(null);
    if (!jobId) return;
    let stop = false;
    let timer: number;
    const tick = async () => {
      try {
        const j = await api.job(jobId);
        if (stop) return;
        setJob(j);
        if (j.state === "done" && j.reportId) {
          setReport(await api.report(j.reportId));
          return;
        }
        if (j.state === "failed") return;
      } catch (err) {
        if (!stop) setError(err instanceof TypeError ? "Lost contact with the Privany server. Is it still running?" : (err as Error).message);
        return;
      }
      timer = window.setTimeout(tick, 1500);
    };
    void tick();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [jobId]);

  const site = state && "site" in state ? state.site : undefined;

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center gap-3 bg-ink px-4 py-3 text-white">
        <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true">
          <rect width="32" height="32" rx="6" fill="#fff" />
          <rect x="7" y="7" width="18" height="3" fill="#111" />
          <rect x="7" y="13" width="18" height="1.5" fill="#111" />
          <rect x="7" y="17.5" width="12" height="1.5" fill="#111" />
          <rect x="7" y="22" width="18" height="3" fill="#111" />
        </svg>
        <span className="text-[17px] font-extrabold">Privany</span>
        {site && <span className="min-w-0 truncate text-[14px] text-[#c9ced6]">{siteName(site)}</span>}
        {(report || state?.phase === "error" || job?.state === "failed") && (
          <button type="button" onClick={recheck} className="ml-auto flex items-center gap-1.5 rounded bg-white/10 px-2.5 py-1 text-[13px] font-semibold hover:bg-white/20">
            <RefreshCw size={14} aria-hidden="true" /> Check again
          </button>
        )}
      </header>
      <main className="flex-1 p-3">
        {state === undefined ? null : state === null ? (
          <div className="grid grid-cols-1 gap-3">
            <FirstUseNoGos />
            <Idle />
          </div>
        ) : state.phase === "error" ? (
          <Message title={state.offline ? "Privany's server isn't running" : "Couldn't check this page"} body={state.error} />
        ) : error ? (
          <Message title="Something went wrong" body={error} />
        ) : report ? (
          <ReportView report={report} />
        ) : (
          <div className="grid grid-cols-1 gap-3">
            <FirstUseNoGos />
            <Progress job={job} reading={state.phase === "reading"} site={site} />
          </div>
        )}
      </main>
    </div>
  );
}

/** First use: ask for no-goes before the first result, so the report can lead with them. */
function FirstUseNoGos() {
  const [prefs, setPrefs] = useNoGos();
  const [dismissed, setDismissed] = useState(false);
  if (!prefs || prefs.selected.length || dismissed) return null;
  return <NoGoSetup value={prefs} onChange={setPrefs} onDone={() => setDismissed(true)} doneLabel="Save and continue" />;
}

function Idle() {
  const [prefs, setPrefs] = useNoGos();
  const [editing, setEditing] = useState(false);
  if (prefs && editing) {
    return <NoGoSetup value={prefs} onChange={setPrefs} onDone={() => setEditing(false)} />;
  }
  return (
    <section className="border-2 border-ink bg-paper px-4 pb-4 pt-3">
      <h1 className="font-label text-[34px] font-bold leading-none">Privacy Facts</h1>
      <p className="mt-2 text-[14px] text-ink-2">Open a site's privacy policy, or any of its pages, and check it here. Privany reads the policy and tests what the site does with Global Privacy Control.</p>
      <button type="button" onClick={recheck} className="mt-4 w-full bg-ink px-4 py-2.5 text-[15px] font-bold text-white hover:bg-[#2b2b2b]">
        Check this page
      </button>
      {prefs && (
        <p className="mt-3 text-[13px] text-ink-2">
          {prefs.selected.length ? `${prefs.selected.length} no-go${prefs.selected.length === 1 ? "" : "es"} set. ` : ""}
          <button type="button" onClick={() => setEditing(true)} className="font-semibold text-evidence underline">
            {prefs.selected.length ? "Edit my no-goes" : "Set up my no-goes"}
          </button>
        </p>
      )}
      <p className="mt-2 text-[12px] text-ink-3">If nothing happens, click the Privany icon in the toolbar while this tab is open.</p>
    </section>
  );
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <section role="alert" className="border-2 border-ink bg-paper px-4 py-4">
      <h1 className="text-[18px] font-extrabold">{title}</h1>
      <p className="mt-2 text-[14px] text-ink-2">{body}</p>
      <button type="button" onClick={recheck} className="mt-4 bg-ink px-4 py-2 text-[14px] font-bold text-white hover:bg-[#2b2b2b]">
        Try again
      </button>
    </section>
  );
}

const STATE_TEXT: Record<JobStatus["steps"][number]["state"], string> = { pending: "Waiting", running: "Working", done: "Done", skipped: "Skipped", failed: "Failed" };

function Progress({ job, reading, site }: { job: JobStatus | null; reading: boolean; site?: string }) {
  const failed = job?.state === "failed";
  return (
    <section className="border-2 border-ink bg-paper px-4 pb-4 pt-3">
      <h1 className="font-label text-[34px] font-bold leading-none">Privacy Facts</h1>
      <p className="pb-2 pt-1.5 text-[14px] text-ink-2">{failed ? "The check stopped." : `Checking ${site ? siteName(site) : "this site"}. About a minute.`}</p>
      <ol className="rule-bar" aria-live="polite">
        {reading && <li className="working py-2.5 font-bold text-evidence">Reading this page…</li>}
        {(job?.steps ?? []).map((s) => (
          <li key={s.key} className="rule-line grid grid-cols-[1fr_auto] gap-x-3 py-2.5 first:border-t-0">
            <span className={`text-[14px] font-bold ${s.state === "pending" ? "text-ink-3" : ""}`}>{s.label}</span>
            <span className={`text-[13px] font-semibold ${s.state === "failed" ? "text-gap" : s.state === "running" ? "working text-evidence" : s.state === "done" ? "" : "text-ink-3"}`}>
              {STATE_TEXT[s.state]}
            </span>
            {s.detail && <span className={`print-in col-span-2 text-[12px] ${s.state === "failed" ? "text-gap" : "text-ink-2"}`}>{s.detail}</span>}
          </li>
        ))}
      </ol>
      {failed && <p role="alert" className="rule-div pt-2 text-[14px] font-semibold text-gap">{job?.error}</p>}
    </section>
  );
}

function ReportView({ report }: { report: Report }) {
  const [priorities, setPriorities] = useState<Priorities>(loadPriorities);
  const [selected, setSelected] = useState<string | undefined>();
  const ranked = useMemo(() => rankComparisons(report.comparisons, priorities), [report, priorities]);
  const current = ranked.find((c) => c.key === selected) ?? ranked[0];
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <NoGoSection report={report} />
      <FactsPanel
        report={report}
        ranked={ranked}
        selected={current?.key}
        onSelect={(k) => {
          setSelected(k);
          document.getElementById("evidence")?.scrollIntoView({ behavior: "smooth", block: "start" });
        }}
      />
      <div id="evidence" className="scroll-mt-3">
        {current && <Evidence key={current.key} c={current} report={report} />}
      </div>
      {report.policy && (
        <PrioritiesForm
          value={priorities}
          onChange={(p) => {
            setPriorities(p);
            savePriorities(p);
          }}
        />
      )}
      {report.policy && <NextSteps report={report} priorities={priorities} />}
      <Topics report={report} priorities={priorities} />
      <ClickTestSection report={report} />
      <CookieTable report={report} />
      <HowTested report={report} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Panel />
  </StrictMode>,
);
