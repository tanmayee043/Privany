import { useState } from "react";
import { ExternalLink } from "lucide-react";
import type { Comparison, ConfigSummary, ObservedCookie, Quote, Report } from "../api";
import { CATEGORY, quoteLink, VERDICT } from "../words";

export function Evidence({ c, report }: { c: Comparison; report: Report }) {
  const gap = c.verdict === "possible_gap";
  return (
    <article aria-labelledby="ev-title" className="bg-paper px-5 py-6 sm:px-8 sm:py-7">
      <p className={`flex items-center gap-2.5 text-[13px] font-bold ${gap ? "text-gap" : "text-ink-2"}`}>
        <i className={`mark mark-${c.verdict}`} aria-hidden="true" />
        {VERDICT[c.verdict].short}
        <span className="font-normal text-ink-3">· {c.title}</span>
      </p>
      <h2 id="ev-title" className="mt-2 max-w-[34ch] text-balance text-[26px] font-extrabold leading-[1.2] tracking-[-0.01em] sm:text-[30px]">
        {c.headline}
      </h2>
      <p className="mt-3 max-w-[68ch] text-[16px] text-ink-2">{c.explanation}</p>

      <PolicySays c={c} report={report} />

      {c.observed && (c.observed.baseline || c.observed.gpc) && <Counts c={c} />}

      {c.observed?.cookies && c.observed.cookies.length > 0 && <CookieList cookies={c.observed.cookies} />}

      {c.caveats.length > 0 && (
        <div className="mt-6 max-w-[72ch]">
          <h3 className="text-[13px] font-bold uppercase tracking-[0.08em] text-ink-2">Keep in mind</h3>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[14px] text-ink-2 marker:text-ink-3">
            {c.caveats.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

function PolicySays({ c, report }: { c: Comparison; report: Report }) {
  const url = report.policy?.source.url;
  return (
    <div className="mt-6 max-w-[72ch]">
      <h3 className="text-[13px] font-bold uppercase tracking-[0.08em] text-ink-2">What the policy says</h3>
      <p className="mt-1.5 text-[15px]">{c.claim.summary}</p>
      {c.claim.unsupported && (
        <p className="mt-2 text-[13px] font-semibold text-ink-2">The analysis gave an answer here, but none of its quotes appeared in the policy, so we treat it as not stated.</p>
      )}
      {c.claim.quotes.map((q) => (
        <QuoteBlock key={q.blockId + q.text} q={q} url={url} />
      ))}
    </div>
  );
}

export function QuoteBlock({ q, url }: { q: Quote; url?: string }) {
  const link = quoteLink(url, q.text);
  return (
    <figure className="mt-3">
      <blockquote className="border-l-[3px] border-evidence pl-4 text-[17px] leading-[1.65] text-ink">“{q.text}”</blockquote>
      <figcaption className="mt-1 pl-4 text-[13px] text-ink-3">
        {q.section ? `From the policy, “${q.section}”` : "From the policy"}
        {link && (
          <>
            {" · "}
            <a href={link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold text-evidence">
              Open at this sentence <ExternalLink size={13} aria-hidden="true" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </>
        )}
      </figcaption>
    </figure>
  );
}

function range(s: ConfigSummary, pick: (t: ConfigSummary["min"]) => number): string {
  const lo = pick(s.min);
  const hi = pick(s.max);
  return lo === hi ? `${lo} on each visit` : `${lo}–${hi} per visit`;
}

function Counts({ c }: { c: Comparison }) {
  const { baseline, gpc } = c.observed!;
  const ads = (t: ConfigSummary["min"]) => t.advertising;
  const cells: { label: string; value: number; sub: string }[] = [];
  if (baseline) cells.push({ label: "Ad cookies, default browser", value: baseline.stable.advertising, sub: range(baseline, ads) });
  if (gpc) cells.push({ label: "Ad cookies, GPC on", value: gpc.stable.advertising, sub: range(gpc, ads) });
  if (c.observed!.cookies) cells.push({ label: "Cookies behind this result", value: c.observed!.cookies.length, sub: "listed below" });
  return (
    <div className="mt-6">
      <h3 className="text-[13px] font-bold uppercase tracking-[0.08em] text-ink-2">What the browser saw</h3>
      <dl className="rule-div mt-2 grid max-w-[760px] grid-cols-1 sm:grid-cols-3">
        {cells.map((x, i) => (
          <div key={x.label} className={`py-3 ${i ? "rule-line sm:border-t-0 sm:border-l sm:border-ink sm:pl-5" : ""}`}>
            <dt className="text-[13px] text-ink-2">{x.label}</dt>
            <dd className="text-[34px] font-extrabold leading-tight">{x.value}</dd>
            <dd className="text-[12px] text-ink-3">{x.sub}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-1 text-[12px] text-ink-3">Counts are cookies written on every visit of that kind, so one-off ad auctions don't skew the result.</p>
    </div>
  );
}

function CookieList({ cookies }: { cookies: ObservedCookie[] }) {
  const [open, setOpen] = useState(false);
  const byOwner = new Map<string, ObservedCookie[]>();
  for (const ck of cookies) {
    const k = ck.platform ?? ck.domain;
    byOwner.set(k, [...(byOwner.get(k) ?? []), ck]);
  }
  const owners = [...byOwner.entries()].sort((a, b) => b[1].length - a[1].length);
  const shown = open ? owners : owners.slice(0, 6);
  return (
    <div className="mt-5 max-w-[760px]">
      <h3 className="text-[13px] font-bold uppercase tracking-[0.08em] text-ink-2">Who set them</h3>
      <ul className="mt-2 border-t border-ink">
        {shown.map(([owner, cs]) => (
          <li key={owner} className="flex flex-wrap items-baseline gap-x-3 border-b border-line py-2">
            <span className="font-bold">{owner}</span>
            <span className="text-[13px] text-ink-2">
              {cs.length} cookie{cs.length === 1 ? "" : "s"} · {CATEGORY[cs[0].category].toLowerCase()} · {cs[0].thirdParty ? "outside company" : "the site itself"}
            </span>
            <span className="ml-auto truncate text-[12px] text-ink-3">{cs.map((x) => x.name).slice(0, 4).join(", ")}</span>
          </li>
        ))}
      </ul>
      {owners.length > 6 && (
        <button type="button" onClick={() => setOpen((o) => !o)} className="mt-2 text-[14px] font-semibold text-evidence hover:underline">
          {open ? "Show fewer" : `Show all ${owners.length} companies`}
        </button>
      )}
    </div>
  );
}
