"""
Turns (what the policy says) + (what we saw) + (what the user cares about)
into flags. Deterministic on purpose: the LLM reads the text, but whether
something gets flagged is decided here, where it can be tested.

Say-vs-Do gap rules come from PrivAudit (analysis/regen_joint_lens.py):
  1. claims to honor GPC, targeting cookies drop < 20% with GPC on
  2. says it doesn't sell, ad-platform tracking still happens
  3. ad-platform tracking happens, policy silent on both selling and sharing
Plus two consent checks PrivAudit's claim schema sets up but its crawl doesn't
test live: tracking before you choose, and tracking after you hit Reject.
"""

from .classify import classify_cookie
from .schema import CATEGORY_LABELS, CLAIM_LABELS

SEV = ["info", "low", "medium", "high"]

DEFAULT_PREFS = {
    "ad_tracking": 2,        # 0 = don't care, 3 = care a lot
    "selling_sharing": 3,
    "ai_training": 2,
    "sensitive_fields": 2,
    "legal_traps": 2,        # arbitration, class-action waivers, auto-renewal
    "retention_deletion": 1,
}

# which preference each policy category falls under, and its base severity
CATEGORY_RULES = {
    "data_selling":       ("selling_sharing", "permits", "high"),
    "third_party_sharing": ("selling_sharing", "permits", "medium"),
    "advertising_tracking": ("ad_tracking", "permits", "medium"),
    "location_data":      ("sensitive_fields", "permits", "medium"),
    "sensitive_data":     ("sensitive_fields", "permits", "medium"),
    "ai_training":        ("ai_training", "permits", "high"),
    "content_license":    ("ai_training", "permits", "medium"),
    "arbitration":        ("legal_traps", "permits", "medium"),
    "class_action_waiver": ("legal_traps", "permits", "medium"),
    "auto_renewal":       ("legal_traps", "permits", "medium"),
    "account_termination": ("legal_traps", "permits", "low"),
    "liability_limits":   ("legal_traps", "permits", "low"),
    "data_retention":     ("retention_deletion", "unclear", "low"),
    "international_transfer": ("selling_sharing", "permits", "low"),
}

CONTEXTS = {
    "selling_sharing": ["any", "signup", "banner"],
    "ad_tracking": ["any", "banner"],
    "sensitive_fields": ["signup"],
    "ai_training": ["upload", "signup"],
    "legal_traps": ["checkout", "signup"],
    "retention_deletion": ["signup"],
}

TITLES = {
    "data_selling": "May sell your data",
    "third_party_sharing": "Shares your data with other companies",
    "advertising_tracking": "Uses your data for targeted ads",
    "location_data": "Collects location data",
    "sensitive_data": "Collects sensitive data",
    "ai_training": "May train AI on what you upload",
    "content_license": "Takes broad rights to your content",
    "arbitration": "Forced arbitration: you can't take them to court",
    "class_action_waiver": "You give up class actions",
    "auto_renewal": "Renews automatically",
    "account_termination": "Can close your account at will",
    "liability_limits": "Limits what they owe you",
    "data_retention": "No clear limit on how long they keep data",
    "international_transfer": "Data may be sent abroad",
}


def n(count: int, word: str, plural: str | None = None) -> str:
    return f"{count} {word if count == 1 else (plural or word + 's')}"


def _shift(sev: str, weight: int) -> str | None:
    if weight <= 0:
        return None
    i = SEV.index(sev)
    if weight == 1:
        i = max(0, i - 1)
    elif weight >= 3:
        i = min(3, i + 1)
    return SEV[i]


def _claim(analysis: dict, name: str) -> str:
    return (analysis.get("claims", {}).get(name) or {}).get("value", "unspecified")


def _claim_quote(analysis: dict, name: str) -> list[dict]:
    ev = (analysis.get("claims", {}).get(name) or {}).get("evidence") or {}
    return [ev] if ev.get("verified") else []


def _flag(**kw) -> dict:
    kw.setdefault("evidence", {"quotes": [], "observed": []})
    kw.setdefault("actions", [])
    kw.setdefault("caveat", "")
    kw.setdefault("contexts", ["any"])
    return kw


