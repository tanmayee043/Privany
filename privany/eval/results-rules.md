# Privany vs PrivAudit labels: `rules` engine

60 policies from the PrivAudit corpus (requested 60, stratified by `sells_data`).

Agreement here means Privany's reading matches PrivAudit's label (`true` / `false` / `unspecified`). PrivAudit's labels come from an LLM run over the first 6,000 characters of each policy, so they're a reference point, not ground truth.

| Claim | Agreement | Privany said true/false where PrivAudit said unspecified | Privany said unspecified where PrivAudit had a value |
|---|---|---|---|
| `sells_data` | 34/60 (57%) | 9 | 2 |
| `honors_gpc` | 55/60 (92%) | 3 | 0 |
| `shares_with_third_parties` | 54/60 (90%) | 2 | 0 |

| Evidence check | Result |
|---|---|
| Quotes found word for word in the source | 1100/1100 (100%) |
| Claims asserted with a quote that doesn't exist (caught and dropped) | 0/152 |
| Median time per policy | 0.0s |

## Confusion (rows: PrivAudit, cols: Privany)

**sells_data**

| | true | false | unspecified |
|---|---|---|---|
| true | 14 | 6 | 0 |
| false | 9 | 9 | 2 |
| unspecified | 7 | 2 | 11 |

**honors_gpc**

| | true | false | unspecified |
|---|---|---|---|
| true | 10 | 2 | 0 |
| false | 0 | 0 | 0 |
| unspecified | 3 | 0 | 45 |

**shares_with_third_parties**

| | true | false | unspecified |
|---|---|---|---|
| true | 50 | 4 | 0 |
| false | 0 | 0 | 0 |
| unspecified | 2 | 0 | 4 |
