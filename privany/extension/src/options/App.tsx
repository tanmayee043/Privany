import { useEffect, useState } from "react";
import { ext, send } from "../lib/api";
import { backend } from "../lib/backend";
import { clearEverything, DEFAULT_SETTINGS, getReceipts, getSettings, saveSettings } from "../lib/settings";
import type { Preferences, Settings } from "../lib/types";
import { Glyph } from "../ui/parts";

const PREFS: { key: keyof Preferences; title: string; detail: string }[] = [
  { key: "selling_sharing", title: "Selling or sharing my data", detail: "Policies that let them sell or hand your info to other companies." },
  { key: "ad_tracking", title: "Being tracked for ads", detail: "Ad cookies and trackers, including ones that show up after you say no." },
  { key: "ai_training", title: "AI training on what I upload", detail: "Terms that let them train models on your photos, posts or files." },
  { key: "sensitive_fields", title: "My phone, birthday and address", detail: "Notes next to signup fields saying what they'll do with that info." },
  { key: "legal_traps", title: "Fine-print traps", detail: "Auto-renewals, forced arbitration, giving up class actions." },
  { key: "retention_deletion", title: "How long they keep my data", detail: "Vague retention and whether you can delete your data." },
];
const LEVELS = ["Don't care", "A little", "Care", "A lot"];

