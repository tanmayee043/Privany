import { useEffect, useRef, useState } from "react";
import { api, type JobStatus } from "../api";
import { go } from "../App";
import { TopBar } from "../components/TopBar";
import { siteName } from "../words";

const STATE_TEXT: Record<JobStatus["steps"][number]["state"], string> = {
  pending: "Waiting",
  running: "Working",
  done: "Done",
  skipped: "Skipped",
  failed: "Failed",
};

export function Running({ jobId, site }: { jobId: string; site: string }) {
  const [job, setJob] = useState<JobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    let stop = false;
    let timer: number;
    const tick = async () => {
      try {
        const j = await api.job(jobId);
        if (stop) return;
        setJob(j);
        if (j.state === "done" && j.reportId) {
          go(`#/report/${j.reportId}`);
          return;
        }
        if (j.state === "failed") return;
      } catch (err) {
        if (!stop) setError(err instanceof Error ? err.message : "Lost contact with the server.");
        return;
      }
      timer = window.setTimeout(tick, 1500);
    };
    void tick();
    const clock = window.setInterval(() => setElapsed(Math.round((Date.now() - started.current) / 1000)), 1000);
    return () => {
      stop = true;
      window.clearTimeout(timer);
      window.clearInterval(clock);
    };
  }, [jobId]);

  const failed = job?.state === "failed" || error;

  return (
    <>
      <TopBar>
        <span className="rounded-md bg-[#2a2a2a] px-3.5 py-1.5 text-[15px] font-semibold">{siteName(site) || "Checking a site"}</span>
      </TopBar>
      <main id="main" className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-8 sm:px-8 lg:py-12">
        <section aria-labelledby="run-title" className="max-w-[640px] border-2 border-ink bg-paper px-5 pb-5 pt-4 sm:px-7">
          <h1 id="run-title" className="font-label text-[44px] font-bold leading-none sm:text-[56px]">
            Privacy Facts
          </h1>
          <p className="pb-3 pt-2 text-[16px] text-ink-2">
            {failed ? "The check stopped." : `Checking ${siteName(site) || "the site"}. This takes about a minute.`}
          </p>
          <ol className="rule-bar" aria-live="polite">
            {(job?.steps ?? []).map((s) => (
              <li key={s.key} className="rule-line grid grid-cols-[1fr_auto] gap-x-4 py-3 first:border-t-0">
                <span className={`font-bold ${s.state === "pending" ? "text-ink-3" : ""}`}>{s.label}</span>
                <span
                  className={`text-right text-[14px] font-semibold ${
                    s.state === "failed" ? "text-gap" : s.state === "running" ? "working text-evidence" : s.state === "pending" || s.state === "skipped" ? "text-ink-3" : ""
                  }`}
                >
                  {STATE_TEXT[s.state]}
                </span>
                {s.detail && (
                  <span key={s.detail} className={`print-in col-span-2 pt-0.5 text-[13px] ${s.state === "failed" ? "text-gap" : "text-ink-2"}`}>
                    {s.detail}
                  </span>
                )}
              </li>
            ))}
            {!job && !error && (
              <li className="py-3 text-ink-3" aria-busy="true">
                Connecting…
              </li>
            )}
          </ol>
          <div className="rule-div flex flex-wrap items-center justify-between gap-3 pt-3 text-[13px] text-ink-2">
            <span>{failed ? "" : `${elapsed}s elapsed`}</span>
            {failed && (
              <div role="alert" className="w-full">
                <p className="font-semibold text-gap">{error ?? job?.error ?? "Something went wrong."}</p>
                <a href="#/" className="mt-3 inline-block bg-ink px-4 py-2.5 text-[15px] font-bold text-white no-underline hover:bg-[#2b2b2b]">
                  Try another site
                </a>
              </div>
            )}
          </div>
        </section>
      </main>
    </>
  );
}
