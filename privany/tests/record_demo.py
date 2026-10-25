"""
Records a backup demo video: walks the README demo script at human pace with
the real extension, in one browser tab. Output: docs/demo-backup.mp4 (and .webm)

Needs the servers running (./scripts/dev.sh start) and a Chrome build
(cd extension && npm run build:chrome).
Run: python tests/record_demo.py
"""

import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

if os.path.isdir("/opt/pw-browsers"):
    os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", "/opt/pw-browsers")
ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "extension" / "dist" / "chrome"
OUT = ROOT / "docs"
BAD, GOOD = "http://brightcart.localhost:8090", "http://honestgoods.localhost:8091"
SIZE = {"width": 1280, "height": 800}


def state(sw, prefix):
    return sw.evaluate("""async (p) => {
        const t = (await chrome.tabs.query({})).find(t => (t.url || '').startsWith(p));
        if (!t) return null;
        return (await chrome.storage.session.get('tab:' + t.id))['tab:' + t.id] || null; }""", prefix)


def wait(sw, prefix, pred, timeout=90):
    end = time.time() + timeout
    while time.time() < end:
        s = state(sw, prefix)
        if s and pred(s):
            return s
        time.sleep(0.4)
    return None


def main():
    OUT.mkdir(exist_ok=True)
    vids = Path(tempfile.mkdtemp())
    with sync_playwright() as p, tempfile.TemporaryDirectory() as profile:
        ctx = p.chromium.launch_persistent_context(
            profile, channel="chromium", headless=True, viewport=SIZE,
            record_video_dir=str(vids), record_video_size=SIZE,
            args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"],
        )
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=15000)
        ext_id = sw.url.split("/")[2]
        page = ctx.new_page()
        for other in ctx.pages:          # close the welcome tab so only our tab is recorded
            if other != page:
                other.close()
        page.goto(BAD + "/__demo/reset")

        def report(view: str, tab_url_prefix: str, then=None, hold=4000):
            tab_id = sw.evaluate("async (p) => (await chrome.tabs.query({})).find(t => (t.url||'').startsWith(p)).id", tab_url_prefix)
            page.goto(f"chrome-extension://{ext_id}/popup.html?tab={tab_id}&full=1")
            page.wait_for_timeout(1500)
            page.get_by_role("tab", name=view).click()
            page.wait_for_timeout(800)
            if then:
                then()
            page.wait_for_timeout(hold)

        # 1. BrightCart: red, panel at the top, out of the banner's way
        page.goto(BAD + "/")
        wait(sw, BAD, lambda s: s.get("assessment") and (s.get("gpc") or {}).get("status") == "done")
        page.wait_for_timeout(5000)

        # 2. Hit Reject -> watch 8s -> broken
        page.click("button[data-consent='rejected']", force=True)
        page.wait_for_timeout(10000)

        # 3. Signup: field notes + receipt
        page.goto(BAD + "/signup.html")
        page.wait_for_timeout(3500)
        page.locator("#phone").scroll_into_view_if_needed()
        page.wait_for_timeout(2500)
        page.click("#agree")             # risky site -> Privany pauses it
        page.wait_for_timeout(6000)
        page.keyboard.press("Tab")       # "Agree anyway"
        page.keyboard.press("Enter")
        page.wait_for_timeout(4000)

        # 4. Checkout and upload: the moment-specific stuff leads
        page.goto(BAD + "/checkout.html")
        page.wait_for_timeout(4500)
        page.goto(BAD + "/upload.html")
        page.wait_for_timeout(4000)

        # 5. Full report: Say vs Do
        page.goto(BAD + "/")
        wait(sw, BAD, lambda s: s.get("assessment"))
        page.wait_for_timeout(1500)
        report("Say vs Do", BAD, hold=6000)

        # 6. They change the terms after you agreed
        page.goto(BAD + "/")
        page.wait_for_timeout(1500)
        page.goto(BAD + "/__demo/publish-new-terms")
        wait(sw, BAD, lambda s: any(f["id"] == "terms_changed" for f in (s.get("assessment") or {}).get("flags", [])))
        page.wait_for_timeout(5500)
        report("Receipts", BAD, then=lambda: page.get_by_role("button", name="Check for changes").first.click(), hold=6000)

        # 7. Honest Goods: same tool, honest site
        page.goto(GOOD + "/")
        wait(sw, GOOD, lambda s: s.get("assessment"))
        page.wait_for_timeout(2500)
        page.click("button[data-consent='rejected']", force=True)
        page.wait_for_timeout(10000)

        # 8. Compare the two
        report("Compare", GOOD, hold=6000)

        page.goto(BAD + "/__demo/reset")
        video = page.video.path()
        ctx.close()

    webm = OUT / "demo-backup.webm"
    shutil.move(video, webm)
    if shutil.which("ffmpeg"):
        mp4 = OUT / "demo-backup.mp4"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(webm), "-c:v", "libx264", "-preset", "veryfast",
                        "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(mp4)], check=True)
        print("wrote", mp4)
    print("wrote", webm)


if __name__ == "__main__":
    main()
