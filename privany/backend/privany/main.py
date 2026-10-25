"""
Privany API.

  POST /v1/analyze     read a site's policy + terms -> verified claims & findings
  POST /v1/assess      claims + live observations + prefs -> flags & verdict
  POST /v1/gpc-audit   start (or return cached) controlled GPC test
  GET  /v1/gpc-audit   poll it
  POST /v1/snapshot    exact policy text, for consent receipts
  POST /v1/diff        what changed since a receipt
  GET  /v1/prior       PrivAudit's historical audit of a site

What the server gets: site names and policy URLs. Never page content, cookie
values, form input, or browsing history. Nothing is tied to a user.
"""

import asyncio
import difflib
import json
import time
from datetime import datetime, timezone
from functools import lru_cache
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import config, gpc_audit, store
from .analyze import analyze
from .classify import site_key, site_of
from .discover import discover
from .extract import Document, to_document
from .rules import assess as run_assess
from .render import render
from .safe_fetch import FetchError, check_url, fetch
from .verify import norm, verify

app = FastAPI(title="Privany", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(chrome-extension|moz-extension)://.*$|^http://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


@lru_cache(maxsize=1)
def _prior_db() -> dict:
    return json.loads((config.DATA_DIR / "prior_audits.json").read_text())


def prior_for(site: str) -> dict | None:
    return _prior_db().get(site) or _prior_db().get(site_of(site))


# ---------------------------------------------------------------------------
class Links(BaseModel):
    privacy: list[str] = Field(default_factory=list, max_length=6)
    terms: list[str] = Field(default_factory=list, max_length=6)
    cookies: list[str] = Field(default_factory=list, max_length=6)


class AnalyzeIn(BaseModel):
    site_url: str
    links: Links = Field(default_factory=Links)
    fresh: bool = False
    # refetch the documents even when cached; only re-read them if the text changed.
    # The extension asks for this on sites where you have a consent receipt.
    revalidate: bool = False


def _pick(links: Links) -> list[tuple[str, str]]:
    out, seen = [], set()
    for kind, urls, cap in (("privacy", links.privacy, 1), ("cookies", links.cookies, 1), ("terms", links.terms, 1)):
        n = 0
        for u in urls:
            key = u.split("#")[0].rstrip("/")
            if key in seen or n >= cap or urlparse(u).scheme not in ("http", "https"):
                continue
            seen.add(key)
            out.append((u.split("#")[0], kind))
            n += 1
    return out


async def _load_docs(targets: list[tuple[str, str]]) -> tuple[list[Document], list[str]]:
    async def one(url, kind):
        try:
            doc = to_document(await fetch(url), kind)
        except FetchError as e:
            return None, f"{url}: {e}"
        except Exception as e:
            return None, f"{url}: couldn't read ({type(e).__name__})"
        # thin page = probably built by JavaScript; render it in a real browser and read that instead
        if doc.partial and config.RENDER_FALLBACK and not url.lower().endswith(".pdf"):
            try:
                rendered = to_document(await render(url), kind)
                if len(rendered.text) > len(doc.text):
                    rendered.notes = [n for n in rendered.notes if "JavaScript" not in n]
                    rendered.notes.append("This page builds its text with JavaScript, so Privany rendered it in a browser to read it.")
                    rendered.rendered = True
                    rendered.partial = len(rendered.text) < 300   # short policies exist; only flag near-empty ones
                    return rendered, None
            except Exception as e:
                doc.notes.append(f"Tried rendering it in a browser too, but that failed ({str(e)[:80]}).")
        return doc, None

    results = await asyncio.gather(*(one(u, k) for u, k in targets))
    docs = [d for d, _ in results if d and len(d.paragraphs) > 0]
    errors = [e for _, e in results if e]
    return docs, errors


@app.post("/v1/analyze")
async def analyze_site(body: AnalyzeIn):
    try:
        await check_url(body.site_url)
    except FetchError as e:
        raise HTTPException(400, f"Can't analyze this site: {e}")
    site = site_key(body.site_url)
    links = body.links
    discovered = False
    if not (links.privacy or links.terms or links.cookies):
        links = Links(**await discover(body.site_url))
        discovered = True
    targets = _pick(links)
    cache_id = config.LLM_MODE + "|" + "|".join(sorted(u for u, _ in targets))

    cached = None
    if targets and not body.fresh:
        cached = store.get("analysis", cache_id, config.ANALYSIS_TTL_DAYS * 86400)
        if cached and not body.revalidate:
            cached["cached"] = True
            return cached

    docs, errors = await _load_docs(targets)
    if cached and docs:
        then = {d["url"]: d["content_hash"] for d in cached["documents"]}
        now = {d.url: d.content_hash for d in docs}
        if then == now:
            cached["cached"] = True
            cached["revalidated"] = True
            return cached
    if not docs:
        return {"site": site, "engine": None, "documents": [], "analysis": None, "prior_audit": prior_for(site),
                "errors": errors or ["No privacy policy or terms link found on this page."],
                "discovered_links": discovered, "cached": False}

    raw, engine = await analyze(site, docs)
    verified = verify(raw, docs)
    result = {
        "site": site,
        "engine": engine,
        "analyzed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "documents": [{"url": d.url, "kind": d.kind, "content_hash": d.content_hash, "retrieved_at": d.retrieved_at,
                       "paragraphs": len(d.paragraphs), "partial": d.partial, "rendered": d.rendered,
                       "notes": d.notes} for d in docs],
        "analysis": verified,
        "prior_audit": prior_for(site),
        "errors": errors,
        "discovered_links": discovered,
        "cached": False,
    }
    store.put("analysis", cache_id, result)
    return result


