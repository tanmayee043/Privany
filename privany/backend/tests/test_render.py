"""JavaScript-built policy pages get rendered in Chromium. Needs Playwright's Chromium installed."""

import asyncio
import functools
import http.server
import os
import threading

import pytest

from privany import config

if os.path.isdir("/opt/pw-browsers"):
    os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", "/opt/pw-browsers")

JS_PAGE = b"""<!doctype html><html><head><title>Privacy</title></head><body><main id="m"></main>
<script>
const P = ["Privacy Policy", "We may sell your personal information to advertising partners.",
           "We retain your data for as long as necessary.", "You can request deletion by emailing us."];
for (const t of P) { const p = document.createElement('p'); p.textContent = t; document.getElementById('m').appendChild(p); }
</script></body></html>"""


class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(JS_PAGE)

    def log_message(self, *a):
        pass


@pytest.fixture
def server():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://localhost:{srv.server_address[1]}/privacy"
    srv.shutdown()


def _chromium_ok():
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            p.chromium.launch().close()
        return True
    except Exception:
        return False


@pytest.mark.skipif(not _chromium_ok(), reason="Playwright Chromium not installed")
def test_js_only_policy_gets_rendered(server, monkeypatch):
    monkeypatch.setattr(config, "ALLOW_LOCAL", True)
    from privany.main import _load_docs
    docs, errors = asyncio.run(_load_docs([(server, "privacy")]))
    assert not errors
    d = docs[0]
    assert d.rendered
    assert "We may sell your personal information to advertising partners." in d.paragraphs
    assert any("JavaScript" in n for n in d.notes)


def test_render_respects_ssrf_guard(monkeypatch):
    monkeypatch.setattr(config, "ALLOW_LOCAL", False)
    from privany.render import render
    from privany.safe_fetch import FetchError
    with pytest.raises(FetchError):
        asyncio.run(render("http://127.0.0.1:9/"))
