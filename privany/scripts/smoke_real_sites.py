"""
Run Privany against real websites before the demo, to find out which ones work
well live. Needs the backend running (./scripts/dev.sh start, ideally with your
GEMINI_API_KEY set). Writes eval/real-sites.md.

  python scripts/smoke_real_sites.py                      # default list below
  python scripts/smoke_real_sites.py nike.com target.com  # your own

The defaults come from PrivAudit's data: Papa John's, Domino's, Starbucks and
Grubhub claimed to honor GPC (or not to sell) and their crawl caught a gap;
Pizza Hut and Ulta claim GPC and their tracking actually dropped. If the gaps
reproduce today, you have a live, real-world demo.
"""

import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

API = "http://localhost:8787"
DEFAULT = ["papajohns.com", "dominos.com", "pizzahut.com", "starbucks.com", "grubhub.com", "ulta.com"]
OUT = Path(__file__).resolve().parent.parent / "eval" / "real-sites.md"


def call(path, body=None, timeout=180):
    req = urllib.request.Request(API + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"}, method="POST" if body is not None else "GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def run(site: str) -> dict:
    url = site if site.startswith("http") else f"https://www.{site}/"
    row = {"site": site, "url": url}
    t0 = time.time()
    try:
        a = call("/v1/analyze", {"site_url": url, "links": {}, "fresh": True})
    except urllib.error.HTTPError as e:
        return {**row, "error": f"analyze: HTTP {e.code} {e.read()[:120]!r}"}
    except Exception as e:
        return {**row, "error": f"analyze: {e}"}
    row["analyze_s"] = round(time.time() - t0, 1)
    row["engine"] = a.get("engine")
    row["docs"] = [f"{d['kind']}{' (rendered)' if d.get('rendered') else ''}{' (partial)' if d.get('partial') else ''}"
                   for d in a.get("documents", [])]
    row["errors"] = a.get("errors", [])
    an = a.get("analysis")
    if not an:
        return {**row, "error": "no policy found/readable: " + "; ".join(row["errors"])[:200]}
    row["claims"] = {k: an["claims"][k]["value"] for k in ("honors_gpc", "sells_data", "shares_with_third_parties")}
    row["quotes"] = f"{an['quote_check']['verified']}/{an['quote_check']['total']}"

    t1 = time.time()
    g = call("/v1/gpc-audit", {"site_url": url, "fresh": True}, timeout=30)
    while g.get("status") == "running" and time.time() - t1 < 180:
        time.sleep(4)
        g = call(f"/v1/gpc-audit?site={site}", timeout=30)
    row["gpc_s"] = round(time.time() - t1, 1)
    audit = g.get("result")
    if audit:
        row["targeting"] = f"{audit['default']['counts']['targeting']} → {audit['gpc']['counts']['targeting']}"
        row["banner"] = audit["default"]["banner"]["found"]
        row["inconclusive"] = audit["inconclusive"]
    else:
        row["targeting"] = f"test failed: {g.get('error', g.get('status'))}"[:80]

    s = call("/v1/assess", {"site": url, "analysis": an, "documents": a["documents"], "gpc_audit": audit})
    row["verdict"] = s["verdict"]
    row["gaps"] = [f["title"] for f in s["flags"] if f["kind"] == "gap"]
    prior = a.get("prior_audit") or {}
    row["privaudit_then"] = [g["rule"] for g in prior.get("gaps", [])]
    return row


def main():
    sites = sys.argv[1:] or DEFAULT
    try:
        h = call("/health", timeout=5)
    except Exception:
        sys.exit("Backend isn't running. Start it with ./scripts/dev.sh start")
    print(f"backend engine: {h['engine']}{' (' + h['model'] + ')' if h.get('model') else ''}\n")
    rows = []
    for s in sites:
        print(f"→ {s} ...", flush=True)
        r = run(s)
        rows.append(r)
        if r.get("error"):
            print(f"   ✗ {r['error']}")
        else:
            print(f"   {r['verdict']:7s} gaps: {len(r['gaps'])}  claims {r['claims']}  targeting GPC off→on {r['targeting']}  "
                  f"docs {r['docs']}  ({r['analyze_s']}s + {r['gpc_s']}s)")

    lines = [f"# Real-site check ({time.strftime('%Y-%m-%d %H:%M')}, engine: {h['engine']})", "",
             "| Site | Verdict | Says GPC / sells / shares | Targeting cookies GPC off → on | Gaps now | PrivAudit flagged then | Docs read | Time |",
             "|---|---|---|---|---|---|---|---|"]
    for r in rows:
        if r.get("error"):
            lines.append(f"| {r['site']} | error | {r['error'][:80]} | | | | | |")
            continue
        c = r["claims"]
        lines.append(f"| {r['site']} | {r['verdict']} | {c['honors_gpc']} / {c['sells_data']} / {c['shares_with_third_parties']} | "
                     f"{r['targeting']} | {'; '.join(r['gaps']) or 'none'} | {', '.join(r['privaudit_then']) or 'none'} | "
                     f"{', '.join(r['docs'])} | {r['analyze_s'] + r.get('gpc_s', 0):.0f}s |")
    lines += ["", "Pick demo sites where the gap shows up today *and* the run was quick. Results depend on your region "
              "(the GPC test runs from wherever the backend runs)."]
    OUT.write_text("\n".join(lines))
    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    main()
