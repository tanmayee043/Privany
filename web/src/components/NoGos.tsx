import { useEffect, useMemo, useState } from "react";
import type { Report } from "../api";
import { evaluateNoGos, loadNoGos, NO_GO_CATALOG, saveNoGos, summarizeNoGos, type NoGoId, type NoGoPrefs, type NoGoResult, type NoGoStatus } from "../nogos";
import { QuoteBlock } from "./Evidence";

/** Loads the saved no-goes (undefined until read) and saves changes on this device only. */
export function useNoGos(): [NoGoPrefs | undefined, (p: NoGoPrefs) => void] {
  const [prefs, setPrefs] = useState<NoGoPrefs | undefined>();
  useEffect(() => {
    let live = true;
    void loadNoGos().then((p) => live && setPrefs(p));
    return () => {
      live = false;
    };
  }, []);
  return [
    prefs,
    (p) => {
      setPrefs(p);
      void saveNoGos(p);
    },
  ];
}

export function NoGoSetup({ value, onChange, onDone, doneLabel = "Done" }: { value: NoGoPrefs; onChange: (p: NoGoPrefs) => void; onDone?: () => void; doneLabel?: string }) {
  const toggle = (id: NoGoId) => onChange({ ...value, selected: value.selected.includes(id) ? value.selected.filter((x) => x !== id) : [...value.selected, id] });
  return (
    <section aria-labelledby="nogo-setup" className="min-w-0 border-2 border-ink bg-paper px-4 pb-4 pt-3 sm:px-6">
      <h2 id="nogo-setup" className="font-label text-[26px] font-bold leading-none">Your no-goes</h2>
      <p className="pb-2 pt-1.5 text-[14px] text-ink-2">Pick the things you won't accept. Privany will tell you which ones a site breaks. Saved on this device only; never sent anywhere.</p>
      <fieldset className="rule-bar">
        <legend className="sr-only">No-goes</legend>
        {NO_GO_CATALOG.map((n) => (
          <label key={n.id} className="rule-line flex cursor-pointer items-start gap-3 py-2.5 first:border-t-0 has-focus-visible:outline-3 has-focus-visible:outline-evidence">
            <input type="checkbox" className="mt-1 size-4 shrink-0 accent-ink" checked={value.selected.includes(n.id)} onChange={() => toggle(n.id)} />
            <span>
              <span className="block text-[15px] font-bold leading-snug">{n.label}</span>
              <span className="block text-[13px] text-ink-2">{n.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="rule-div mt-1 flex cursor-pointer items-start gap-3 pt-2.5 has-focus-visible:outline-3 has-focus-visible:outline-evidence">
        <input type="checkbox" className="mt-1 size-4 shrink-0 accent-ink" checked={value.strict} onChange={() => onChange({ ...value, strict: !value.strict })} />
        <span>
          <span className="block text-[15px] font-bold leading-snug">Be strict</span>
          <span className="block text-[13px] text-ink-2">Count "the policy doesn't say" as breaking a no-go.</span>
        </span>
      </label>
      {onDone && (
        <button type="button" onClick={onDone} className="mt-4 bg-ink px-4 py-2 text-[14px] font-bold text-white hover:bg-[#2b2b2b]">
          {doneLabel}
        </button>
      )}
    </section>
  );
}

const STATUS: Record<NoGoStatus, { word: string; mark: string }> = {
  broken: { word: "Breaks your no-go", mark: "mark-possible_gap" },
  unknown: { word: "Policy doesn't say", mark: "mark-not_stated" },
  ok: { word: "Doesn't break it", mark: "mark-consistent" },
};

const BASIS = { policy: "From the policy", seen: "Seen in our test", both: "Policy and our test" } as const;

function Row({ r, url }: { r: NoGoResult; url?: string }) {
  const info = NO_GO_CATALOG.find((n) => n.id === r.id)!;
  const hasEvidence = r.quotes.length > 0 || Boolean(r.cookies?.length);
  const body = (
    <>
      <span className="grid grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-x-3">
        <i className={`mark ${STATUS[r.status].mark}`} aria-hidden="true" />
        <span className="text-[15px] font-bold leading-snug">{info.label}</span>
        <span className={`text-right text-[13px] font-semibold ${r.status === "broken" ? "text-gap" : "text-ink-2"}`}>{STATUS[r.status].word}</span>
      </span>
      <span className="mt-1 block break-words pl-[34px] text-[13px] text-ink-2">
        {r.explanation} <span className="text-ink-3">({BASIS[r.basis]})</span>
      </span>
    </>
  );
  return (
    <li className={`rule-line min-w-0 first:border-t-0 ${r.status === "broken" ? "border-l-[5px] border-l-gap pl-3" : ""}`}>
      {hasEvidence ? (
        <details className="group py-2.5">
          <summary className="cursor-pointer list-none has-focus-visible:outline-3 has-focus-visible:outline-evidence [&::-webkit-details-marker]:hidden">
            {body}
            <span className="mt-1 block pl-[34px] text-[13px] font-semibold text-evidence group-open:hidden">Show the evidence</span>
            <span className="mt-1 hidden pl-[34px] text-[13px] font-semibold text-evidence group-open:block">Hide the evidence</span>
          </summary>
          <div className="min-w-0 pl-[34px]">
            {r.quotes.map((q) => (
              <QuoteBlock key={`${q.blockId}-${q.text}`} q={q} url={url} />
            ))}
            {r.cookies && r.cookies.length > 0 && (
              <div className="mt-3">
                <p className="text-[13px] font-bold">Cookies seen in our test</p>
                <ul className="mt-1 text-[13px] text-ink-2">
                  {r.cookies.map((c) => (
                    <li key={`${c.name}@${c.domain}`} className="rule-line py-1 first:border-t-0">
                      <strong className="text-ink">{c.platform ?? c.domain}</strong> · <code className="break-all">{c.name}</code> · {c.category}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {(r.basis === "seen" || r.basis === "both") && r.cookies && (
              <p className="mt-2 text-[12px] text-ink-3">Our test covers only the homepage, with no logging in or clicking, and counts cookies only. A cookie alone doesn't prove what a company does with data.</p>
            )}
          </div>
        </details>
      ) : (
        <div className="py-2.5">{body}</div>
      )}
    </li>
  );
}

export function NoGoSummary({ report, prefs, onEdit }: { report: Report; prefs: NoGoPrefs; onEdit: () => void }) {
  const results = useMemo(() => evaluateNoGos(report, prefs.selected, { strict: prefs.strict }), [report, prefs]);
  if (!results.length) {
    return (
      <section className="flex flex-wrap items-center gap-x-4 gap-y-2 border-2 border-ink bg-paper px-4 py-3 sm:px-6">
        <p className="text-[14px] text-ink-2">Choose the things you won't accept, and Privany will tell you which ones this site breaks.</p>
        <button type="button" onClick={onEdit} className="bg-ink px-3 py-1.5 text-[13px] font-bold text-white hover:bg-[#2b2b2b]">
          Set up my no-goes
        </button>
      </section>
    );
  }
  const s = summarizeNoGos(results);
  return (
    <section aria-labelledby="nogo-title" className="min-w-0 border-2 border-ink bg-paper px-4 pb-3 pt-3 sm:px-6">
      <h2 id="nogo-title" className={`font-label text-[30px] font-bold leading-none ${s.broken ? "text-gap" : ""}`}>
        {s.headline}
      </h2>
      <p className="pb-2 pt-1.5 text-[13px] text-ink-2">
        {s.detail ? `${s.detail}. ` : ""}
        {prefs.strict && "Strict mode is on. "}
        <button type="button" onClick={onEdit} className="font-semibold text-evidence underline">Edit my no-goes</button>
      </p>
      <ul className="rule-bar" aria-label="Your no-goes and results">
        {results.map((r) => (
          <Row key={r.id} r={r} url={report.policy?.source.url} />
        ))}
      </ul>
    </section>
  );
}

/** The no-go summary for a report, with the setup form one click away. */
export function NoGoSection({ report }: { report: Report }) {
  const [prefs, setPrefs] = useNoGos();
  const [editing, setEditing] = useState(false);
  if (!prefs) return null;
  if (editing) return <NoGoSetup value={prefs} onChange={setPrefs} onDone={() => setEditing(false)} />;
  return <NoGoSummary report={report} prefs={prefs} onEdit={() => setEditing(true)} />;
}