export default function Options() {
  const [s, setS] = useState<Settings | null>(null);
  const [conn, setConn] = useState<string>("");
  const [receipts, setReceipts] = useState(0);
  const [saved, setSaved] = useState(false);
  const welcome = new URLSearchParams(location.search).get("welcome") === "1";

  useEffect(() => { getSettings().then(setS); getReceipts().then((r) => setReceipts(r.length)); }, []);

  async function update(patch: Partial<Settings>) {
    const next = await saveSettings(patch);
    setS(next);
    await send({ type: "settings_changed" });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  async function test() {
    if (!s) return;
    setConn("Checking...");
    try {
      const h = await backend.health(s.backendUrl);
      setConn(h.engine === "gemini" ? `Connected. Reading policies with Gemini (${h.model}).` : "Connected. No Gemini key on the server, so it's using keyword rules.");
    } catch {
      setConn("Can't reach it. Start the server with ./scripts/dev.sh start, or check the address.");
    }
  }

  async function grantAccess() {
    const ok = await ext.permissions.request({ origins: ["<all_urls>"] });
    setConn(ok ? "Site access granted." : "Site access not granted. Privany can't see pages without it.");
  }

  if (!s) return null;
  return (
    <div className="min-h-screen bg-paper font-sans text-ink">
      <main className="mx-auto max-w-[640px] px-6 py-10">
        <div className="flex items-center gap-3">
          <Glyph kind="miss" className="text-glyph" />
          <h1 className="m-0 text-2xl font-bold">Privany settings</h1>
          {saved && <span role="status" className="ml-auto text-sm text-kept">Saved</span>}
        </div>

        {welcome && (
          <p className="mb-0 mt-4 rounded-lg bg-white p-4 text-base">
            Privany reads a site's privacy policy and terms, then watches what the site actually does in your browser.
            You don't need to open anything: when a site looks risky, a panel pops up on the page, and when you're about
            to agree to something there (accept cookies, tick “I agree”, hand over your phone number), Privany pauses and
            shows you what you're agreeing to first. When what they say and what they do don't match, you'll
            see <Glyph kind="miss" className="mx-0.5" />. Set what you care about below, and you're done.
          </p>
        )}

        <section className="mt-8">
          <h2 className="m-0 text-lg font-bold">What matters to you</h2>
          <p className="m-0 mt-1 text-sm text-ink-soft">This decides what gets flagged and how loudly.</p>
          <div className="mt-4 space-y-5">
            {PREFS.map((p) => (
              <fieldset key={p.key} className="m-0 border-0 p-0">
                <legend className="text-base font-semibold">{p.title}</legend>
                <p className="m-0 text-sm text-ink-faint">{p.detail}</p>
                <div className="mt-2 inline-flex rounded-lg bg-paper-deep p-1" role="radiogroup">
                  {LEVELS.map((label, v) => (
                    <button key={v} role="radio" aria-checked={s.preferences[p.key] === v}
                      onClick={() => update({ preferences: { ...s.preferences, [p.key]: v } })}
                      className={`rounded-md px-3 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ink ${s.preferences[p.key] === v ? "bg-ink font-semibold text-white" : "text-ink-soft hover:text-ink"}`}>
                      {label}
                    </button>
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
        </section>

        <section className="mt-10 space-y-4">
          <h2 className="m-0 text-lg font-bold">How Privany works on sites</h2>
          <Toggle
            on={s.gate}
            onChange={(v) => update({ gate: v })}
            title="Stop me before I agree on risky sites"
            detail="When you click Accept, tick an “I agree” box, or send a form with your personal info on a site that looks risky, Privany pauses and shows you what you're agreeing to first. Safe sites are never interrupted."
          />
          <Toggle
            on={s.mode === "auto"}
            onChange={(v) => update({ mode: v ? "auto" : "moments" })}
            title="Check every site I open"
            detail="Off: only check when you're about to sign up, pay, upload, or answer a cookie banner. Sends fewer site addresses to the server."
          />
          <Toggle
            on={s.sendGpc}
            onChange={(v) => update({ sendGpc: v })}
            title="Send Global Privacy Control"
            detail="Tells sites you opt out of the sale or sharing of your data. Some US states require sites to honor it. Privany then checks whether they do."
          />
          <Toggle
            on={s.autoGpcTest}
            onChange={(v) => update({ autoGpcTest: v })}
            title="Test GPC claims automatically"
            detail="When a policy says it honors GPC, Privany's server visits the site twice (GPC off and on) and compares the cookies. It's how PrivAudit audits sites."
          />
        </section>

        <section className="mt-10">
          <h2 className="m-0 text-lg font-bold">Paused sites</h2>
          {s.paused.length === 0 ? <p className="m-0 mt-1 text-sm text-ink-faint">None.</p> : (
            <ul className="m-0 mt-2 space-y-1 p-0">
              {s.paused.map((p) => (
                <li key={p} className="flex list-none items-center justify-between rounded bg-white px-3 py-1.5 text-sm">
                  {p}<button className="text-xs underline" onClick={() => update({ paused: s.paused.filter((x) => x !== p) })}>Resume</button>
                </li>
              ))}
            </ul>
          )}
          <PauseInput onAdd={(site) => update({ paused: [...new Set([...s.paused, site])] })} />
        </section>

        <section className="mt-10">
          <h2 className="m-0 text-lg font-bold">Server</h2>
          <label className="mt-2 block text-sm font-semibold" htmlFor="backend">Privany server address</label>
          <div className="mt-1 flex gap-2">
            <input id="backend" className="flex-1 rounded-lg border border-ink/20 bg-white px-3 py-2 text-sm" defaultValue={s.backendUrl}
              onBlur={(e) => e.target.value !== s.backendUrl && update({ backendUrl: e.target.value.trim() || DEFAULT_SETTINGS.backendUrl })} />
            <button onClick={test} className="rounded-lg bg-ink px-3 py-2 text-sm font-semibold text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-marker">Test</button>
          </div>
          {conn && <p role="status" className="m-0 mt-2 text-sm text-ink-soft">{conn}</p>}
          <button onClick={grantAccess} className="mt-3 text-sm underline">Grant site access (Firefox asks for this separately)</button>
        </section>

        <section className="mt-10">
          <h2 className="m-0 text-lg font-bold">Your data</h2>
          <p className="m-0 mt-1 text-sm text-ink-soft">
            Settings, cached reports, and {receipts} consent receipt{receipts === 1 ? "" : "s"} live only in this browser.
            The server caches policy readings by a hash of the policy address and keeps nothing about you.
          </p>
          <button className="mt-3 rounded-lg border border-miss px-3 py-1.5 text-sm font-semibold text-miss"
            onClick={async () => { if (confirm("Delete all receipts and cached reports from this browser?")) { await clearEverything(); setReceipts(0); } }}>
            Delete receipts and cached reports
          </button>
        </section>

        <section className="mt-10 text-sm text-ink-soft">
          <h2 className="m-0 text-lg font-bold text-ink">Where the data comes from</h2>
          <ul className="m-0 mt-2 space-y-1.5 p-0">
            <li className="list-none"><b>PrivAudit</b> (Dawoud, Aggarwal, Krishnamurthy, Sundara Raman, ACM CCS 2026; CC BY 4.0): the policy claims Privany checks, the GPC test method, the disclosure–behavior gap rules, cookie categories, and past audits of 937 sites.</li>
            <li className="list-none"><b>DuckDuckGo Tracker Radar</b> blocklist (CC BY-NC-SA 4.0): which domains are trackers and who owns them.</li>
            <li className="list-none"><b>Open Cookie Database</b> (Apache 2.0): cookie names, categories and the platforms behind them.</li>
          </ul>
          <p className="m-0 mt-3">Privany reports what a policy says and what it observed. It isn't legal advice and can't prove what a company does with your data.</p>
        </section>
      </main>
    </div>
  );
}

function Toggle({ on, onChange, title, detail }: { on: boolean; onChange: (v: boolean) => void; title: string; detail: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <button role="switch" aria-checked={on} onClick={() => onChange(!on)}
        className={`mt-0.5 h-6 w-11 shrink-0 rounded-full p-0.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ink ${on ? "bg-ink" : "bg-unsure/50"}`}>
        <span className={`block h-5 w-5 rounded-full bg-white transition-transform ${on ? "translate-x-5" : ""}`} />
      </button>
      <span>
        <span className="block text-base font-semibold">{title}</span>
        <span className="block text-sm text-ink-faint">{detail}</span>
      </span>
    </label>
  );
}

function PauseInput({ onAdd }: { onAdd: (s: string) => void }) {
  const [v, setV] = useState("");
  return (
    <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (v.trim()) { onAdd(v.trim().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]); setV(""); } }}>
      <input aria-label="Site to pause" placeholder="e.g. mybank.com" value={v} onChange={(e) => setV(e.target.value)}
        className="flex-1 rounded-lg border border-ink/20 bg-white px-3 py-2 text-sm" />
      <button className="rounded-lg border border-ink/20 px-3 py-2 text-sm font-semibold">Pause</button>
    </form>
  );
}
