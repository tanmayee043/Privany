"""
The model's quotes have to exist in the source. Anything that can't be found
gets marked unverified; unverified claims fall back to "unspecified" so they
can never drive a red flag.
"""

import re
import unicodedata

from .extract import Document

_TRANS = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"',
                        "–": "-", "—": "-", " ": " ", "…": "..."})


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "").translate(_TRANS)
    return re.sub(r"\s+", " ", s).strip().lower()


def locate(quote: str, docs: list[Document], doc_hint: int, para_hint: int) -> tuple[int, int] | None:
    q = norm(quote).strip(" .\"'")
    if len(q) < 12:
        return None
    # cited paragraph first, then anywhere
    if 0 <= doc_hint < len(docs) and 0 <= para_hint < len(docs[doc_hint].paragraphs):
        if q in norm(docs[doc_hint].paragraphs[para_hint]):
            return doc_hint, para_hint
    for di, d in enumerate(docs):
        for pi, p in enumerate(d.paragraphs):
            if q in norm(p):
                return di, pi
    # quotes that span two adjacent paragraphs
    for di, d in enumerate(docs):
        for pi in range(len(d.paragraphs) - 1):
            if q in norm(d.paragraphs[pi] + " " + d.paragraphs[pi + 1]):
                return di, pi
    return None


def _evidence(item: dict, docs: list[Document]) -> dict:
    loc = locate(item.get("quote", ""), docs, item.get("doc", -1), item.get("para", -1))
    if loc is None:
        return {"quote": item.get("quote", ""), "verified": False, "url": None, "para": None}
    di, pi = loc
    return {"quote": item["quote"].strip(), "verified": True, "url": docs[di].url, "para": pi,
            "doc_kind": docs[di].kind}


def verify(raw: dict, docs: list[Document]) -> dict:
    stats = {"total": 0, "verified": 0}

    def track(ev):
        if ev["quote"]:
            stats["total"] += 1
            stats["verified"] += ev["verified"]
        return ev

    claims = {}
    for c in raw.get("claims", []):
        name = c.get("claim")
        if not name or name in claims:
            continue
        value = c.get("value", "unspecified")
        ev = track(_evidence(c, docs)) if c.get("quote") else {"quote": "", "verified": False, "url": None, "para": None}
        if value != "unspecified" and not ev["verified"]:
            # can't back it up -> don't use it
            value = "unspecified"
            note = "The model gave an answer, but its quote wasn't found in the policy, so we're not using it."
        else:
            note = c.get("note", "")
        claims[name] = {"value": value, "evidence": ev, "note": note}

    def verified_list(items, keep_keys):
        out = []
        for it in items or []:
            ev = track(_evidence(it, docs))
            row = {k: it.get(k) for k in keep_keys}
            row["evidence"] = ev
            out.append(row)
        return out

    findings = verified_list(raw.get("findings"), ["category", "stance", "statement"])
    field_uses = verified_list(raw.get("field_uses"), ["field", "use", "shared_for_ads"])
    opt_outs = verified_list(raw.get("opt_outs"), ["label", "how", "url"])

    # an opt-out link the model "found" must literally appear in the text
    full = norm(" ".join(p for d in docs for p in d.paragraphs))
    for o in opt_outs:
        if o.get("url") and norm(o["url"]) not in full:
            o["url"] = ""

    return {
        "summary": raw.get("summary", ""),
        "claims": claims,
        "findings": findings,
        "field_uses": field_uses,
        "opt_outs": opt_outs,
        "quote_check": stats,
    }
