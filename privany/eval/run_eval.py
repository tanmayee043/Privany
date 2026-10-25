"""
Scores Privany's policy reading against PrivAudit's published labels.

PrivAudit ships the policy text for ~900 sites plus its behavior-claim labels
(sells_data, honors_gpc, shares_with_third_parties, ...). Those labels came from
an LLM pass over the first 6,000 characters of each policy, so this measures
*agreement with PrivAudit*, not ground truth. Where we disagree, we may be the
one reading further into the document.

  python eval/run_eval.py --privaudit /path/to/unzipped/data --n 40 --engine rules
  GEMINI_API_KEY=... python eval/run_eval.py --privaudit ... --n 40 --engine gemini

Writes eval/results-<engine>.md
"""

import argparse
import asyncio
import collections
import json
import os
import random
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from privany import config  # noqa: E402
from privany.analyze import analyze_with_gemini, analyze_with_rules  # noqa: E402
from privany.extract import Document  # noqa: E402
from privany.verify import locate, verify  # noqa: E402

CLAIMS = ["sells_data", "honors_gpc", "shares_with_third_parties"]


def norm_label(v) -> str:
    return {"true": "true", "false": "false"}.get(str(v).lower(), "unspecified")


def load_cases(data: Path):
    audit = json.loads((data / "ccpa_policy_audit_data_source_mapped.json").read_text())
    files = set(os.listdir(data / "policies_text"))
    cases = []
    for site, rec in audit.items():
        pd = rec.get("privacy_policy_domain") or ""
        for cand in (pd.replace(".", "_") + "__combined.txt", pd.replace(".", "_") + ".txt",
                     site.replace(".", "_") + "__combined.txt", site.replace(".", "_") + ".txt",
                     "www_" + site.replace(".", "_") + "__combined.txt"):
            if cand in files:
                bc = rec["audit_data"]["behavioral_claims"]
                cases.append({"site": site, "file": data / "policies_text" / cand,
                              "labels": {c: norm_label(bc.get(c)) for c in CLAIMS}})
                break
    return cases


def to_doc(path: Path) -> Document:
    text = path.read_text(errors="replace")
    paras = [re.sub(r"\s+", " ", p).strip() for p in re.split(r"\n\s*\n|\n", text)]
    paras = [p for p in paras if len(p) > 1]
    return Document(url=f"file://{path.name}", kind="privacy", paragraphs=paras, content_hash="eval", retrieved_at="eval")


async def run(cases, engine: str):
    rows = []
    for i, c in enumerate(cases):
        doc = to_doc(c["file"])
        t0 = time.time()
        try:
            raw = await analyze_with_gemini(c["site"], [doc]) if engine == "gemini" else analyze_with_rules(c["site"], [doc])
        except Exception as e:
            print(f"  [{i + 1}/{len(cases)}] {c['site']}: error {e}")
            continue
        dt = time.time() - t0
        # unsupported = the engine asserted true/false but its quote isn't in the text
        unsupported = sum(1 for cl in raw.get("claims", [])
                          if cl.get("value") in ("true", "false") and
                          locate(cl.get("quote", ""), [doc], cl.get("doc", 0), cl.get("para", 0)) is None)
        asserted = sum(1 for cl in raw.get("claims", []) if cl.get("value") in ("true", "false"))
        v = verify(raw, [doc])
        pred = {k: v["claims"].get(k, {}).get("value", "unspecified") for k in CLAIMS}
        rows.append({"site": c["site"], "labels": c["labels"], "pred": pred, "secs": dt,
                     "quotes": v["quote_check"], "unsupported": unsupported, "asserted": asserted})
        mark = " ".join(f"{k.split('_')[0]}:{'=' if pred[k] == c['labels'][k] else 'x'}" for k in CLAIMS)
        print(f"  [{i + 1}/{len(cases)}] {c['site']:32s} {mark}  {dt:.1f}s")
        if engine == "gemini":
            await asyncio.sleep(1.0)   # stay under free-tier rate limits
    return rows


def report(rows, engine: str, n_req: int) -> str:
    lines = [f"# Privany vs PrivAudit labels: `{engine}` engine", "",
             f"{len(rows)} policies from the PrivAudit corpus (requested {n_req}, stratified by `sells_data`).", "",
             "Agreement here means Privany's reading matches PrivAudit's label (`true` / `false` / `unspecified`). "
             "PrivAudit's labels come from an LLM run over the first 6,000 characters of each policy, so they're a "
             "reference point, not ground truth.", "",
             "| Claim | Agreement | Privany said true/false where PrivAudit said unspecified | Privany said unspecified where PrivAudit had a value |",
             "|---|---|---|---|"]
    for k in CLAIMS:
        agree = sum(r["pred"][k] == r["labels"][k] for r in rows)
        extra = sum(r["pred"][k] != "unspecified" and r["labels"][k] == "unspecified" for r in rows)
        miss = sum(r["pred"][k] == "unspecified" and r["labels"][k] != "unspecified" for r in rows)
        lines.append(f"| `{k}` | {agree}/{len(rows)} ({100 * agree / max(len(rows), 1):.0f}%) | {extra} | {miss} |")
    q_total = sum(r["quotes"]["total"] for r in rows)
    q_ok = sum(r["quotes"]["verified"] for r in rows)
    unsup = sum(r["unsupported"] for r in rows)
    asserted = sum(r["asserted"] for r in rows)
    secs = sorted(r["secs"] for r in rows)
    lines += ["", "| Evidence check | Result |", "|---|---|",
              f"| Quotes found word for word in the source | {q_ok}/{q_total} ({100 * q_ok / max(q_total, 1):.0f}%) |",
              f"| Claims asserted with a quote that doesn't exist (caught and dropped) | {unsup}/{asserted} |",
              f"| Median time per policy | {secs[len(secs) // 2]:.1f}s |" if secs else "| Median time | n/a |", ""]
    lines += ["## Confusion (rows: PrivAudit, cols: Privany)", ""]
    for k in CLAIMS:
        cm = collections.Counter((r["labels"][k], r["pred"][k]) for r in rows)
        lines += [f"**{k}**", "", "| | true | false | unspecified |", "|---|---|---|---|"]
        for a in ("true", "false", "unspecified"):
            lines.append(f"| {a} | " + " | ".join(str(cm[(a, b)]) for b in ("true", "false", "unspecified")) + " |")
        lines.append("")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--privaudit", required=True, type=Path, help="unzipped PrivAudit data/ folder")
    ap.add_argument("--n", type=int, default=40)
    ap.add_argument("--engine", choices=["rules", "gemini"], default="rules")
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    if a.engine == "gemini" and not config.GEMINI_API_KEY:
        sys.exit("Set GEMINI_API_KEY to run the gemini engine.")

    cases = load_cases(a.privaudit)
    rng = random.Random(a.seed)
    by = collections.defaultdict(list)
    for c in cases:
        by[c["labels"]["sells_data"]].append(c)
    picked = []
    for lab in by:
        rng.shuffle(by[lab])
    while len(picked) < a.n and any(by.values()):
        for lab in list(by):
            if by[lab] and len(picked) < a.n:
                picked.append(by[lab].pop())
    print(f"{len(cases)} policies with labels; evaluating {len(picked)} with {a.engine}")
    rows = asyncio.run(run(picked, a.engine))
    md = report(rows, a.engine if a.engine == "rules" else f"gemini ({config.GEMINI_MODEL})", a.n)
    out = ROOT / "eval" / f"results-{a.engine}.md"
    out.write_text(md)
    print("\n" + md + f"\n\nwrote {out}")


if __name__ == "__main__":
    main()
