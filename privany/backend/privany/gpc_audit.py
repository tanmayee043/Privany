"""
Controlled GPC test, ported from PrivAudit's behavior lens
(crawler/gpc_toolkit/simple_gpc_test.js + banner_detection/).

Visits the site in two fresh browser profiles, no clicks on any banner:
  default : normal browser
  gpc     : sends `Sec-GPC: 1` and exposes navigator.globalPrivacyControl = true
Then compares the cookies each one ends up with.

Because nobody touches the consent banner, the default run also shows what the
site sets *before* you make a choice.
"""

import asyncio
import ipaddress
import json
import os
import socket
from datetime import datetime, timezone
from urllib.parse import urlparse

from . import config
from .classify import classify_cookie, site_of, tracker_for
from .safe_fetch import FetchError, check_url, fetch, is_local_name

# use a preinstalled browser bundle if this machine has one; otherwise Playwright's default
if os.path.isdir("/opt/pw-browsers"):
    os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", "/opt/pw-browsers")

# PrivAudit banner_detection/config.json
BANNER_SELECTORS = [
    "div[id*='cookie']", "div[class*='cmp']", "div[class*='cookie']", "div[id*='consent']",
    "div[class*='consent']", "div[class*='gdpr']", "div[id*='onetrust-banner-sdk']",
    "div[class*='truste']", "div[id*='trustarc']",
]
CMP_HINTS = {
    "OneTrust": ["onetrust"], "TrustArc": ["trustarc", "truste"], "Cookiebot": ["cookiebot"],
    "Didomi": ["didomi"], "Quantcast": ["quantcast"], "Sourcepoint": ["sourcepoint"],
    "Usercentrics": ["usercentrics"], "Osano": ["osano"], "Termly": ["termly"],
}

BANNER_JS = """
(selectors) => {
  for (const sel of selectors) {
    for (const el of document.querySelectorAll(sel)) {
      const st = getComputedStyle(el), r = el.getBoundingClientRect();
      const t = (el.innerText || '').toLowerCase();
      if (st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0'
          && r.width > 100 && r.height > 10
          && (t.includes('cookie') || t.includes('privacy') || t.includes('consent'))) {
        return {found: true, selector: sel, html: el.outerHTML.slice(0, 2000).toLowerCase()};
      }
    }
  }
  return {found: false};
}
"""

GPC_INIT = """
Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', {get: () => true, configurable: true});
"""

_dns_cache: dict[str, bool] = {}


async def _host_is_public(host: str) -> bool:
    if is_local_name(host):
        return config.ALLOW_LOCAL
    if host in _dns_cache:
        return _dns_cache[host]
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, 443, type=socket.SOCK_STREAM)
        ok = True
        for i in infos:
            a = ipaddress.ip_address(i[4][0])
            if not (a.is_global or (config.ALLOW_LOCAL and (a.is_loopback or a.is_private))):
                ok = False
    except OSError:
        ok = False
    _dns_cache[host] = ok
    return ok


