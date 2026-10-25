import type { PriorityKey, Report } from "../api";
import { nextSteps, PRIORITY_INFO, type Priorities, type Weight } from "../priorities";
import { QuoteBlock } from "./Evidence";

const LEVELS: { w: Weight; label: string }[] = [
  { w: 0, label: "Not a concern" },
  { w: 1, label: "Matters" },
  { w: 2, label: "Matters a lot" },
];

export function PrioritiesForm({ value, onChange }: { value: Priorities; onChange: (p: Priorities) => void }) {
  return (
    <section aria-labelledby="prio-title" className="bg-paper px-5 py-6 sm:px-8">
      <h2 id="prio-title" className="text-[20px] font-extrabold">What matters to you</h2>
      <p className="mt-1 text-[14px] text-ink-2">This reorders the facts panel and your next steps. It's saved in this browser only.</p>
      <div className="mt-4 border-t border-ink">
        {(Object.keys(PRIORITY_INFO) as PriorityKey[]).map((k) => (
          <fieldset key={k} className="grid gap-2 border-b border-line py-3 md:grid-cols-[1fr_auto] md:items-center md:gap-6">
            <legend className="sr-only">{PRIORITY_INFO[k].label}</legend>
            <div aria-hidden="true">
              <div className="font-bold">{PRIORITY_INFO[k].label}</div>
              <div className="text-[13px] text-ink-2">{PRIORITY_INFO[k].hint}</div>
            </div>
            <div className="inline-flex w-full border border-ink md:w-auto" role="radiogroup" aria-label={PRIORITY_INFO[k].label}>
              {LEVELS.map(({ w, label }) => {
                const on = value[k] === w;
                return (
                  <label
                    key={w}
                    className={`flex-1 cursor-pointer whitespace-nowrap px-3 py-2 text-center text-[13px] font-semibold transition-colors has-focus-visible:outline-3 has-focus-visible:outline-evidence md:flex-none ${
                      on ? "bg-ink text-white" : "bg-paper text-ink hover:bg-ground"
                    } ${w ? "border-l border-ink" : ""}`}
                  >
                    <input type="radio" className="sr-only" name={`prio-${k}`} checked={on} onChange={() => onChange({ ...value, [k]: w })} />
                    {label}
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>
    </section>
  );
}

export function NextSteps({ report, priorities }: { report: Report; priorities: Priorities }) {
  const steps = nextSteps(report, priorities).slice(0, 5);
  return (
    <section aria-labelledby="steps-title" className="bg-paper px-5 py-6 sm:px-8">
      <h2 id="steps-title" className="text-[20px] font-extrabold">What you can do</h2>
      <p className="mt-1 text-[14px] text-ink-2">Choices the policy itself describes come first. You decide whether to use them.</p>
      {steps.length === 0 ? (
        <p className="mt-4 border-t border-ink pt-3 text-[14px] text-ink-2">
          Nothing to suggest for the priorities you set. Raise one above to see options.
        </p>
      ) : (
        <ol className="mt-4 border-t border-ink">
          {steps.map((s) => (
            <li key={s.title} className="border-b border-line py-4">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h3 className="text-[16px] font-bold">{s.title}</h3>
                <span className={`text-[12px] font-semibold ${s.source === "policy" ? "text-evidence" : "text-ink-3"}`}>
                  {s.source === "policy" ? "From the policy" : "General tip"}
                </span>
              </div>
              <p className="mt-1 max-w-[70ch] break-words text-[14px] text-ink-2">{s.detail}</p>
              {s.optOut?.quotes[0] && <QuoteBlock q={s.optOut.quotes[0]} url={report.policy?.source.url} />}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
