"""
Some sites build their policy page with JavaScript, so a plain fetch gets an
empty shell. When that happens we load the page in Chromium (the same one the
GPC test uses), wait for it to settle, and read the rendered HTML.

Same rule as everywhere else: the browser never touches internal addresses.
"""

from urllib.parse import urlparse

from . import config
from .safe_fetch import FetchError, Fetched, check_url


async def render(url: str, timeout_ms: int = 20_000) -> Fetched:
    from playwright.async_api import async_playwright

    from .gpc_audit import _host_is_public  # shared SSRF guard for browser traffic

    await check_url(url)
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        try:
            ctx = await browser.new_context(user_agent=config.USER_AGENT)

            async def guard(route):
                host = urlparse(route.request.url).hostname or ""
                # skip heavy stuff we don't need to read text
                if route.request.resource_type in ("image", "media", "font"):
                    await route.abort()
                elif route.request.url.startswith(("data:", "blob:")) or await _host_is_public(host):
                    await route.continue_()
                else:
                    await route.abort()

            await ctx.route("**/*", guard)
            page = await ctx.new_page()
            try:
                await page.goto(url, wait_until="load", timeout=timeout_ms)
                try:
                    await page.wait_for_load_state("networkidle", timeout=6_000)
                except Exception:
                    pass
                await page.wait_for_timeout(500)
            except Exception as e:
                raise FetchError(f"couldn't render: {str(e)[:120]}") from e
            html = await page.content()
            final = page.url
        finally:
            await browser.close()
    if len(html.encode()) > config.MAX_DOC_BYTES:
        raise FetchError("rendered document too large")
    return Fetched(url=final if final.startswith("http") else url, content=html.encode(), content_type="text/html")
