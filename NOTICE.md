# Third-party work

## PrivAudit

Privany's browser measurement and claim set are adapted from **PrivAudit: A Dual-Lens Auditing Framework for Website Privacy Practices under the CCPA** (Dawoud, Aggarwal, Krishnamurthy, Raman; ACM CCS 2026).

- Paper: https://arxiv.org/abs/2609.09697 (v1, 9 September 2026)
- Code: https://github.com/r-andlab/PrivAudit
- Artifact: https://zenodo.org/records/22682191 (CC BY 4.0)

What we reuse, with changes:

- The GPC configuration from `crawler/scripts/cookie_profile_test.js`: the `Sec-GPC: 1` header plus `navigator.globalPrivacyControl = true`, a fresh browser profile per configuration, `networkidle2` plus a settle pause. Privany reads every cookie in the profile instead of `page.cookies()`, and repeats each configuration to separate signal from ad-auction noise.
- The behavioral claims from `policy_analysis/prompts/ccpa_rubric_prompt.txt` (honors GPC, respects DNT, sells data, shares with third parties, tracking only after consent), reworded with explicit yes/no/unspecified definitions.
- The four cookie buckets from `cookie_categorization/cookie_categorization.py` (necessary, functional, performance/analytics, targeting/advertising).
- The "joint lens" idea of comparing disclosures with observed behavior, implemented here as deterministic rules in `server/src/compare/rules.ts`.

## Open Cookie Database

`server/data/open-cookie-database.csv` is from https://github.com/jkwakman/Open-Cookie-Database, licensed under the Apache License 2.0.
