import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, ChevronDown } from "lucide-react";
import { api } from "../api";
import { go } from "../App";
import { TopBar } from "../components/TopBar";
import { formatDate, siteName } from "../words";

type Recent = Awaited<ReturnType<typeof api.reports>>;

export function Home() {
  const [url, setUrl] = useState("");
  const [showPolicy, setShowPolicy] = useState(false);
  const [policyUrl, setPolicyUrl] = useState("");
  const [policyText, setPolicyText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [recent, setRecent] = useState<Recent | null>(null);

  useEffect(() => {
    api.reports().then(setRecent, () => setRecent([]));
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!url.trim()) {
      setError("Enter a website address, like example.com.");
      return;
    }
    setSubmitting(true);
    try {
      const job = await api.analyze({ url, policyUrl: policyUrl || undefined, policyText: policyText || undefined });
      go(`#/run/${job.id}?site=${encodeURIComponent(url.trim())}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start the check. Is the Privany server running?");
      setSubmitting(false);
    }
  }

  return (
    <>
      <TopBar>
        <span className="ml-auto text-[13px] text-[#c9ced6]">Checks a site's privacy promises against what it does</span>
      </TopBar>
      <main id="main" className="mx-auto grid w-full max-w-[1440px] flex-1 gap-8 px-4 py-8 sm:px-8 lg:grid-cols-[minmax(0,640px)_minmax(0,1fr)] lg:py-12">
        <section aria-labelledby="facts-title" className="border-2 border-ink bg-paper px-5 pb-5 pt-4 sm:px-7">
          <h1 id="facts-title" className="font-label text-[44px] font-bold leading-none tracking-[-0.01em] sm:text-[64px]">
            Privacy Facts
          </h1>
          <p className="pb-3 pt-2 text-[16px] text-ink-2">What a website promises about your data, and what it actually does.</p>

          <form onSubmit={submit} noValidate className="rule-bar pt-4">
            <label htmlFor="site" className="block text-[14px] font-bold">
              Website to check
            </label>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input
                id="site"
                name="site"
                inputMode="url"
                autoComplete="url"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="example.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? "site-error" : undefined}
                className="h-12 min-w-0 flex-1 border-2 border-ink bg-paper px-3 text-[17px] placeholder:text-ink-3/70 focus:outline-none focus-visible:outline-3 focus-visible:outline-evidence"
              />
              <button
                type="submit"
                disabled={submitting}
                className="flex h-12 items-center justify-center gap-2 bg-ink px-5 text-[16px] font-bold text-white transition-colors hover:bg-[#2b2b2b] disabled:cursor-progress disabled:opacity-70"
              >
                {submitting ? "Starting…" : "Check this site"}
                <ArrowRight size={18} aria-hidden="true" />
              </button>
            </div>
            {error && (
              <p id="site-error" role="alert" className="mt-2 text-[14px] font-semibold text-gap">
                {error}
              </p>
            )}

            <div className="rule-line mt-4">
              <button
                type="button"
                onClick={() => setShowPolicy((s) => !s)}
                aria-expanded={showPolicy}
                aria-controls="policy-fields"
                className="flex w-full items-center justify-between py-2.5 text-left text-[14px] font-semibold hover:text-evidence"
              >
                Already have the policy link or text? (optional)
                <ChevronDown size={18} aria-hidden="true" className={`transition-transform duration-200 ${showPolicy ? "rotate-180" : ""}`} />
              </button>
              {showPolicy && (
                <div id="policy-fields" className="grid gap-3 pb-2">
                  <label className="grid gap-1 text-[14px] font-semibold">
                    Privacy policy link
                    <input
                      inputMode="url"
                      spellCheck={false}
                      placeholder="https://example.com/privacy"
                      value={policyUrl}
                      onChange={(e) => setPolicyUrl(e.target.value)}
                      className="h-11 border border-ink bg-paper px-3 font-normal"
                    />
                  </label>
                  <label className="grid gap-1 text-[14px] font-semibold">
                    Or paste the policy text
                    <textarea
                      rows={4}
                      value={policyText}
                      onChange={(e) => setPolicyText(e.target.value)}
                      className="border border-ink bg-paper px-3 py-2 font-normal"
                    />
                  </label>
                </div>
              )}
            </div>
          </form>

          <dl className="rule-div mt-1">
            {[
              ["Reads the policy", "Finds each promise about your data and the exact sentence it comes from."],
              ["Visits the site", "Twice normally and twice with Global Privacy Control on, recording every tracking cookie."],
              ["Compares the two", "Shows where they match, where they don't, and what you can do."],
            ].map(([t, d]) => (
              <div key={t} className="rule-line grid gap-1 py-2.5 first:border-t-0 sm:grid-cols-[170px_1fr] sm:gap-4">
                <dt className="font-bold">{t}</dt>
                <dd className="text-[14px] text-ink-2">{d}</dd>
              </div>
            ))}
          </dl>
          <p className="rule-div pt-2 text-[12px] leading-snug text-ink-2">
            About a minute per site. Results describe what a browser can observe; they aren't legal findings. Measurement method from PrivAudit (ACM CCS 2026).
          </p>
        </section>

        <section aria-labelledby="recent-title" className="lg:pt-2">
          <h2 id="recent-title" className="text-[13px] font-bold uppercase tracking-[0.08em] text-ink-2">
            Recent checks
          </h2>
          {recent === null ? (
            <div className="mt-3 grid gap-2" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-14 animate-pulse bg-ground-2" />
              ))}
            </div>
          ) : recent.length === 0 ? (
            <p className="mt-3 max-w-md text-[14px] text-ink-2">No checks yet. Try a site you use every day, like a news site or a recipe site; those tend to have the most trackers.</p>
          ) : (
            <ul className="mt-3 divide-y divide-line border-y border-line">
              {recent.slice(0, 8).map((r) => (
                <li key={r.id}>
                  <a href={`#/report/${r.id}`} className="flex items-center gap-4 px-1 py-3.5 no-underline hover:bg-paper/60">
                    <span className="min-w-0 flex-1 truncate text-[16px] font-bold text-ink">{siteName(r.site)}</span>
                    <span className={`text-[13px] font-semibold ${r.gaps ? "text-gap" : "text-ink-2"}`}>
                      {r.gaps ? `${r.gaps} possible gap${r.gaps === 1 ? "" : "s"}` : "No gaps found"}
                    </span>
                    <span className="hidden w-28 text-right text-[13px] text-ink-3 sm:block">{formatDate(r.createdAt)}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}