def _cookie_line(c: dict) -> str:
    who = f" ({c['owner']})" if c.get("owner") else ""
    return f"{c['name']} on {c['domain']}{who}, {c['category']}"


def _actions(analysis: dict, keywords: tuple[str, ...]) -> list[dict]:
    out = []
    for o in analysis.get("opt_outs", []):
        if not (o.get("evidence") or {}).get("verified"):
            continue
        blob = (o.get("label", "") + " " + o.get("how", "")).lower()
        if not keywords or any(k in blob for k in keywords):
            out.append({"label": o["label"], "how": o["how"], "url": o.get("url") or o["evidence"].get("url")})
    return out[:3]


# ---------------------------------------------------------------------------
# consent receipts: what changed between the promises you agreed to and now
# claim -> (said when true, said when false, which value is the worse one)
CLAIM_PHRASES = {
    "sells_data": ("they may sell your data", "they don't sell your data", "true"),
    "shares_with_third_parties": ("they share your data with other companies", "they don't share your data", "true"),
    "honors_gpc": ("they honor Global Privacy Control", "they don't honor Global Privacy Control", "false"),
    "respects_dnt": ("they respect Do Not Track", "they ignore Do Not Track", "false"),
    "uses_tracking_only_after_consent": ("tracking only starts after you consent", "tracking can start before you consent", "false"),
    "sets_cookies_before_consent": ("cookies are set before you consent", "no cookies before you consent", "true"),
    "sets_cookies_after_rejecting_consent": ("cookies are set even after you reject", "no cookies after you reject", "true"),
    "deletes_cookies_on_rejection": ("they delete cookies when you reject", "they keep cookies when you reject", "false"),
}
TOPIC = {
    "sells_data": "selling your data", "shares_with_third_parties": "sharing your data", "honors_gpc": "Global Privacy Control",
    "respects_dnt": "Do Not Track", "uses_tracking_only_after_consent": "tracking before consent",
    "sets_cookies_before_consent": "cookies before consent", "sets_cookies_after_rejecting_consent": "cookies after you reject",
    "deletes_cookies_on_rejection": "deleting cookies when you reject",
}


def _said(claim: str, value: str) -> str:
    yes, no, _ = CLAIM_PHRASES[claim]
    return yes if value == "true" else no if value == "false" else f"nothing about {TOPIC[claim]}"


def _receipt_changes(receipt: dict, analysis: dict, prefs: dict) -> tuple[list[str], list[str]]:
    """Plain-language lines for what moved, plus the claims that moved the wrong way."""
    lines, worse = [], []
    then = receipt.get("claims_then") or {}
    for claim, (_, _, bad) in CLAIM_PHRASES.items():
        before = (then.get(claim) or {}).get("value", "unspecified") if claim in then else None
        after = _claim(analysis, claim)
        if before is None or before == after:
            continue
        lines.append(f"Before: {_said(claim, before)}. Now: {_said(claim, after)}.")
        good = {"true": "false", "false": "true"}[bad]
        if after == bad or (before == good and after == "unspecified"):
            worse.append(claim)
    before_cats = {f["category"] for f in receipt.get("findings_then") or [] if f.get("stance") == "permits"}
    # categories already covered by a claim line above; don't say it twice
    said = {"data_selling": "sells_data", "third_party_sharing": "shares_with_third_parties"}
    moved = {c for c in CLAIM_PHRASES if c in then and (then[c] or {}).get("value", "unspecified") != _claim(analysis, c)}
    before_cats |= {cat for cat, claim in said.items() if claim in moved}
    for f in analysis.get("findings", []):
        if not (f.get("evidence") or {}).get("verified") or f.get("stance") != "permits":
            continue
        cat = f["category"]
        rule = CATEGORY_RULES.get(cat)
        if receipt.get("findings_then") is not None and cat not in before_cats and rule and prefs.get(rule[0], 1) > 0:
            lines.append(f"New: {TITLES.get(cat, cat).lower()}. \u201c{f['evidence']['quote'][:160]}\u201d")
            before_cats.add(cat)
            if rule[2] == "high":
                worse.append(cat)
    return lines[:8], worse


