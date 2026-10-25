"""
Turn a fetched policy into numbered paragraphs. Paragraph numbers are what the
LLM cites, and what we use to check its quotes actually exist.
"""

import hashlib
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone

from bs4 import BeautifulSoup

try:
    import trafilatura
except ImportError:  # pragma: no cover
    trafilatura = None

from .safe_fetch import Fetched

BLOCK_TAGS = ["p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "td", "dd", "dt", "blockquote"]


@dataclass
class Document:
    url: str
    kind: str                     # "privacy" | "terms" | "cookies" | "other"
    paragraphs: list[str]
    content_hash: str
    retrieved_at: str
    partial: bool = False
    rendered: bool = False          # had to load it in a browser (JavaScript-built page)
    notes: list[str] = field(default_factory=list)

    @property
    def text(self) -> str:
        return "\n\n".join(self.paragraphs)


def _clean(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def _html_paragraphs(html: str) -> list[str]:
    paras: list[str] = []
    if trafilatura is not None:
        txt = trafilatura.extract(html, include_comments=False, include_tables=True, favor_recall=True)
        if txt and len(txt) > 500:
            paras = [_clean(p) for p in re.split(r"\n\s*\n|\n", txt)]
    if not paras or sum(len(p) for p in paras) < 500:
        soup = BeautifulSoup(html, "html.parser")
        for t in soup(["script", "style", "noscript", "nav", "footer", "header", "svg", "form"]):
            t.decompose()
        seen = set()
        out = []
        for el in soup.find_all(BLOCK_TAGS):
            # skip containers whose text is already covered by a nested block
            if el.find(BLOCK_TAGS):
                continue
            t = _clean(el.get_text(" "))
            if t and t not in seen:
                seen.add(t)
                out.append(t)
        if sum(len(p) for p in out) > sum(len(p) for p in paras):
            paras = out
    return [p for p in paras if len(p) > 1]


def _pdf_paragraphs(data: bytes) -> list[str]:
    import pymupdf
    doc = pymupdf.open(stream=data, filetype="pdf")
    paras = []
    for page in doc:
        for block in page.get_text("blocks"):
            t = _clean(block[4])
            if t:
                paras.append(t)
    return paras


def guess_kind(url: str, paragraphs: list[str]) -> str:
    u = url.lower()
    head = " ".join(paragraphs[:5]).lower()
    if "cookie" in u and "polic" in u:
        return "cookies"
    if any(k in u for k in ("privacy", "data-policy", "datenschutz")) or "privacy policy" in head or "privacy notice" in head:
        return "privacy"
    if any(k in u for k in ("terms", "tos", "conditions", "legal/user-agreement", "eula")) or "terms of" in head:
        return "terms"
    return "other"


def to_document(f: Fetched, kind_hint: str | None = None) -> Document:
    if f.content_type == "application/pdf":
        paras = _pdf_paragraphs(f.content)
    else:
        html = f.content.decode("utf-8", errors="replace")
        paras = _html_paragraphs(html) if "<" in html[:2000] else [_clean(p) for p in html.split("\n\n") if _clean(p)]
    text = "\n\n".join(paras)
    doc = Document(
        url=f.url,
        kind=kind_hint or guess_kind(f.url, paras),
        paragraphs=paras,
        content_hash=hashlib.sha256(text.encode()).hexdigest()[:16],
        retrieved_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
    )
    if len(text) < 800:
        doc.partial = True
        doc.notes.append("Very little text came back. The page may need JavaScript to render, so this read is likely incomplete.")
    return doc
