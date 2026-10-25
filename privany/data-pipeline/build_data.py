"""
Builds the lookup files Privany ships with, from three public sources:

  1. PrivAudit (CCS 2026, CC BY 4.0)        -> cookie categories + prior audits of 937 sites
  2. DuckDuckGo Tracker Radar blocklist (TDS) -> tracker domains, owners, categories
  3. Open Cookie Database (Apache 2.0)       -> cookie name -> category fallback

Usage:
  python build_data.py --privaudit /path/to/unzipped/privaudit/data \
                       --tds /path/to/extension-tds.json \
                       --ocd /path/to/open-cookie-database.csv \
                       --out ..

Outputs:
  extension/src/data/trackers.json
  extension/src/data/cookies.json
  backend/privany/data/trackers.json      (same file, backend copy)
  backend/privany/data/cookies.json       (same file, backend copy)
  backend/privany/data/prior_audits.json
"""

import argparse
import collections
import csv
import json
import re
import sys
from pathlib import Path

csv.field_size_limit(sys.maxsize)

# ---------------------------------------------------------------------------
# Cookie categories. Same 4-bucket taxonomy PrivAudit uses
# (cookie_categorization/cookie_categorization.py), so our labels line up
# with the paper's numbers.
# ---------------------------------------------------------------------------
CATEGORY_KEYWORDS = {
    "necessary": ["necessary", "essential", "required", "mandatory", "security"],
    "functional": ["functional", "preference", "preferences", "social media", "support"],
    "performance": ["performance", "analytics", "statistics", "measurement", "load balancing"],
    "targeting": ["targeting", "advertis", "marketing", "tracking", "profiling", "personalization"],
}


def standardize_category(raw: str) -> str | None:
    if not raw:
        return None
    c = re.sub(r"[^a-z0-9 ]", "", str(raw).lower().strip())
    if not c or c in ("unknown", "nan", "other", "unclassified"):
        return None
    # check targeting first: "advertisement" shouldn't fall into anything else
    for cat in ("targeting", "performance", "necessary", "functional"):
        if any(k in c for k in CATEGORY_KEYWORDS[cat]):
            return cat
    return None


def norm_domain(x: str) -> str:
    x = re.sub(r"^https?://", "", str(x).strip().lower())
    return re.sub(r"^www\.", "", x).split("/")[0]


# ---------------------------------------------------------------------------
# 1. Trackers from DuckDuckGo TDS
# ---------------------------------------------------------------------------
AD_CATEGORIES = {
    "Ad Motivated Tracking", "Advertising", "Third-Party Analytics Marketing",
    "Action Pixels", "Audience Measurement", "Session Replay",
    "Obscure Ownership", "Unknown High Risk Behavior",
}


def build_trackers(tds_path: Path) -> dict:
    tds = json.loads(tds_path.read_text())
    out = {}
    for domain, info in tds["trackers"].items():
        cats = info.get("categories", []) or []
        owner = (info.get("owner") or {}).get("displayName") or (info.get("owner") or {}).get("name") or ""
        out[domain] = {
            "o": owner,
            "c": cats,
            # "ad" = the tracker exists to follow people for ads/marketing,
            # not to serve content or take payments
            "ad": bool(set(cats) & AD_CATEGORIES) or (not cats and info.get("default") == "block"),
            "fp": info.get("fingerprinting", 0),
        }
    return out


# ---------------------------------------------------------------------------
# 2. Cookie categories: PrivAudit first (it's what the paper used), OCD fallback
# ---------------------------------------------------------------------------
def build_cookies(privaudit_dir: Path, ocd_path: Path) -> dict:
    votes: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)

    pa_csv = privaudit_dir / "final_default_state_comprehensive_reclassified.csv"
    with pa_csv.open(newline="", encoding="utf-8", errors="replace") as f:
        for row in csv.DictReader(f):
            name = (row.get("cookie_name") or "").strip()
            cat = standardize_category(row.get("category"))
            if name and cat:
                votes[name.lower()][cat] += 1

    exact = {name: c.most_common(1)[0][0] for name, c in votes.items()}
    pa_count = len(exact)

    prefixes = []
    # who runs the cookie (e.g. _fbp -> Meta). Lets us tell a site's own cookie
    # from one an ad platform's script dropped on the site's domain.
    platform: dict[str, str] = {}
    with ocd_path.open(newline="", encoding="utf-8", errors="replace") as f:
        for row in csv.DictReader(f):
            name = (row.get("Cookie / Data Key name") or "").strip().lower()
            cat = standardize_category(row.get("Category"))
            if not name or not cat:
                continue
            owner = (row.get("Data Controller") or row.get("Platform") or "").strip()
            if str(row.get("Wildcard match")).strip() in ("1", "TRUE", "true"):
                prefixes.append([name, cat, owner])
            else:
                if name not in exact:
                    exact[name] = cat
                if owner and name not in platform:
                    platform[name] = owner

    # longest prefix first so "_ga_" beats "_g"
    prefixes.sort(key=lambda p: -len(p[0]))
    print(f"  cookies: {pa_count} from PrivAudit, {len(exact) - pa_count} from OCD, "
          f"{len(prefixes)} wildcard prefixes, {len(platform)} with a known platform")
    return {"exact": exact, "prefix": prefixes, "platform": platform}


# ---------------------------------------------------------------------------
# 3. Prior audits: PrivAudit's two lenses, joined per site with the paper's rules
#    (analysis/regen_joint_lens.py)
# ---------------------------------------------------------------------------
TARGETING = {"targeting", "advertisement", "targeting cookies"}


