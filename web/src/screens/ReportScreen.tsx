import { useEffect, useMemo, useState } from "react";
import { api, type Report } from "../api";
import { TopBar } from "../components/TopBar";
import { FactsPanel } from "../components/FactsPanel";
import { Evidence } from "../components/Evidence";
import { NextSteps, PrioritiesForm } from "../components/Personal";
import { NoGoSection } from "../components/NoGos";
import { CookieTable, HowTested, Topics } from "../components/Details";
import { loadPriorities, rankComparisons, savePriorities, type Priorities } from "../priorities";
import { siteName } from "../words";

export function ReportScreen({ id }: { id: string }) {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [priorities, setPriorities] = useState<Priorities>(loadPriorities);
  const [selected, setSelected] = useState<string | undefined>();

  useEffect(() => {
    setReport(null);
    setError(null);
    api.report(id).then(setReport, (e) => setError(e instanceof Error ? e.message : "Couldn't load the report."));
  }, [id]);

  const ranked = useMemo(() => (report ? rankComparisons(report.comparisons, priorities) : []), [report, priorities]);
  const current = ranked.find((c) => c.key === selected) ?? ranked[0];

  function updatePriorities(p: Priorities) {
    setPriorities(p);
    savePriorities(p);
  }

  function select(key: string) {
    setSelected(key);
    if (window.matchMedia("(max-width: 1023px)").matches) document.getElementById("evidence")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <>
      <TopBar>
        {report && <span className="rounded-md bg-[#2a2a2a] px-3.5 py-1.5 text-[15px] font-semibold">{siteName(report.site)}</span>}
        <a href="#/" className="ml-auto bg-white px-3.5 py-1.5 text-[14px] font-bold text-ink no-underline hover:bg-ground">
          Check another site
        </a>
      </TopBar>
      <main id="main" className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 sm:px-8 lg:py-8">
        {error ? (
          <div role="alert" className="max-w-[640px] border-2 border-ink bg-paper p-6">
            <h1 className="text-[22px] font-extrabold">This report isn't available</h1>
            <p className="mt-2 text-ink-2">{error}</p>
            <a href="#/" className="mt-4 inline-block bg-ink px-4 py-2.5 font-bold text-white no-underline">Start a new check</a>
          </div>
        ) : !report ? (
          <div className="grid gap-6 lg:grid-cols-[440px_1fr]" aria-busy="true" aria-label="Loading report">
            <div className="h-[560px] animate-pulse bg-ground-2" />
            <div className="h-[560px] animate-pulse bg-ground-2" />
          </div>
        ) : (
          <div className="grid gap-6">
          <NoGoSection report={report} />
          <div className="grid items-start gap-6 lg:grid-cols-[440px_minmax(0,1fr)]">
            <div className="lg:sticky lg:top-6">
              <FactsPanel report={report} ranked={ranked} selected={current?.key} onSelect={select} />
            </div>
            <div className="grid min-w-0 gap-6">
              <div id="evidence" className="scroll-mt-4">
                {current ? (
                  <Evidence key={current.key} c={current} report={report} />
                ) : (
                  <NoComparisons report={report} />
                )}
              </div>
              {report.policy && <PrioritiesForm value={priorities} onChange={updatePriorities} />}
              {report.policy && <NextSteps report={report} priorities={priorities} />}
              <Topics report={report} priorities={priorities} />
              <CookieTable report={report} />
              <HowTested report={report} />
            </div>
          </div>
          </div>
        )}
      </main>
    </>
  );
}

function NoComparisons({ report }: { report: Report }) {
  const s = report.audit?.summary;
  return (
    <article className="bg-paper px-5 py-6 sm:px-8 sm:py-7">
      <h2 className="max-w-[34ch] text-[26px] font-extrabold leading-tight">We tested the site, but couldn't read its privacy policy</h2>
      <p className="mt-3 max-w-[68ch] text-ink-2">{report.policyError ?? "Without the policy there are no promises to compare."} The cookie results below still show what the site does.</p>
      {s?.baseline && s.gpc && (
        <p className="mt-4 max-w-[68ch] text-[16px]">
          Advertising cookies on every visit: <strong>{s.baseline.stable.advertising}</strong> with a default browser, <strong>{s.gpc.stable.advertising}</strong> with Global Privacy Control on.
        </p>
      )}
      {!/API_KEY|API key/i.test(report.policyError ?? "") && (
        <a href="#/" className="mt-5 inline-block border-2 border-ink px-4 py-2 font-bold text-ink no-underline hover:bg-ground">
          Try again with the policy link or text
        </a>
      )}
    </article>
  );
}
