// Pieces shared by the popup, full report, and in-page panel.
import { useState } from "react";
import type { Evidence, Flag, Severity, Verdict } from "../lib/types";

export const SEV_COLOR: Record<Severity, string> = {
  high: "bg-miss", medium: "bg-amber", low: "bg-unsure", info: "bg-unsure/50",
};

export const VERDICT_TEXT: Record<Verdict, string> = {
  red: "text-miss", yellow: "text-amber", green: "text-kept", unknown: "text-unsure",
};

/** The comparison mark: ≠ broken promise, = kept, ? not tested / unclear. */
export function Glyph({ kind, className = "" }: { kind: "miss" | "kept" | "unsure" | "warn"; className?: string }) {
  const map = {
    miss: ["≠", "text-miss", "Doesn't match"],
    kept: ["=", "text-kept", "Matches"],
    unsure: ["?", "text-unsure", "Not tested or unclear"],
    warn: ["!", "text-amber", "Worth knowing"],
  } as const;
  const [ch, color, label] = map[kind];
  return (
    <span role="img" aria-label={label} className={`inline-block font-quote font-bold leading-none ${color} ${className}`}>
      {ch}
    </span>
  );
}

export function verdictGlyph(v: Verdict | undefined, hasGaps: boolean): "miss" | "kept" | "unsure" | "warn" {
  if (!v || v === "unknown") return "unsure";
  if (hasGaps) return "miss";
  if (v === "green") return "kept";
  return "warn";
}

/** Link straight to the sentence in the original page (text fragment). */
export function sourceLink(ev: Evidence): string | null {
  if (!ev.url) return null;
  const words = ev.quote.replace(/\s+/g, " ").trim().split(" ");
  const start = words.slice(0, 6).join(" ");
  const end = words.length > 12 ? words.slice(-4).join(" ") : "";
  const frag = end ? `${encodeURIComponent(start)},${encodeURIComponent(end)}` : encodeURIComponent(words.join(" "));
  return `${ev.url.split("#")[0]}#:~:text=${frag}`;
}

export function Quote({ ev, dark = false }: { ev: Evidence; dark?: boolean }) {
  const href = sourceLink(ev);
  return (
    <figure className="m-0">
      <blockquote className={`m-0 font-quote text-sm leading-[1.55] ${dark ? "text-ink" : "text-ink"}`}>
        <span className="bg-marker/90 box-decoration-clone px-0.5 py-[1px]">{ev.quote}</span>
      </blockquote>
      <figcaption className={`mt-1 text-xs2 ${dark ? "text-paper/70" : "text-ink-faint"}`}>
        {ev.verified ? "Exact quote, checked against the page" : "Couldn't confirm this quote in the source"}
        {href && (
          <>
            {", "}
            <a className={`underline underline-offset-2 ${dark ? "text-paper" : "text-ink"}`} href={href} target="_blank" rel="noreferrer">
              see it in context
            </a>
          </>
        )}
      </figcaption>
    </figure>
  );
}

export function FlagItem({ f, dark = false, open: startOpen = false }: { f: Flag; dark?: boolean; open?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const isGap = f.kind === "gap";
  const sub = dark ? "text-paper/75" : "text-ink-faint";
  return (
    <li className="list-none">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={`group flex w-full items-start gap-3 py-2.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-marker rounded-sm`}
      >
        <span className={`mt-1 h-4 w-1 shrink-0 rounded-full ${SEV_COLOR[f.severity]}`} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className={`block text-sm font-semibold ${dark ? "text-white" : "text-ink"}`}>
            {isGap && <Glyph kind="miss" className="mr-1.5 text-base" />}
            {f.title}
          </span>
          {!open && <span className={`mt-0.5 block truncate text-xs ${sub}`}>{f.detail}</span>}
        </span>
        <span className={`mt-0.5 text-xs ${sub} transition-transform ${open ? "rotate-90" : ""}`} aria-hidden>›</span>
      </button>
      {open && (
        <div className={`mb-3 ml-4 space-y-3 border-l pl-3 ${dark ? "border-white/15" : "border-ink/10"}`}>
          <p className={`m-0 text-sm ${dark ? "text-paper" : "text-ink-soft"}`}>{f.detail}</p>
          {f.evidence.quotes.filter((q) => q.quote).map((q, i) => (
            <div key={i}>
              <div className={`mb-1 text-xs font-semibold ${dark ? "text-paper/80" : "text-ink-faint"}`}>They say</div>
              <Quote ev={q} dark={dark} />
            </div>
          ))}
          {f.evidence.observed.length > 0 && (
            <div>
              <div className={`mb-1 text-xs font-semibold ${dark ? "text-paper/80" : "text-ink-faint"}`}>
                {f.kind === "prior" ? "Source" : f.kind === "change" ? "Since you agreed" : "We saw"}
              </div>
              <ul className={`m-0 space-y-0.5 p-0 text-xs ${dark ? "text-paper" : "text-ink-soft"}`}>
                {f.evidence.observed.map((o, i) => {
                  const m = /^Before: (.*?)\. Now: (.*?)\.$/.exec(o);
                  return (
                    <li key={i} className="list-none tabular-nums">
                      {m ? <><span className="line-through opacity-70">{m[1]}</span>{" → "}<span className="bg-marker px-0.5 font-semibold text-ink">{m[2]}</span></> : o}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {f.actions.length > 0 && (
            <div>
              <div className={`mb-1 text-xs font-semibold ${dark ? "text-paper/80" : "text-ink-faint"}`}>What you can do</div>
              <ul className="m-0 space-y-1 p-0">
                {f.actions.map((a, i) => (
                  <li key={i} className={`list-none text-xs ${dark ? "text-paper" : "text-ink-soft"}`}>
                    <span className="font-semibold">{a.label}.</span> {a.how}{" "}
                    {a.url && /^https?:|^mailto:|@/.test(a.url) && (
                      <a className="underline" href={a.url.includes("@") && !a.url.startsWith("mailto:") ? `mailto:${a.url}` : a.url}
                         target="_blank" rel="noreferrer">Open</a>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {f.caveat && <p className={`m-0 text-xs2 italic ${sub}`}>{f.caveat}</p>}
        </div>
      )}
    </li>
  );
}