def present(v) -> bool:
    return v is not None and str(v).strip() != ""


def build_prior_audits(privaudit_dir: Path) -> dict:
    audit = json.loads((privaudit_dir / "ccpa_policy_audit_data_source_mapped.json").read_text())

    # count targeting cookies per site in Default vs GPC configurations
    counts = collections.defaultdict(lambda: collections.Counter())
    crawl_dates = {}
    pa_csv = privaudit_dir / "final_default_state_comprehensive_reclassified.csv"
    with pa_csv.open(newline="", encoding="utf-8", errors="replace") as f:
        for row in csv.DictReader(f):
            site = norm_domain(row["website"])
            is_tgt = str(row.get("category", "")).strip().lower() in TARGETING
            is_3p = str(row.get("script_is_third_party", "No")).strip() == "Yes"
            c = counts[site]
            c["has_cookie"] = 1
            if present(row.get("initial_cookies")):
                c["all_default"] += 1
                if is_tgt:
                    c["tgt_default"] += 1
                    if is_3p:
                        c["tgt3p_default"] += 1
            if present(row.get("gpc_enabled")):
                c["all_gpc"] += 1
                if is_tgt:
                    c["tgt_gpc"] += 1
                    if is_3p:
                        c["tgt3p_gpc"] += 1
            ts = (row.get("timestamp") or "")[:10]
            if ts and (site not in crawl_dates or ts < crawl_dates[site]):
                crawl_dates[site] = ts

    out = {}
    for dom, rec in audit.items():
        site = norm_domain(dom)
        ad = rec.get("audit_data") or {}
        bc = ad.get("behavioral_claims") or {}
        ra = ad.get("rubric_assessment") or {}
        dm = ra.get("disclosure_map") or {}
        c = counts.get(site, collections.Counter())

        gaps = []
        # Rule 1: claims to honor GPC, but targeting cookies drop < 20% with GPC on
        if str(bc.get("honors_gpc")).lower() == "true" and c["tgt_default"] > 0:
            reduction = (c["tgt_default"] - c["tgt_gpc"]) / c["tgt_default"]
            if reduction < 0.20:
                gaps.append({
                    "rule": "gpc_claim_no_reduction",
                    "detail": f"Policy says it honors GPC, but targeting cookies only dropped "
                              f"{max(reduction, 0) * 100:.0f}% with GPC on ({c['tgt_default']} -> {c['tgt_gpc']}).",
                })
        # Rule 2: says it doesn't sell, still sets third-party targeting cookies
        if bc.get("sells_data") is False and c["tgt3p_default"] > 0:
            gaps.append({
                "rule": "no_sell_claim_3p_tracking",
                "detail": f"Policy says it doesn't sell data, but {c['tgt3p_default']} third-party "
                          f"targeting cookie(s) were set on a default visit.",
            })
        # Rule 3: sets third-party targeting cookies, policy silent on sale and sharing
        if c["tgt3p_default"] > 0 and bc.get("sells_data") == "unspecified" \
                and bc.get("shares_with_third_parties") == "unspecified" and dm.get("data_shared") is not True:
            gaps.append({
                "rule": "silent_on_sale_and_sharing",
                "detail": "Third-party targeting cookies were set, but the policy says nothing "
                          "about selling or sharing data.",
            })

        out[site] = {
            "policy_url": rec.get("privacy_policy_url"),
            "claims": {k: bc.get(k) for k in (
                "honors_gpc", "respects_dnt", "sets_cookies_before_consent",
                "sets_cookies_after_rejecting_consent", "deletes_cookies_on_rejection",
                "uses_tracking_only_after_consent", "sells_data", "shares_with_third_parties")},
            "disclosures": dm,
            "scores": {k: ra.get(k) for k in ("completeness_score", "usability_score", "accuracy_score")},
            "cookies": {k: c[k] for k in ("all_default", "all_gpc", "tgt_default", "tgt_gpc",
                                         "tgt3p_default", "tgt3p_gpc")} if c else None,
            "crawl_date": crawl_dates.get(site),
            "gaps": gaps,
        }
    with_gaps = sum(1 for v in out.values() if v["gaps"])
    print(f"  prior audits: {len(out)} sites, {with_gaps} with at least one PrivAudit gap signal")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--privaudit", required=True, type=Path)
    ap.add_argument("--tds", required=True, type=Path)
    ap.add_argument("--ocd", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path, help="repo root")
    a = ap.parse_args()

    ext_data = a.out / "extension" / "src" / "data"
    be_data = a.out / "backend" / "privany" / "data"
    ext_data.mkdir(parents=True, exist_ok=True)
    be_data.mkdir(parents=True, exist_ok=True)

    print("building trackers...")
    trackers = build_trackers(a.tds)
    print(f"  trackers: {len(trackers)} domains")
    print("building cookies...")
    cookies = build_cookies(a.privaudit, a.ocd)
    print("building prior audits...")
    prior = build_prior_audits(a.privaudit)

    for d in (ext_data, be_data):
        (d / "trackers.json").write_text(json.dumps(trackers, separators=(",", ":")))
        (d / "cookies.json").write_text(json.dumps(cookies, separators=(",", ":")))
    (be_data / "prior_audits.json").write_text(json.dumps(prior, separators=(",", ":")))
    print("done.")


if __name__ == "__main__":
    main()
