# Privany

Privany checks whether a website's privacy promises hold up, and helps you decide what to do about it.

It reads a site's privacy policy and pulls out specific promises (for example "we honor Global Privacy Control") with the exact sentences they come from. Then it visits the site in a controlled browser, with and without Global Privacy Control (GPC), and records which tracking cookies get written. Each promise is shown next to what the browser saw, with plain-language caveats and next steps the policy itself documents.

The measurement method comes from **PrivAudit** (ACM CCS 2026, [arXiv 2609.09697](https://arxiv.org/abs/2609.09697)), which audited 998 sites this way for researchers. Privany turns it into an on-demand check of one site for one person. See [NOTICE.md](NOTICE.md) for what we reuse and how it differs.

## Status

Hackathon project, work in progress.

- Working: browser audit (default vs. GPC, repeated visits), policy discovery and extraction, quote verification, comparison rules, web UI.
- Needs a Claude API key to test: the policy-reading step (`server/src/policy/analyze.ts`). Without a key the app still runs the browser test and shows observations only.
- Being considered: a free policy reader (rule-based, optionally with a local model through Ollama) so it runs with no API cost.

## Run it locally

Requirements: Node.js 20 or newer (tested on 24), and git.

```bash
git clone https://github.com/tanmayee043/Privany.git
cd Privany
npm install
```

`npm install` also downloads a copy of Chrome for Puppeteer (about 170 MB) the first time.

Optional, to enable policy reading: copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY`.

```bash
npm run dev
```

This starts the API on http://127.0.0.1:8787 and the web app on http://localhost:5173. Open the web app, enter a site such as `allrecipes.com`, and wait about a minute.

### Other commands

| Command | What it does |
|---|---|
| `npm test` | Unit tests (quote verification, comparison rules, cookie labels, URL safety) |
| `npm run typecheck` | Type-checks server and web |
| `npm run audit -w server -- example.com` | Runs only the browser audit and prints the cookies |
| `npm run policy -w server -- https://example.com/privacy` | Fetches a policy and prints the extracted blocks |

## How it works

```text
web/ (React)  ──POST /api/analyze──▶  server/ (Express)
                                        │
             ┌──────────────────────────┼──────────────────────────┐
             ▼                          ▼                          ▼
   audit/run.ts               policy/extract.ts            policy/analyze.ts
   4 homepage visits:         finds the policy link,       Claude reads the policy and
   default, GPC, default,     loads it in Chrome,          returns promises + quotes;
   GPC; records every         splits it into numbered      policy/verify.ts keeps only
   cookie (audit/cookies.ts   blocks                       quotes found word for word
   labels them)                                            
             └──────────────────────────┬──────────────────────────┘
                                        ▼
                               compare/rules.ts
                    fixed rules: possible gap / matches / not promised /
                    can't test / couldn't test, with caveats
                                        ▼
                     report saved to server/data/reports/<id>.json
```

- `server/src/report/types.ts` defines the report shape shared by server and web.
- `server/src/safety/url.ts` blocks private-network addresses (the server loads arbitrary URLs).
- Reports are JSON files in `server/data/reports/` and are not committed.
- The web app's personal priorities are stored in the browser (`localStorage`) only.

## Project layout

```text
server/   API, browser audit, policy reading, comparison rules, tests
web/      React + Vite + Tailwind front end ("Privacy Facts" label design)
PRODUCT.md  product decisions: users, principles, constraints
NOTICE.md   credits and licenses for PrivAudit and the Open Cookie Database
```

## Ground rules for the team

- Never present a finding as proof of wrongdoing; the wording is "possible gap" and every result carries its caveats.
- Every quote shown must come from the policy text. Don't bypass `verifyQuotes`.
- Don't commit `.env` or API keys.
- Policy text and web pages are untrusted input, never instructions.