def assess(site: str, analysis: dict | None, observation: dict | None = None, gpc_audit: dict | None = None,
           prior: dict | None = None, preferences: dict | None = None, receipt: dict | None = None,
           current_hashes: dict | None = None) -> dict:
    prefs = {**DEFAULT_PREFS, **(preferences or {})}
    flags, good, unknowns = [], [], []
    obs = observation or {}

    if not analysis:
        return {"verdict": "unknown", "headline": "Couldn't find or read a privacy policy for this site.",
                "flags": [], "good_signs": [], "unknowns": [], "field_hints": {}, "reject_check": None}

    # ---- what we saw live in the user's browser ---------------------------------
    cookies = [{**c, **classify_cookie(c["name"], c["domain"], site)} for c in obs.get("cookies", [])]
    ad_cookies = [c for c in cookies if c["ad_platform"]]
    ad_trackers = [t for t in obs.get("trackers", []) if t.get("ad")]
    banner = obs.get("banner") or {}
    gpc_sent = bool(obs.get("gpc_sent"))

    # ---- Say vs Do, rule 1: GPC claim vs controlled test -------------------------
    honors_gpc = _claim(analysis, "honors_gpc")
    if gpc_audit and not gpc_audit.get("inconclusive"):
        td = gpc_audit["default"]["counts"]["targeting"]
        tg = gpc_audit["gpc"]["counts"]["targeting"]
        red = gpc_audit.get("targeting_reduction")
        observed = [f"Normal visit: {n(td, 'targeting cookie')}. With GPC on: {tg}."]
        leftover = [c for c in gpc_audit["gpc"]["cookies"] if c["category"] == "targeting"][:6]
        observed += [f"Still set with GPC: {_cookie_line(c)}" for c in leftover]
        if honors_gpc == "true" and td > 0 and (red or 0) < 0.20:
            flags.append(_flag(
                id="gap_gpc", kind="gap", severity=_shift("high", prefs["ad_tracking"]) or "medium",
                title="Says it honors GPC, but tracking barely changed",
                detail=f"The policy says it respects Global Privacy Control. In our controlled test, targeting cookies "
                       f"dropped {max(red or 0, 0) * 100:.0f}% with GPC on ({td} → {tg}).",
                evidence={"quotes": _claim_quote(analysis, "honors_gpc"), "observed": observed, "test": "gpc_audit"},
                caveat="Not proof of a violation. GPC covers selling/sharing opt-outs, and some cookies may be "
                       "set but not used for that. It's a signal worth a closer look (PrivAudit rule 1).",
                contexts=["any", "banner"],
            ))
        elif honors_gpc == "true" and red is not None and red >= 0.20:
            good.append({"id": "gpc_works", "title": "GPC claim checks out",
                         "detail": f"Targeting cookies dropped {red * 100:.0f}% with GPC on, matching what the policy says."})
        elif honors_gpc != "true" and red is not None and red >= 0.5:
            good.append({"id": "gpc_quiet", "title": "Responds to GPC anyway",
                         "detail": f"The policy doesn't mention GPC, but targeting cookies dropped {red * 100:.0f}% with it on."})
    elif honors_gpc == "true" and gpc_sent and ad_cookies:
        flags.append(_flag(
            id="gap_gpc_live", kind="gap", severity="medium",
            title="Ad cookies showed up even though your browser sent GPC",
            detail=f"You have GPC on, and the policy says it honors it, but {n(len(ad_cookies), 'ad-platform cookie')} {'was' if len(ad_cookies) == 1 else 'were'} set on this visit.",
            evidence={"quotes": _claim_quote(analysis, "honors_gpc"), "observed": [_cookie_line(c) for c in ad_cookies[:6]]},
            caveat="Live observation, not a controlled test. Run the GPC test for a cleaner comparison.",
            contexts=["any", "banner"],
        ))

    # ---- Say vs Do, rule 2: "we don't sell" vs ad-platform tracking ----------------
    tracking_seen = ad_cookies or ad_trackers or (gpc_audit and gpc_audit["default"]["counts"]["ad_platform"] > 0)
    tracking_lines = [_cookie_line(c) for c in ad_cookies[:5]] + \
                     [f"Contacted {t['owner'] or t['domain']} ({t['domain']}), an ad tracker" for t in ad_trackers[:5]]
    if not tracking_lines and gpc_audit:
        tracking_lines = [_cookie_line(c) for c in gpc_audit["default"]["cookies"] if c["ad_platform"]][:6]

    sells = _claim(analysis, "sells_data")
    shares = _claim(analysis, "shares_with_third_parties")
    if sells == "false" and tracking_seen:
        sev = _shift("medium", prefs["selling_sharing"])
        if sev:
            flags.append(_flag(
                id="gap_no_sell", kind="gap", severity=sev,
                title="Says it doesn't sell your data, but ad platforms are tracking you here",
                detail="The policy says it doesn't sell personal information, yet ad-platform cookies or trackers loaded on this site.",
                evidence={"quotes": _claim_quote(analysis, "sells_data"), "observed": tracking_lines},
                caveat="Companies often argue ad pixels aren't a 'sale'. Some state laws count cross-site ad sharing anyway. "
                       "This is a mismatch to look into, not a legal finding (PrivAudit rule 2).",
                actions=_actions(analysis, ("sell", "share", "opt", "choice", "ad")),
                contexts=["any", "banner", "signup"],
            ))

    # ---- Say vs Do, rule 3: tracking with no word on selling or sharing ------------
    if tracking_seen and sells == "unspecified" and shares == "unspecified":
        sev = _shift("medium", prefs["selling_sharing"])
        if sev:
            flags.append(_flag(
                id="gap_silent", kind="gap", severity=sev,
                title="Ad platforms track you here, and the policy never says if it sells or shares data",
                detail="We saw ad-platform tracking, but couldn't find any statement about selling or sharing your data.",
                evidence={"quotes": [], "observed": tracking_lines},
                caveat="Maybe it's in a document we didn't read. Check the full policy (PrivAudit rule 3).",
                contexts=["any", "signup"],
            ))

    # ---- consent check: tracking before you chose ---------------------------------
    before = [c for c in ad_cookies if c.get("before_choice")] + [t for t in ad_trackers if t.get("before_choice")]
    if banner.get("found") and before:
        promised = _claim(analysis, "uses_tracking_only_after_consent") == "true" or \
                   _claim(analysis, "sets_cookies_before_consent") == "false"
        flags.append(_flag(
            id="before_consent", kind="gap" if promised else "behavior",
            severity=_shift("high" if promised else "medium", prefs["ad_tracking"]) or "low",
            title="Ad tracking started before you answered the cookie banner",
            detail=("The policy says tracking only happens after you consent, but " if promised else "") +
                   f"{n(len(before), 'ad cookie or tracker', 'ad cookies and trackers')} loaded while the banner was still waiting for your choice.",
            evidence={"quotes": _claim_quote(analysis, "uses_tracking_only_after_consent") or
                                _claim_quote(analysis, "sets_cookies_before_consent"),
                      "observed": [_cookie_line(c) if "name" in c else f"Contacted {c.get('owner') or c['domain']}"
                                   for c in before[:6]]},
            caveat="Rules differ by region. In the EU this usually needs consent first; many US sites don't ask at all.",
            contexts=["banner", "any"],
        ))
    elif gpc_audit and gpc_audit["default"]["banner"]["found"] and gpc_audit["default"]["counts"]["ad_platform"] > 0 \
            and _claim(analysis, "uses_tracking_only_after_consent") == "true":
        flags.append(_flag(
            id="before_consent_test", kind="gap", severity=_shift("high", prefs["ad_tracking"]) or "low",
            title="Our test saw ad cookies before anyone touched the banner",
            detail="The policy says tracking waits for consent. In our controlled visit, nobody clicked the banner, "
                   f"yet {n(gpc_audit['default']['counts']['ad_platform'], 'ad-platform cookie')} got set.",
            evidence={"quotes": _claim_quote(analysis, "uses_tracking_only_after_consent"),
                      "observed": [_cookie_line(c) for c in gpc_audit["default"]["cookies"] if c["ad_platform"]][:6],
                      "test": "gpc_audit"},
            caveat="Controlled run from our server. Your region may get a different banner.",
            contexts=["banner", "any"],
        ))

    # ---- consent check: did Reject work? ------------------------------------------
    reject_result = None
    rc = obs.get("reject_check")
    if rc:
        after_c = [classify_cookie(c["name"], c["domain"], site) for c in rc.get("new_cookies", [])]
        after_ad = [c for c in after_c if c["ad_platform"]]
        after_tr = [t for t in rc.get("ad_requests", []) if t.get("ad")]
        if rc.get("status") != "done":
            reject_result = {"status": "watching", "verdict": None, "detail": "Watching what happens after your Reject..."}
        elif after_ad or after_tr:
            promised = _claim(analysis, "uses_tracking_only_after_consent") == "true" or \
                       _claim(analysis, "deletes_cookies_on_rejection") == "true" or \
                       _claim(analysis, "sets_cookies_after_rejecting_consent") == "false"
            observed = [_cookie_line(c) for c in after_ad[:6]] + \
                       [f"Contacted {t.get('owner') or t['domain']} ({n(t.get('requests', 1), 'request')})" for t in after_tr[:6]]
            parts = []
            if after_ad:
                parts.append(f"{n(len(after_ad), 'new ad cookie')} {'was' if len(after_ad) == 1 else 'were'} set")
            if after_tr:
                parts.append(f"{n(len(after_tr), 'ad tracker')} {'was' if len(after_tr) == 1 else 'were'} still contacted")
            reject_result = {"status": "done", "verdict": "broken",
                             "detail": "After you hit Reject, " + " and ".join(parts) + ".",
                             "observed": observed}
            flags.append(_flag(
                id="reject_ignored", kind="gap" if promised else "behavior",
                severity="high" if promised else (_shift("medium", prefs["ad_tracking"]) or "low"),
                title="Your Reject didn't stop the ad tracking",
                detail=reject_result["detail"] + (" The policy says rejecting should stop this." if promised else ""),
                evidence={"quotes": _claim_quote(analysis, "uses_tracking_only_after_consent") or
                                    _claim_quote(analysis, "deletes_cookies_on_rejection"),
                          "observed": observed},
                caveat=f"Watched for {rc.get('window_s', 8)} seconds after your click. Some requests may be scripts "
                       "checking your choice rather than tracking you.",
                actions=_actions(analysis, ("cookie", "opt", "choice", "browser")),
                contexts=["banner", "any"],
            ))
        else:
            reject_result = {"status": "done", "verdict": "held",
                             "detail": f"No new ad cookies or ad-tracker calls in the {rc.get('window_s', 8)} seconds after you hit Reject."}
            good.append({"id": "reject_held", "title": "Your Reject held", "detail": reject_result["detail"]})

    # ---- what the documents say, weighted by what you care about -------------------
    seen_cats = set()
    for f in analysis.get("findings", []):
        ev = f.get("evidence") or {}
        if not ev.get("verified"):
            continue
        cat = f["category"]
        if cat in ("deletion_rights", "access_rights") and f["stance"] == "provides_right":
            good.append({"id": f"right_{cat}", "title": CATEGORY_LABELS[cat], "detail": f["statement"], "quote": ev})
            continue
        rule = CATEGORY_RULES.get(cat)
        if not rule or cat in seen_cats:
            continue
        pref, trigger, base = rule
        if f["stance"] == "prohibits":
            if cat in ("data_selling", "ai_training"):
                good.append({"id": f"no_{cat}", "title": "Says no: " + CATEGORY_LABELS[cat].lower(),
                             "detail": f["statement"], "quote": ev})
            continue
        if trigger == "permits" and f["stance"] not in ("permits", "unclear"):
            continue
        sev = _shift(base if f["stance"] == "permits" else "low", prefs[pref])
        if not sev:
            continue
        seen_cats.add(cat)
        flags.append(_flag(
            id=f"policy_{cat}", kind="policy", severity=sev, title=TITLES.get(cat, CATEGORY_LABELS[cat]),
            detail=f["statement"], evidence={"quotes": [ev], "observed": []},
            actions=_actions(analysis, {"data_selling": ("sell", "opt"), "third_party_sharing": ("share", "opt"),
                                        "advertising_tracking": ("ad", "opt", "cookie"), "ai_training": ("train", "ai", "opt"),
                                        "auto_renewal": ("cancel", "renew"), "arbitration": ("arbitrat", "opt out")}.get(cat, ())),
            caveat="What the document says it may do, not proof it does." if f["stance"] == "permits" else
                   "The wording is vague here.",
            contexts=CONTEXTS[pref],
        ))

    # ---- changed since you agreed ---------------------------------------------------
    if receipt and current_hashes:
        changed = [u for u, h in current_hashes.items() if receipt.get("hashes", {}).get(u) not in (None, h)]
        if changed:
            lines, worse = _receipt_changes(receipt, analysis, prefs)
            agreed = (receipt.get("agreed_at") or "an earlier date")[:10]
            if lines:
                detail = f"You agreed on {agreed}. Since then, what they promise has changed."
            else:
                detail = (f"You agreed on {agreed}. {n(len(changed), 'document')} {'has' if len(changed) == 1 else 'have'} "
                          f"different text now, but none of the promises Privany tracks moved.")
            flags.append(_flag(
                id="terms_changed", kind="change", severity="high" if worse else ("medium" if lines else "low"),
                title="They changed the terms since you agreed" if lines else "The terms' wording changed since you agreed",
                detail=detail,
                evidence={"quotes": [q for q in (_claim_quote(analysis, c) for c in worse) for q in q][:2],
                          "observed": lines or changed},
                caveat="Compared with the exact copy Privany saved when you agreed. Open Receipts for the full text diff.",
                contexts=["any", "signup", "checkout", "upload", "banner"],
            ))

    # ---- PrivAudit's own past audit of this site -----------------------------------
    if prior and prior.get("gaps"):
        flags.append(_flag(
            id="prior_audit", kind="prior", severity="low",
            title="Flagged in the PrivAudit research crawl",
            detail=" ".join(g["detail"] for g in prior["gaps"]),
            evidence={"quotes": [], "observed": [f"PrivAudit crawl, {prior.get('crawl_date') or 'date unknown'}"]},
            caveat="Historical research data (CCS 2026). The site may have changed since.",
            contexts=["any"],
        ))

    # ---- couldn't tell ----------------------------------------------------------------
    for name in ("sells_data", "shares_with_third_parties", "honors_gpc", "uses_tracking_only_after_consent"):
        if _claim(analysis, name) == "unspecified":
            unknowns.append({"claim": name, "label": CLAIM_LABELS[name]})
    if _claim(analysis, "sells_data") == "false" and not any(g["id"] == "no_data_selling" for g in good):
        good.append({"id": "says_no_sell", "title": "Says it doesn't sell your data",
                     "detail": "Stated in the policy.", "quote": (_claim_quote(analysis, "sells_data") or [None])[0]})

    # ---- signup field hints -------------------------------------------------------------
    hints = {}
    if prefs["sensitive_fields"] > 0:
        for fu in analysis.get("field_uses", []):
            ev = fu.get("evidence") or {}
            if ev.get("verified") and fu["field"] not in hints:
                hints[fu["field"]] = {"use": fu["use"], "shared_for_ads": fu["shared_for_ads"], "quote": ev}

    order = {s: i for i, s in enumerate(reversed(SEV))}
    # a change to terms you personally agreed to outranks everything else at the same severity
    kind_rank = {"change": -1, "gap": 0, "behavior": 1, "policy": 3, "prior": 4}
    flags.sort(key=lambda f: (order[f["severity"]], kind_rank.get(f["kind"], 9)))

    top = flags[0]["severity"] if flags else None
    verdict = "red" if top == "high" else "yellow" if top == "medium" else "green"
    gaps = sum(f["kind"] == "gap" for f in flags)
    changed = next((f for f in flags if f["id"] == "terms_changed" and f["severity"] == "high"), None)
    headline = (
        "They changed the terms since you agreed." if changed else
        "What they say and what they do don't line up here." if gaps == 1 else
        f"{gaps} places where what they say and what they do don't line up." if gaps else
        "One thing worth knowing before you agree." if len(flags) == 1 else
        f"{len(flags)} things worth knowing before you agree." if flags else
        "Nothing here clashes with your priorities."
    )
    return {"verdict": verdict, "headline": headline, "flags": flags, "good_signs": good,
            "unknowns": unknowns, "field_hints": hints, "reject_check": reject_result}