# ---------------------------------------------------------------------------
class AssessIn(BaseModel):
    site: str
    analysis: dict | None = None
    documents: list[dict] = Field(default_factory=list)
    observation: dict | None = None
    gpc_audit: dict | None = None
    preferences: dict | None = None
    receipt: dict | None = None


@app.post("/v1/assess")
async def assess(body: AssessIn):
    key = site_key(body.site)
    page_site = site_of(urlparse(body.site if "://" in body.site else "http://" + body.site).hostname or "")
    audit = body.gpc_audit or store.get("gpc", key, config.GPC_AUDIT_TTL_HOURS * 3600)
    hashes = {d["url"]: d["content_hash"] for d in body.documents if d.get("url") and d.get("content_hash")}
    return run_assess(page_site, body.analysis, body.observation, audit, prior_for(key), body.preferences,
                      body.receipt, hashes)


# ---------------------------------------------------------------------------
_jobs: dict[str, dict] = {}
_audit_slots = asyncio.Semaphore(2)


class GpcIn(BaseModel):
    site_url: str
    fresh: bool = False


async def _run_job(site: str, url: str):
    async with _audit_slots:
        try:
            result = await asyncio.wait_for(gpc_audit.run(url, runs=1), timeout=150)
            store.put("gpc", site, result)
            _jobs[site] = {"status": "done", "result": result}
        except Exception as e:
            _jobs[site] = {"status": "error", "error": str(e)[:300]}


@app.post("/v1/gpc-audit")
async def start_gpc(body: GpcIn):
    try:
        await check_url(body.site_url)
    except FetchError as e:
        raise HTTPException(400, str(e))
    p = urlparse(body.site_url)
    site = site_key(body.site_url)
    if not body.fresh:
        cached = store.get("gpc", site, config.GPC_AUDIT_TTL_HOURS * 3600)
        if cached:
            return {"status": "done", "result": cached, "cached": True}
    job = _jobs.get(site)
    if job and job["status"] == "running":
        return {"status": "running", "started": job["started"]}
    _jobs[site] = {"status": "running", "started": time.time()}
    asyncio.create_task(_run_job(site, f"{p.scheme}://{p.netloc}/"))
    return {"status": "running", "started": _jobs[site]["started"]}


@app.get("/v1/gpc-audit")
async def poll_gpc(site: str):
    site = site_key(site)
    job = _jobs.get(site)
    if job:
        return job
    cached = store.get("gpc", site, config.GPC_AUDIT_TTL_HOURS * 3600)
    return {"status": "done", "result": cached, "cached": True} if cached else {"status": "none"}


# ---------------------------------------------------------------------------
class SnapshotIn(BaseModel):
    urls: list[str] = Field(max_length=4)


@app.post("/v1/snapshot")
async def snapshot(body: SnapshotIn):
    docs, errors = await _load_docs([(u, None) for u in body.urls])
    return {"documents": [{"url": d.url, "kind": d.kind, "content_hash": d.content_hash,
                           "retrieved_at": d.retrieved_at, "paragraphs": d.paragraphs} for d in docs],
            "errors": errors}


class DiffIn(BaseModel):
    url: str
    old_hash: str
    old_paragraphs: list[str] = Field(max_length=5000)


@app.post("/v1/diff")
async def diff(body: DiffIn):
    docs, errors = await _load_docs([(body.url, None)])
    if not docs:
        raise HTTPException(502, errors[0] if errors else "couldn't fetch the current version")
    new = docs[0]
    if new.content_hash == body.old_hash:
        return {"changed": False, "new_hash": new.content_hash}
    a = [norm(p) for p in body.old_paragraphs]
    b = [norm(p) for p in new.paragraphs]
    sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    added, removed = [], []
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op in ("replace", "delete"):
            removed += body.old_paragraphs[i1:i2]
        if op in ("replace", "insert"):
            added += new.paragraphs[j1:j2]
    return {"changed": True, "new_hash": new.content_hash, "retrieved_at": new.retrieved_at,
            "added": added[:40], "removed": removed[:40],
            "similarity": round(sm.ratio(), 3)}


# ---------------------------------------------------------------------------
@app.get("/v1/prior")
async def prior(site: str):
    return {"site": site_key(site), "prior_audit": prior_for(site_key(site))}


@app.get("/health")
async def health():
    return {"ok": True, "engine": config.LLM_MODE, "model": config.GEMINI_MODEL if config.LLM_MODE == "gemini" else None,
            "allow_local": config.ALLOW_LOCAL, "prior_audits": len(_prior_db())}
