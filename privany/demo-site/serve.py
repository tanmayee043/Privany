"""
Serves both demo shops:
  BrightCart   -> http://brightcart.localhost:8090
  Honest Goods -> http://honestgoods.localhost:8091
Separate hostnames give each shop its own cookie jar (browsers share cookies
across ports on the same host). Browsers send *.localhost to your machine.
"""

import functools
import http.server
import threading
from pathlib import Path

ROOT = Path(__file__).parent


# demo switch: has this shop "published" its new terms? (in memory, resets on restart)
NEW_TERMS: dict[str, bool] = {}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, shop_dir: Path, **kw):
        self.shop_dir = shop_dir
        super().__init__(*a, directory=str(shop_dir), **kw)

    def do_GET(self):
        shop = self.shop_dir.name
        if self.path.startswith("/__demo/"):
            NEW_TERMS[shop] = self.path.startswith("/__demo/publish-new-terms")
            self.send_response(303)
            self.send_header("Location", "/privacy.html" if NEW_TERMS[shop] else "/")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return
        return super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")  # always show the current version
        super().end_headers()

    def translate_path(self, path):
        clean = path.split("?")[0].split("#")[0]
        if clean.startswith("/shared/"):
            return str(ROOT / clean.lstrip("/"))
        if clean == "/privacy.html" and NEW_TERMS.get(self.shop_dir.name) and (self.shop_dir / "privacy-v2.html").exists():
            return str(self.shop_dir / "privacy-v2.html")
        return super().translate_path(path)

    def log_message(self, *_):
        pass


def run(shop: str, port: int):
    h = functools.partial(Handler, shop_dir=ROOT / shop)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), h)
    print(f"{shop:12s} http://{shop}.localhost:{port}")
    srv.serve_forever()


if __name__ == "__main__":
    if not (ROOT / "brightcart" / "index.html").exists():
        from build import build
        build()
    threads = [threading.Thread(target=run, args=a, daemon=True) for a in (("brightcart", 8090), ("honestgoods", 8091))]
    for t in threads:
        t.start()
    try:
        threads[0].join()
    except KeyboardInterrupt:
        pass