async def _visit(browser, url: str, page_site: str, gpc: bool) -> dict:
    ctx = await browser.new_context(
        user_agent=config.USER_AGENT.replace(" Privany/0.1 (+privacy policy reader)", ""),
        extra_http_headers={"Sec-GPC": "1"} if gpc else {},
        viewport={"width": 1280, "height": 900},
    )
    if gpc:
        await ctx.add_init_script(GPC_INIT)

    trackers: dict[str, dict] = {}

    async def guard(route):
        host = urlparse(route.request.url).hostname or ""
        if route.request.url.startswith(("data:", "blob:")) or await _host_is_public(host):
            await route.continue_()
        else:
            await route.abort()   # the server-side browser never touches internal addresses

    await ctx.route("**/*", guard)
    page = await ctx.new_page()

    def on_request(req):
        host = urlparse(req.url).hostname or ""
        if site_of(host) == page_site:
            return
        tr = tracker_for(host)
        if tr:
            t = trackers.setdefault(tr["domain"], {**tr, "requests": 0})
            t["requests"] += 1

    page.on("request", on_request)
    out = {"ok": True, "error": None}
    try:
        await page.goto(url, wait_until="load", timeout=30_000)
        try:
            await page.wait_for_load_state("networkidle", timeout=8_000)
        except Exception:
            pass
        await page.wait_for_timeout(3_000)
        banner = await page.evaluate(BANNER_JS, BANNER_SELECTORS)
        gpc_seen = await page.evaluate("navigator.globalPrivacyControl === true")
    except Exception as e:  # navigation failures make this run inconclusive
        out.update(ok=False, error=str(e)[:200])
        banner, gpc_seen = {"found": False}, None

    raw = await ctx.cookies()
    await ctx.close()

    cookies = [classify_cookie(c["name"], c["domain"], page_site) for c in raw]
    cmp = None
    if banner.get("found"):
        h = banner.get("html", "")
        cmp = next((name for name, keys in CMP_HINTS.items() if any(k in h for k in keys)), "Unknown")

    out.update(
        cookies=cookies,
        trackers=sorted(trackers.values(), key=lambda t: -t["requests"]),
        counts={
            "total": len(cookies),
            "targeting": sum(c["category"] == "targeting" for c in cookies),
            "targeting_3p": sum(c["category"] == "targeting" and c["third_party"] for c in cookies),
            "ad_platform": sum(c["ad_platform"] for c in cookies),
            "ad_trackers": sum(1 for t in trackers.values() if t["ad"]),
        },
        banner={"found": bool(banner.get("found")), "cmp": cmp},
        gpc_signal_visible=gpc_seen,
    )
    return out


async def _well_known_gpc(origin: str) -> dict | None:
    """GPC spec: sites can publish /.well-known/gpc.json saying they support it."""
    try:
        f = await fetch(origin.rstrip("/") + "/.well-known/gpc.json")
        data = json.loads(f.content.decode("utf-8", "replace"))
        return {"gpc": bool(data.get("gpc")), "lastUpdate": data.get("lastUpdate")}
    except (FetchError, ValueError, AttributeError, Exception):
        return None


async def run(site_url: str, runs: int = 1) -> dict:
    from playwright.async_api import async_playwright

    await check_url(site_url)
    p = urlparse(site_url)
    origin = f"{p.scheme}://{p.netloc}"
    page_site = site_of(p.hostname or "")

    results = {"default": [], "gpc": []}
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        version = browser.version
        # alternate configs like PrivAudit's round-robin crawl
        for _ in range(runs):
            for cfg in ("default", "gpc"):
                results[cfg].append(await _visit(browser, origin + "/", page_site, gpc=(cfg == "gpc")))
        await browser.close()

    def pick(rs):
        good = [r for r in rs if r["ok"]]
        return max(good, key=lambda r: r["counts"]["total"]) if good else rs[0]

    d, g = pick(results["default"]), pick(results["gpc"])
    inconclusive = []
    if not d["ok"] or not g["ok"]:
        inconclusive.append("The page didn't load cleanly in one of the runs.")
    if d["ok"] and d["counts"]["total"] == 0 and g["counts"]["total"] == 0:
        inconclusive.append("No cookies were set in either run. The site may block automated browsers.")

    td, tg = d["counts"]["targeting"], g["counts"]["targeting"]
    reduction = (td - tg) / td if td else None

    return {
        "site": page_site,
        "url": origin + "/",
        "ran_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "browser": f"Chromium {version}",
        "runs_per_config": runs,
        "method": "PrivAudit behavior lens: fresh profile per config, no banner interaction, cookies read after load + network idle + 3s.",
        "default": d,
        "gpc": g,
        "targeting_reduction": reduction,
        "well_known_gpc": await _well_known_gpc(origin),
        "inconclusive": inconclusive,
        "limits": [
            "Run from our server's location; sites can behave differently in other regions.",
            "Only cookies are measured. Fingerprinting and server-side tracking aren't visible here.",
            "GPC legally covers sale/sharing opt-outs in some states; it doesn't require every cookie to disappear.",
        ],
    }
