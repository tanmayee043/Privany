import { useMemo, useState } from "react";
import type { CookieCategory, Report, TopicKey } from "../api";
import { TOPIC_PRIORITY, type Priorities } from "../priorities";
import { CATEGORY, formatDate, TOPIC_STATUS, TOPIC_TITLE } from "../words";
import { QuoteBlock } from "./Evidence";

export function Topics({ report, priorities }: { report: Report; priorities: Priorities }) {
  const topics = report.policy?.topics ?? [];
  const [open, setOpen] = useState<TopicKey | null>(null);
  if (!topics.length) return null;
  const weight = (k: TopicKey) => (TOPIC_PRIORITY[k] ? priorities[TOPIC_PRIORITY[k]!] : 0);
  const sorted = [...topics].sort((a, b) => weight(b.key) - weight(a.key));
  return (
    <section aria-labelledby="topics-title" className="bg-paper px-5 py-6 sm:px-8">
      <h2 id="topics-title" className="text-[20px] font-extrabold">Everything else the policy says</h2>
      <p className="mt-1 text-[14px] text-ink-2">Plain-language summaries, each backed by the policy's own words. "Vague" means it's mentioned without specifics.</p>
      <ul className="mt-4 border-t border-ink">
        {sorted.map((t) => {
          const isOpen = open === t.key;
          return (
            <li key={t.key} className="border-b border-line">
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : t.key)}
                className="grid w-full grid-cols-[1fr_auto] items-baseline gap-x-4 py-3 text-left hover:text-evidence"
              >
                <span className="font-bold">{TOPIC_TITLE[t.key]}</span>
                <span className={`text-[13px] font-semibold ${t.status === "stated" ? "text-ink" : "text-ink-3"}`}>{TOPIC_STATUS[t.status]}</span>
                <span className="col-span-2 mt-0.5 max-w-[75ch] text-[14px] font-normal text-ink-2">{t.summary}</span>
              </button>
              {isOpen && (
                <div className="pb-4">
                  {t.quotes.length ? t.quotes.map((q) => <QuoteBlock key={q.blockId + q.text} q={q} url={report.policy?.source.url} />) : <p className="text-[13px] text-ink-3">No sentence in the policy addresses this.</p>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

type Filter = "tracking" | "outside" | "all";

export function CookieTable({ report }: { report: Report }) {
  const [filter, setFilter] = useState<Filter>("tracking");
  const [showAll, setShowAll] = useState(false);
  const rows = useMemo(() => {
    const audit = report.audit;
    if (!audit) return [];
    const map = new Map<string, { name: string; domain: string; owner: string; category: CookieCategory; thirdParty: boolean; baseline: number; gpc: number; consent?: string }>();
    for (const run of audit.runs) {
      if (!run.ok) continue;
      for (const c of run.cookies) {
        const key = `${c.name}@${c.domain}`;
        const row = map.get(key) ?? { name: c.name, domain: c.domain, owner: c.platform ?? c.domain, category: c.category, thirdParty: c.thirdParty, baseline: 0, gpc: 0 };
        row[run.config] += 1;
        if (c.consentValue && run.config === "gpc") row.consent = c.consentValue;
        map.set(key, row);
      }
    }
    const order: CookieCategory[] = ["advertising", "analytics", "unknown", "functional", "necessary"];
    return [...map.values()].sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || Number(b.thirdParty) - Number(a.thirdParty) || a.owner.localeCompare(b.owner));
  }, [report]);
  if (!report.audit) return null;
  const runs = (k: "baseline" | "gpc") => report.audit!.runs.filter((r) => r.ok && r.config === k).length;
  const nb = runs("baseline");
  const ng = runs("gpc");
  const filtered = rows.filter((r) => (filter === "all" ? true : filter === "outside" ? r.thirdParty : r.category === "advertising" || r.category === "analytics"));
  const visible = showAll ? filtered : filtered.slice(0, 40);
  const cell = (n: number, of: number) => (n === 0 ? <span className="text-ink-3">–</span> : n === of ? "Every visit" : `${n} of ${of}`);

  return (
    <section aria-labelledby="cookies-title" className="bg-paper px-5 py-6 sm:px-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="cookies-title" className="text-[20px] font-extrabold">Every cookie we saw</h2>
          <p className="mt-1 text-[14px] text-ink-2">{rows.length} cookies across {nb + ng} visits. Purposes come from the Open Cookie Database.</p>
        </div>
        <div className="inline-flex border border-ink" role="group" aria-label="Filter cookies">
          {(
            [
              ["tracking", "Tracking"],
              ["outside", "Outside companies"],
              ["all", "All"],
            ] as const
          ).map(([f, label], i) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 text-[13px] font-semibold ${i ? "border-l border-ink" : ""} ${filter === f ? "bg-ink text-white" : "hover:bg-ground"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {filtered.length === 0 ? (
        <p className="mt-4 border-t border-ink pt-3 text-[14px] text-ink-2">No cookies in this group.</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-left text-[14px]">
            <caption className="sr-only">Cookies by visit type</caption>
            <thead>
              <tr className="border-b-[3px] border-ink text-[12px] uppercase tracking-[0.06em] text-ink-2">
                <th scope="col" className="py-2 pr-3 font-bold">Set by</th>
                <th scope="col" className="py-2 pr-3 font-bold">Cookie</th>
                <th scope="col" className="py-2 pr-3 font-bold">Purpose</th>
                <th scope="col" className="py-2 pr-3 font-bold">Default browser</th>
                <th scope="col" className="py-2 font-bold">GPC on</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.name + r.domain} className="border-b border-line align-top">
                  <td className="py-2 pr-3">
                    <span className="font-semibold">{r.owner}</span>
                    <span className="block text-[12px] text-ink-3">{r.thirdParty ? "Outside company" : "This site"}</span>
                  </td>
                  <td className="max-w-[220px] break-all py-2 pr-3 text-ink-2">
                    {r.name}
                    {r.consent && <span className="block text-[12px] text-evidence">Saved choice: {r.consent}</span>}
                  </td>
                  <td className="py-2 pr-3">{CATEGORY[r.category]}</td>
                  <td className="py-2 pr-3">{cell(r.baseline, nb)}</td>
                  <td className="py-2">{cell(r.gpc, ng)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {filtered.length > 40 && (
        <button type="button" onClick={() => setShowAll((s) => !s)} className="mt-3 text-[14px] font-semibold text-evidence hover:underline">
          {showAll ? "Show fewer" : `Show all ${filtered.length}`}
        </button>
      )}
    </section>
  );
}

export function HowTested({ report }: { report: Report }) {
  const a = report.audit;
  const p = report.policy;
  const facts: [string, string][] = [];
  if (a) {
    facts.push(["Browser", `${a.browserVersion}, a fresh profile for every visit`]);
    facts.push(["Visits", `${a.runs.length} to the homepage, alternating default and GPC on; ${a.runs.filter((r) => !r.ok).length || "none"} failed`]);
    facts.push(["GPC signal", "Sec-GPC: 1 header and navigator.globalPrivacyControl, as in PrivAudit (ACM CCS 2026)"]);
    facts.push(["Consent banner", a.consentBanner.detected ? `Shown${a.consentBanner.vendor ? ` (${a.consentBanner.vendor})` : ""}; we didn't click it` : "None detected"]);
    facts.push(["gpc.json", a.gpcJson.found ? (a.gpcJson.gpc ? "Published, declares GPC support" : "Published, doesn't declare support") : "Not published"]);
    if (a.homepageLinks.optOut.length) facts.push(["Opt-out links on homepage", a.homepageLinks.optOut.map((o) => o.text).join(", ")]);
  }
  if (p) {
    facts.push(["Policy", `${p.source.title ?? p.source.url ?? "Pasted text"}${p.source.truncated ? " (only the first part was analyzed)" : ""}`]);
    facts.push(["Policy read", `${formatDate(p.source.retrievedAt)} by ${p.model}; ${p.evidence.verified} of ${p.evidence.proposed} quotes verified word for word`]);
  }
  return (
    <section aria-labelledby="how-title" className="bg-paper px-5 py-6 sm:px-8">
      <h2 id="how-title" className="text-[20px] font-extrabold">How we tested</h2>
      <dl className="mt-4 border-t border-ink">
        {facts.map(([k, v]) => (
          <div key={k} className="grid gap-1 border-b border-line py-2.5 sm:grid-cols-[200px_1fr] sm:gap-6">
            <dt className="font-bold">{k}</dt>
            <dd className="break-words text-[14px] text-ink-2">{v}</dd>
          </div>
        ))}
      </dl>
      {p && p.injectionWarnings.length > 0 && (
        <p className="mt-4 text-[14px] font-semibold text-gap">
          The policy contains text addressed to AI tools. We treated it as part of the document, not as instructions: “{p.injectionWarnings[0].slice(0, 160)}”
        </p>
      )}
      <h3 className="mt-6 text-[13px] font-bold uppercase tracking-[0.08em] text-ink-2">Limits</h3>
      <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[14px] text-ink-2 marker:text-ink-3">
        {report.limitations.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </section>
  );
}
