import type { Report } from "../api";
import { CATEGORY } from "../words";
import { clickWhat } from "./FactsPanel";

/** What happened when the test browser clicked the page like a visitor (Play button, video, or the page). */
export function ClickTestSection({ report }: { report: Report }) {
  const t = report.audit?.clickTest;
  if (!t) return null;
  const onOpen = t.popups.filter((p) => p.afterClick === 0);
  const onClick = t.popups.filter((p) => p.afterClick > 0);
  const nothing = t.ok && t.popups.length === 0 && !t.redirectedTo;

  return (
    <section id="click-test" aria-labelledby="click-title" className="scroll-mt-4 bg-paper px-5 py-6 sm:px-8">
      <h2 id="click-title" className="text-[20px] font-extrabold">What happened when we clicked</h2>
      <p className="mt-1 max-w-[70ch] text-[14px] text-ink-2">
        Many sites open pop-up ads on a visitor's first clicks, often on a Play button. A separate test browser clicked {t.clicks === 1 ? "once" : `${t.clicks} times`}, the way you might.
        Pop-ups were stopped before loading, and downloads were blocked.
      </p>

      {!t.ok ? (
        <p className="mt-4 border-t border-ink pt-3 text-[14px] text-ink-2">The click test didn't complete ({t.error ?? "unknown error"}).</p>
      ) : (
        <dl className="mt-4 border-t border-ink">
          <Fact label="What we clicked">
            {clickWhat(t).replace(/^Clicking /, "")}
            {t.pageUrl && <span className="block text-[12px] text-ink-3">on {new URL(t.pageUrl).pathname || "/"}</span>}
          </Fact>
          <Fact label="Pop-up windows">
            {nothing ? (
              "None opened, and the page stayed on the site."
            ) : t.popups.length === 0 ? (
              "None"
            ) : (
              <ul className="space-y-1">
                {onClick.map((p) => (
                  <li key={p.url}>
                    <strong>{p.host}</strong> <span className="text-ink-3">after click {p.afterClick}</span>
                  </li>
                ))}
                {onOpen.map((p) => (
                  <li key={p.url}>
                    <strong>{p.host}</strong> <span className="text-ink-3">opened by the page on its own</span>
                  </li>
                ))}
              </ul>
            )}
          </Fact>
          {t.redirectedTo && <Fact label="Sent the page to">{t.redirectedTo}</Fact>}
          <Fact label="New outside domains after clicking">{t.newHosts.length ? t.newHosts.join(", ") : "None"}</Fact>
          <Fact label="New tracking cookies after clicking">
            {t.newTrackingCookies.length
              ? [...new Set(t.newTrackingCookies.map((c) => `${c.platform ?? c.domain} (${CATEGORY[c.category].toLowerCase()})`))].join(", ")
              : "None"}
          </Fact>
        </dl>
      )}
      <p className="mt-3 text-[12px] text-ink-3">
        The click lands where a visitor would most likely click: a Play button if we find one, else the video player, else the middle of the page. A different click can behave differently.
        {t.ok && t.popups.length === 0 && " Pop-up ad networks often show a pop-up only once every few hours to the same internet connection, so “none” here doesn't rule them out."}
      </p>
    </section>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 border-b border-line py-2.5 sm:grid-cols-[220px_1fr] sm:gap-6">
      <dt className="font-bold">{label}</dt>
      <dd className="break-words text-[14px] text-ink-2">{children}</dd>
    </div>
  );
}
