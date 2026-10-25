"""Cookie + tracker classification, same data the extension ships with."""

import json
from functools import lru_cache

import tldextract

from . import config

_tld = tldextract.TLDExtract(suffix_list_urls=(), cache_dir=None)


def site_of(host: str) -> str:
    """Registrable domain: shop.example.co.uk -> example.co.uk"""
    host = (host or "").lstrip(".").lower().split(":")[0]
    ext = _tld(host)
    return getattr(ext, "top_domain_under_public_suffix", None) or host


def site_key(url_or_host: str) -> str:
    """Cache/lookup key for a site. Same as site_of, except local dev hosts keep
    their port so two demo shops on localhost don't collide."""
    from urllib.parse import urlparse
    s = url_or_host if "://" in url_or_host else "http://" + url_or_host
    p = urlparse(s)
    host = (p.hostname or "").lower()
    base = site_of(host)
    if p.port and (host == "localhost" or host.replace(".", "").isdigit()):
        return f"{base}:{p.port}"
    return base


@lru_cache(maxsize=1)
def _trackers() -> dict:
    return json.loads((config.DATA_DIR / "trackers.json").read_text())


@lru_cache(maxsize=1)
def _cookies() -> dict:
    return json.loads((config.DATA_DIR / "cookies.json").read_text())


def tracker_for(host: str) -> dict | None:
    host = (host or "").lstrip(".").lower()
    t = _trackers()
    parts = host.split(".")
    for i in range(len(parts) - 1):
        cand = ".".join(parts[i:])
        if cand in t:
            info = t[cand]
            return {"domain": cand, "owner": info["o"], "categories": info["c"], "ad": info["ad"]}
    return None


def cookie_category(name: str, cookie_domain: str = "") -> tuple[str, str | None]:
    """Returns (category, platform that runs it if known)."""
    db = _cookies()
    n = (name or "").lower()
    plat = db.get("platform", {}).get(n)
    if n in db["exact"]:
        return db["exact"][n], plat
    for prefix, cat, owner in db["prefix"]:
        if n.startswith(prefix):
            return cat, owner or None
    tr = tracker_for(cookie_domain)
    if tr and tr["ad"]:
        return "targeting", tr["owner"]
    return "unknown", plat


def classify_cookie(name: str, domain: str, page_site: str) -> dict:
    cookie_site = site_of(domain)
    tr = tracker_for(domain)
    category, platform = cookie_category(name, domain)
    third_party = bool(cookie_site) and cookie_site != page_site
    owner = tr["owner"] if tr else platform
    return {
        "name": name,
        "domain": domain.lstrip("."),
        "category": category,
        "third_party": third_party,
        "owner": owner,
        # an ad-platform cookie, whether it sits on their domain (IDE on doubleclick)
        # or was dropped on the site's own domain by their script (_fbp, _gcl_au)
        "ad_platform": category == "targeting" and (third_party or bool(platform)),
    }
