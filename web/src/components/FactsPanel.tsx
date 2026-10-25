import type { Comparison, Report } from "../api";
import { formatDate, siteName, VERDICT } from "../words";

export function FactsPanel({ report, ranked, selected, onSelect }: { report: Report; ranked: Comparison[]; selected?: string; onSelect: (key: string) => void }) {
  const s = report.audit?.summary;
  const policy = report.policy;
  const gaps = ranked.filter((c) => c.verdict === "possible_gap").length;
  const outsideGpc = s?.gpc?.stableCookies.filter((c) => c.thirdParty && (c.category === "advertising" || c.category === "analytics")).length;
  // "None contradicted" reads as good news; when the policy promises nothing, say that instead.
  const promisesNothing = ranked.length > 0 && ranked.every((c) => c.verdict === "not_stated");
  const summary = gaps
    ? `${gaps} need${gaps === 1 ? "s" : ""} a closer look.`
    : promisesNothing
      ? "This policy makes no clear promises on any of these, so there's nothing to hold the site to."
      : "None contradicted by what we saw.";
  // Every default visit is made without touching any banner, so these cookies came before any agreement.
  const beforeConsent = s?.baseline ? s.baseline.stable.advertising + s.baseline.stable.analytics : 0;
  const outsideDomains = s?.baseline?.stableHosts?.length;
  const click = report.audit?.clickTest;
  const clickPopups = click?.ok ? click.popups : [];

  return (
    <section aria-labelledby="panel-title" className="border-2 border-ink bg-paper px-5 pb-4 pt-3.5 sm:px-6">
      <h1 id="panel-title" className="font-label text-[40px] font-bold leading-none tracking-[-0.01em] sm:text-[46px]">
        Privacy Facts
      </h1>
      <p className="pb-2 pt-1.5 text-[14px] text-ink-2">
        <strong className="text-ink">{siteName(report.site)}</strong> · checked {formatDate(report.createdAt)}
      </p>
      {beforeConsent > 0 && (
        <p className="mb-2 bg-ground px-3 py-2.5 text-[15px] font-bold leading-snug">
          {beforeConsent} tracking cookie{beforeConsent === 1 ? " was" : "s were"} set before you agreed to anything.
          <span className="mt-0.5 block text-[13px] font-normal text-ink-2">Seen on every default visit, without clicking any banner.</span>
        </p>
      )}
      {click?.ok && (clickPopups.length > 0 || click.redirectedTo) && (
        <a href="#click-test" className="mb-2 block bg-ground px-3 py-2.5 text-[15px] font-bold leading-snug text-ink no-underline hover:bg-ground-2">
          {clickWhat(click)} {clickPopups.length > 0 ? `opened ${clickPopups.length} pop-up window${clickPopups.length === 1 ? "" : "s"}` : ""}
          {clickPopups.length > 0 && click.redirectedTo ? " and " : ""}
          {click.redirectedTo ? `sent the page to ${new URL(click.redirectedTo).hostname}` : ""}.
          <span className="mt-0.5 block text-[13px] font-normal text-ink-2">
            {clickPopups.length > 0 && `To ${[...new Set(clickPopups.map((p) => p.host))].slice(0, 3).join(", ")}. `}Our test browser blocked them before they loaded.
          </span>
        </a>
      )}

      <div className="rule-bar flex items-baseline justify-between pt-1.5">
        <span className="text-[14px] font-bold">Promises checked</span>
        <span className="text-[14px] font-bold">{policy ? ranked.length : "–"}</span>
      </div>
      {policy ? (
        <>
          <p className="pb-1 text-[13px] text-ink-2">
            {summary} Ordered by what matters to you.
          </p>
          <ul className="rule-div" aria-label="Promises and results">
            {ranked.map((c) => {
              const active = c.key === selected;
              return (
                <li key={c.key} className="rule-line first:border-t-0">
                  <button
                    type="button"
                    onClick={() => onSelect(c.key)}
                    aria-current={active ? "true" : undefined}
                    className={`-mx-5 grid w-[calc(100%+2.5rem)] grid-cols-[22px_1fr_auto] items-center gap-x-3 px-5 py-2.5 text-left transition-colors sm:-mx-6 sm:w-[calc(100%+3rem)] sm:px-6 ${
                      active ? "bg-evidence-tint" : "hover:bg-ground/60"
                    }`}
                  >
                    <i className={`mark mark-${c.verdict}`} aria-hidden="true" />
                    <span className="text-[15px] font-bold leading-snug">{c.title}</span>
                    <span className={`text-right text-[13px] font-semibold ${c.verdict === "possible_gap" ? "text-gap" : "text-ink-2"}`}>{VERDICT[c.verdict].short}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <p className="rule-div py-2 text-[14px] text-ink-2">
          <strong className="block text-ink">The policy wasn't read.</strong>
          {report.policyError ?? "No policy analysis is available."}
        </p>
      )}

      <div className="rule-div mt-0.5 pt-1.5 text-[14px] font-bold">Tracking cookies, every visit</div>
      {s ? (
        <dl className="text-[14px]">
          <Row label="Default browser" value={s.baseline ? s.baseline.stable.advertising + s.baseline.stable.analytics : undefined} />
          <Row label="With GPC on" value={s.gpc ? s.gpc.stable.advertising + s.gpc.stable.analytics : undefined} />
          <Row label="From outside companies, GPC on" value={outsideGpc} indent />
          {outsideDomains !== undefined && <Row label="Outside domains contacted, every visit" value={outsideDomains} />}
        </dl>
      ) : (
        <p className="rule-line py-2 text-[14px] text-ink-2">{report.auditError ?? "The browser test didn't run."}</p>
      )}

      <p className="rule-div mt-0.5 pt-2 text-[12px] leading-snug text-ink-2">
        {policy && `${policy.evidence.verified} of ${policy.evidence.proposed} quotes found word for word in the policy; the rest were discarded. `}
        {(report.audit?.runs[0]?.pagesVisited?.length ?? 1) > 1 ? "Homepage and one inner page, scrolled; clicks only in the separate click and banner tests." : "Homepage only, no clicks."} A possible gap is a reason to look closer, not proof of wrongdoing.
      </p>
    </section>
  );
}

/** "Clicking “Play”" / "Clicking the video player" / "Clicking the page", for sentences about the click test. */
export function clickWhat(click: NonNullable<NonNullable<Report["audit"]>["clickTest"]>): string {
  const t = click.target;
  if (!t || t.kind === "page_center") return "Clicking the page";
  if (t.kind === "video_player") return "Clicking the video player";
  return `Clicking “${t.label ?? "Play"}”`;
}

function Row({ label, value, indent }: { label: string; value?: number; indent?: boolean }) {
  return (
    <div className="rule-line flex items-baseline justify-between gap-4 py-1.5">
      <dt className={indent ? "pl-4 text-ink-2" : ""}>{label}</dt>
      <dd className="font-bold">{value ?? "–"}</dd>
    </div>
  );
}
