# Privany

Privany checks whether a website's privacy promises hold up, and helps you decide what to do about it.

Privany checks every site you open in the background and stays out of the way unless a site looks risky; then a short warning appears on the page with the reasons and a button for the full report. You can also click the Privany icon on any site, and a side panel opens next to the page. Privany reads the policy you're looking at, pulls out specific promises (for example "we honor Global Privacy Control") with the exact sentences they come from, and visits the site in a controlled browser with and without Global Privacy Control (GPC) to record which tracking cookies get written. Each promise is shown next to what the browser saw, with plain-language caveats and next steps the policy itself documents.

The measurement method comes from **PrivAudit** (ACM CCS 2026, [arXiv 2609.09697](https://arxiv.org/abs/2609.09697)), which audited 998 sites this way for researchers. Privany turns it into an on-demand check of one site for one person. See [NOTICE.md](NOTICE.md) for what we reuse and how it differs.

**It's free to run.** Policies are read by a rule-based reader on your own machine, with no AI service and no API costs. Claude can be switched on optionally for more nuanced reading (see Settings).

## Status

Hackathon project, work in progress.

- Working: Chrome extension with side panel, browser audit (default vs. GPC, repeated visits, homepage plus one inner page, scrolled), Reject All / Accept All consent test, a click test that clicks Play (or the page) like a visitor and records pop-ups and redirects, personal no-goes, reading the policy straight from the open tab (or following its privacy link), free rule-based policy reader, quote verification, comparison rules, web app.
- Ideas for later: opt-out request drafting, a map of the companies that learned about your visit, a local AI model through Ollama.

## Run it locally

Requirements: Node.js 20 or newer (tested on 24), git, and Chrome.

```bash
git clone https://github.com/tanmayee043/Privany.git
cd Privany
npm install
```

`npm install` also downloads a copy of Chrome for Puppeteer (about 170 MB) the first time; that copy runs the site tests.

### 1. Start the Privany server

```bash
npm run dev
```

This starts the API on http://127.0.0.1:8787 (the extension talks to it) and the web app on http://localhost:5173. Keep it running.

### 2. Build and load the extension

```bash
npm run build:extension
```

Then in Chrome:

1. Go to `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and choose the `extension/dist` folder inside this repo.
3. Pin Privany from the puzzle-piece menu so its icon stays in the toolbar.

After changing extension code, run `npm run build:extension` again (or keep `npm run dev:extension` running) and click the reload arrow on Privany's card in `chrome://extensions`.

### 3. Use it

**Automatically:** just browse. A few seconds after a page loads, the Privany icon shows a badge: red `!` risky, amber `!` one thing worth knowing, green `✓` nothing risky spotted, `?` no policy found. On red sites a warning also appears on the page (try https://www.papajohns.com, which PrivAudit's researchers flagged in 2025). It has **Full report**, **Not now** and **Don't warn me on this site**. On sign-up and checkout forms, a note appears under fields like phone number or date of birth when the site's policy says that detail is used for marketing, ads, sharing or sale, with a "Their words" link to the exact sentence. Privany never reads what you type. Turn automatic checks off with the switch at the bottom of the side panel.

**Full report:** open a site's privacy policy, for example https://duckduckgo.com/privacy, and click the Privany icon. The side panel shows progress and then the report, usually within one to two minutes. If you click it on a page that isn't the policy, Privany follows the page's privacy link instead.

The web app at http://localhost:5173 does the same from a pasted address, and lists recent checks.

### Your no-goes

Pick dealbreakers once from a fixed menu (for example "Don't sell my data", "Must honor my opt-out signal (GPC)", "No tracking before I agree"). Every report then opens with a summary such as "Breaks 2 of your 5 no-goes", each backed by the policy's own quote and/or the cookies the test saw. Each no-go is one of three outcomes: **breaks your no-go**, **doesn't break it**, or **policy doesn't say**. Silence is never counted as breaking one, except for the "must say" rules (retention) or when you turn on **Be strict**.

Your choices are stored on your device only and are never sent to the server: `chrome.storage.sync` in the extension (key `privany.nogos.v1`, synced by Chrome if you're signed in) and `localStorage` in the web app. The rules are evaluated in the browser by `web/src/nogos.ts`. The side panel asks for them on first use; use "Edit my no-goes" afterwards.

### Settings

Optional; copy `.env.example` to `.env`:

| Setting | What it does |
|---|---|
| `PRIVANY_POLICY_READER=claude` and `ANTHROPIC_API_KEY=…` | Read policies with Claude instead of the free reader (about $0.10–0.40 per site) |
| `PORT` | API port (default 8787; the extension expects 8787) |

### Other commands

| Command | What it does |
|---|---|
| `npm test` | Unit tests (rule reader, quote verification, comparison rules, cookie labels, URL safety) |
| `npm run typecheck` | Type-checks server, web app and extension |
| `npm run audit -w server -- example.com` | Runs only the browser audit and prints the cookies |
| `npm run click -w server -- example.com [page-url]` | Runs only the click test (does clicking Play open pop-ups?) and prints what happened |
| `npm run read -w server -- https://example.com/privacy` | Runs the free reader on a policy and prints its findings |
| `node extension/scripts/auto-e2e.mjs https://www.papajohns.com/ https://duckduckgo.com/` | Opens sites in a test Chrome with the extension, without clicking anything, and prints the badge, risk reasons and whether the warning appeared (needs the server running) |
| `npm run e2e -w extension -- https://duckduckgo.com/privacy out.png` | Loads the built extension in a test Chrome, clicks its icon on the page and saves a screenshot of the panel (needs the server running) |

## How it works

```text
Chrome extension (side panel)          web app (localhost:5173)
  reads the open tab's text              paste an address
            └──────── POST /api/analyze ────────┘
                              │
                      server/ (Express)
                              │
         ┌────────────────────┼─────────────────────────┐
         ▼                    ▼                         ▼
  audit/run.ts         policy/extract.ts          policy/rules.ts (free, default)
  4 visits: default,   uses the tab's text if      or policy/analyze.ts (Claude)
  GPC, default, GPC;   it's the policy; else       → promises + quotes
  each loads the       follows privacy links       policy/verify.ts keeps only
  homepage + 1 inner                               quotes found word for word
  page, scrolled; no
  clicks; cookies and
  outside domains
  recorded
         └────────────────────┬─────────────────────────┘
                              ▼
                      compare/rules.ts
     fixed rules: possible gap / matches / not promised / can't test / couldn't test
                              ▼
               report saved to server/data/reports/<id>.json
```

- **Automatic checks** (`extension/src/watch.ts`, `content.ts`, `risk.ts`): on every page the extension notes which outside ad-tech companies the page contacts and which tracking cookies it sets, finds the privacy-policy link and whether a cookie banner is up, and asks the local server for a quick read of the policy (`POST /api/quick`, policy only, cached per site) plus PrivAudit's 2025 audit of the site if it was in the study. Plain rules (`risk.ts`, tested) turn that into a level: red (one serious finding, or two lesser ones) shows a warning on the page; yellow, green and "?" only change the toolbar badge. Users can switch automatic checks off, or silence a site, from the side panel.
- **What it reads:** this needs Chrome's permission to read all sites and see their network requests and cookies. The content script reads only links and whether a cookie banner is visible, never what you type. Everything goes to the Privany server on your own computer (localhost) and nowhere else.
- **Full report:** clicking the icon (or "Full report") sends the open page's visible text to the server and runs the full test visits. Code: `extension/src/capture.ts`.
- The site test runs in separate, fresh browser profiles on the server, never in your own browser, so your cookies and logins don't affect results.
- `server/src/report/types.ts` defines the report shape shared by server, web app and extension; the side panel reuses the web app's components.
- `server/src/safety/url.ts` blocks private-network addresses (the server loads arbitrary URLs).

## Project layout

```text
server/      API, browser audit, policy reading, comparison rules, tests
extension/   Chrome extension: background worker, page capture, side panel
web/         React + Vite + Tailwind web app ("Privacy Facts" label design)
PRODUCT.md   product decisions: users, principles, constraints
NOTICE.md    credits and licenses for PrivAudit and the Open Cookie Database
```

## Ground rules for the team

- Never present a finding as proof of wrongdoing; the wording is "possible gap" and every result carries its caveats.
- Every quote shown must come from the policy text. Don't bypass `verifyQuotes`.
- The free reader answers "yes" or "no" only for explicit statements; when in doubt it says "unspecified". Keep it that way.
- Don't commit `.env` or API keys.
- Policy text and web pages are untrusted input, never instructions.
