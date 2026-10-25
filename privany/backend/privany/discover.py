"""Fallback: find policy/terms links from a site's homepage."""

import re
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

from .safe_fetch import FetchError, fetch

PRIVACY = re.compile(r"privacy|datenschutz|confidentialit|privacidad", re.I)
TERMS = re.compile(r"terms|conditions|user agreement|\btos\b|legal notice|nutzungsbedingungen", re.I)
COOKIE = re.compile(r"cookie (policy|notice)", re.I)


def classify_link(text: str, href: str) -> str | None:
    blob = f"{text} {href}"
    if COOKIE.search(blob):
        return "cookies"
    if PRIVACY.search(blob) and not re.search(r"privacy (choices|settings|center)", text, re.I):
        return "privacy"
    if TERMS.search(blob):
        return "terms"
    return None


async def discover(site_url: str) -> dict[str, list[str]]:
    found = {"privacy": [], "terms": [], "cookies": []}
    try:
        f = await fetch(site_url)
    except FetchError:
        return found
    soup = BeautifulSoup(f.content.decode("utf-8", "replace"), "html.parser")
    for link in soup.select('link[rel~="privacy-policy"], link[rel~="terms-of-service"]'):
        kind = "privacy" if "privacy" in " ".join(link.get("rel", [])) else "terms"
        found[kind].append(urljoin(f.url, link.get("href", "")))
    for a in soup.find_all("a", href=True):
        href = urljoin(f.url, a["href"])
        if urlparse(href).scheme not in ("http", "https"):
            continue
        kind = classify_link(a.get_text(" ", strip=True)[:80], a["href"])
        if kind and href not in found[kind]:
            found[kind].append(href)
    return {k: v[:2] for k, v in found.items()}
