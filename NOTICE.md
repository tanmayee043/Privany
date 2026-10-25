# Third-party work

## PrivAudit

Privany's browser measurement and claim set are adapted from **PrivAudit: A Dual-Lens Auditing Framework for Website Privacy Practices under the CCPA** (Dawoud, Aggarwal, Krishnamurthy, Raman; ACM CCS 2026).

- Paper: https://arxiv.org/abs/2609.09697 (v1, 9 September 2026)
- Code: https://github.com/r-andlab/PrivAudit
- Artifact: https://zenodo.org/records/22682191 (CC BY 4.0)

What we reuse, with changes:

- The GPC configuration from `crawler/scripts/cookie_profile_test.js`: the `Sec-GPC: 1` header plus `navigator.globalPrivacyControl = true`, a fresh browser profile per configuration, `networkidle2` plus a settle pause. Privany reads every cookie in the profile instead of `page.cookies()`, and repeats each configuration to separate signal from ad-auction noise.
- Privany's own addition, not in PrivAudit: a click test that clicks a Play button, video player or the page centre like a visitor, in a separate throwaway profile, and records pop-up windows (blocked before they load), redirects, and new domains and cookies.
- Looking beyond the homepage, after PrivAudit's `inner_page/` step: each Privany visit also loads one same-site content page (the same one on every visit) and scrolls both pages. Privany runs the default and GPC visits side by side, records the outside domains each visit contacts, and blocks downloads and pop-up windows in its test browser.
- The behavioral claims from `policy_analysis/prompts/ccpa_rubric_prompt.txt` (honors GPC, respects DNT, sells data, shares with third parties, tracking only after consent), reworded with explicit yes/no/unspecified definitions.
- The four cookie buckets from `cookie_categorization/cookie_categorization.py` (necessary, functional, performance/analytics, targeting/advertising).
- The "joint lens" idea of comparing disclosures with observed behavior, implemented here as deterministic rules in `server/src/compare/rules.ts`.

## PrivAudit data and tracker list (automatic checks)

Prepared by `privany/data-pipeline/build_data.py` on the `features-updated` branch (Privany team):

- `server/data/privaudit-prior-audits.json`: PrivAudit's released audits of 937 sites (claims, cookie counts and the paper's gap-rule findings, crawl of March 2025), from the Zenodo artifact, CC BY 4.0.
- `extension/src/data/cookies.json`: cookie-name categories from PrivAudit's crawl (CC BY 4.0) with Open Cookie Database fallbacks (Apache 2.0).
- `extension/src/data/trackers.json`: tracker domains, owners and categories from DuckDuckGo's Tracker Radar data set (TDS), https://github.com/duckduckgo/tracker-radar, licensed CC BY-NC-SA 4.0 (non-commercial, share-alike). Fine for this non-commercial project; replace it before any commercial use.

## Open Cookie Database

`server/data/open-cookie-database.csv` is from https://github.com/jkwakman/Open-Cookie-Database, licensed under the Apache License 2.0.
