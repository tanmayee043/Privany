"""
End-to-end: load the built Chrome extension into Chromium and walk through the
demo shops like a person would. Saves screenshots to tests/screens/.

Needs: ./scripts/dev.sh start   and   (cd extension && npm run build:chrome)
Run:   python tests/e2e.py
"""

import json
import os
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

# use a preinstalled browser bundle if this machine has one; otherwise Playwright's default
if os.path.isdir("/opt/pw-browsers"):
    os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", "/opt/pw-browsers")
ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "extension" / "dist" / "chrome"
SHOTS = ROOT / "tests" / "screens"
SHOTS.mkdir(parents=True, exist_ok=True)
BAD, GOOD = "http://brightcart.localhost:8090", "http://honestgoods.localhost:8091"

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}  {detail}")


def tab_state(sw, url_prefix):
    return sw.evaluate("""async (prefix) => {
        const tabs = await chrome.tabs.query({});
        const t = tabs.find(t => (t.url || '').startsWith(prefix));
        if (!t) return null;
        const got = await chrome.storage.session.get('tab:' + t.id);
        return got['tab:' + t.id] || null;
    }""", url_prefix)


def wait_state(sw, prefix, pred, timeout=60):
    end = time.time() + timeout
    s = None
    while time.time() < end:
        s = tab_state(sw, prefix)
        if s and pred(s):
            return s
        time.sleep(0.5)
    return s


def main():
    with sync_playwright() as p, tempfile.TemporaryDirectory() as profile:
        ctx = p.chromium.launch_persistent_context(
            profile, channel="chromium", headless=True, viewport={"width": 1280, "height": 860},
            args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"],
        )
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=15000)
        ext_id = sw.url.split("/")[2]
        check("extension loaded", bool(ext_id), ext_id)
        for pg in ctx.pages:
            if "options.html" in pg.url:
                pg.screenshot(path=str(SHOTS / "00-welcome-settings.png"), full_page=True)

        # ---------------------------------------------------------------- BrightCart home
        print("\nBrightCart (misbehaves on purpose)")
        page = ctx.new_page()
        page.goto(BAD + "/")
        s = wait_state(sw, BAD, lambda s: s.get("assessment") and (s.get("gpc") or {}).get("status") == "done", 90)
        a = (s or {}).get("assessment") or {}
        check("policy analyzed", s and s.get("analysis", {}).get("analysis"), (s or {}).get("error", ""))
        check("verdict is red", a.get("verdict") == "red", a.get("headline", ""))
        ids = {f["id"] for f in a.get("flags", [])}
        check("GPC test ran automatically (policy claims GPC)", (s.get("gpc") or {}).get("status") == "done")
        check("gap: says honors GPC, tracking unchanged", "gap_gpc" in ids)
        check("gap: says doesn't sell, ad platforms present", "gap_no_sell" in ids)
        check("gap: ad tracking before banner answered", "before_consent" in ids)
        seen = [c["name"] for c in s["cookies"].values()]
        check("saw ad cookies live in the browser", {"_fbp", "_gcl_au"} <= set(seen), ", ".join(seen))
        badge = sw.evaluate("async () => { const [t] = (await chrome.tabs.query({})).filter(t => (t.url||'').startsWith('%s')); return chrome.action.getBadgeText({tabId: t.id}); }" % BAD)
        check("toolbar badge shows high-severity count", badge not in ("", "?", "…"), repr(badge))
        page.wait_for_timeout(800)
        page.screenshot(path=str(SHOTS / "01-brightcart-panel.png"))

        # ---------------------------------------------------------------- Reject check
        page.click("button[data-consent='rejected']")
        page.wait_for_timeout(1500)
        page.screenshot(path=str(SHOTS / "02-reject-watching.png"))
        s = wait_state(sw, BAD, lambda s: ((s.get("assessment") or {}).get("reject_check") or {}).get("status") == "done", 20)
        rc = (s.get("assessment") or {}).get("reject_check") or {}
        check("reject check: broken", rc.get("verdict") == "broken", rc.get("detail", ""))
        page.wait_for_timeout(800)
        page.screenshot(path=str(SHOTS / "03-reject-broken.png"))

        # ---------------------------------------------------------------- Signup: field hints + receipt
        page.goto(BAD + "/signup.html")
        s = wait_state(sw, BAD + "/signup", lambda s: s.get("assessment"), 30)
        page.wait_for_timeout(1500)
        chips = page.locator("[data-privany]").count()
        check("signup: inline hints attached", chips >= 3, f"{chips} Privany elements on page")
        # the agree gate: on a risky site, ticking "I agree" is paused until you decide
        page.click("#agree")
        page.wait_for_timeout(700)
        check("agree gate: 'I agree' paused on a risky site", not page.is_checked("#agree"))
        page.screenshot(path=str(SHOTS / "04b-agree-gate.png"))
        page.keyboard.press("Tab")      # focus starts on "Go back"; Tab -> "Agree anyway"
        page.keyboard.press("Enter")
        page.wait_for_timeout(700)
        check("agree gate: 'Agree anyway' goes through", page.is_checked("#agree"))
        rec = None
        for _ in range(30):
            rec = sw.evaluate("async () => (await chrome.storage.local.get('receipts')).receipts || []")
            if rec:
                break
            time.sleep(0.5)
        check("consent receipt saved on 'I agree'", bool(rec), f"{len(rec or [])} receipt(s), {len((rec or [{}])[0].get('documents', []))} docs")
        page.wait_for_timeout(600)
        page.screenshot(path=str(SHOTS / "04-signup-hints.png"), full_page=True)

        # ---------------------------------------------------------------- Checkout + upload
        page.goto(BAD + "/checkout.html")
        wait_state(sw, BAD + "/checkout", lambda s: s.get("assessment"), 30)
        page.wait_for_timeout(1500)
        page.screenshot(path=str(SHOTS / "05-checkout.png"))
        page.goto(BAD + "/upload.html")
        wait_state(sw, BAD + "/upload", lambda s: s.get("assessment"), 30)
        page.wait_for_timeout(1500)
        page.screenshot(path=str(SHOTS / "06-upload.png"))

        # ---------------------------------------------------------------- full report (popup UI)
        page.goto(BAD + "/")
        wait_state(sw, BAD, lambda s: s.get("assessment") and (s.get("gpc") or {}).get("status") == "done", 40)
        tab_id = sw.evaluate("async () => (await chrome.tabs.query({})).find(t => (t.url||'').startsWith('%s')).id" % BAD)
        rep = ctx.new_page()
        rep.set_viewport_size({"width": 400, "height": 640})
        rep.goto(f"chrome-extension://{ext_id}/popup.html?tab={tab_id}")
        rep.wait_for_timeout(1500)
        rep.screenshot(path=str(SHOTS / "07-popup-overview.png"), full_page=True)
        rep.get_by_role("tab", name="Say vs Do").click()
        rep.wait_for_timeout(500)
        rep.screenshot(path=str(SHOTS / "08-popup-say-vs-do.png"), full_page=True)
        check("Say vs Do shows ≠ marks", rep.locator("text=≠").count() >= 2)
        rep.get_by_role("tab", name="Fine print").click()
        rep.wait_for_timeout(400)
        rep.screenshot(path=str(SHOTS / "09-popup-fine-print.png"), full_page=True)
        rep.get_by_role("tab", name="Receipts").click()
        rep.get_by_role("button", name="Check for changes").first.click()
        rep.wait_for_timeout(2500)
        check("receipt diff: unchanged", rep.locator("text=unchanged since you agreed").count() >= 1)
        rep.screenshot(path=str(SHOTS / "10-popup-receipts.png"), full_page=True)
        rep.close()

        # ---------------------------------------------------------------- JS-only cookie policy got rendered
        docs = (s.get("analysis") or {}).get("documents", [])
        check("JS-built cookie policy was rendered and read", any(d.get("rendered") for d in docs),
              ", ".join(f"{d['kind']}{'(rendered)' if d.get('rendered') else ''}" for d in docs))

        # ---------------------------------------------------------------- they change the terms after you agreed
        # come back to the site, then they publish new terms seconds later: must still be caught
        page.goto(BAD + "/")
        page.wait_for_timeout(800)
        page.goto(BAD + "/__demo/publish-new-terms")
        s = wait_state(sw, BAD, lambda s: any(f["id"] == "terms_changed" for f in (s.get("assessment") or {}).get("flags", [])), 60)
        tc = next((f for f in (s.get("assessment") or {}).get("flags", []) if f["id"] == "terms_changed"), None)
        check("terms changed since you agreed: flagged", tc is not None, (tc or {}).get("severity", ""))
        lines = (tc or {}).get("evidence", {}).get("observed", [])
        check("terms changed: says what moved, in plain words",
              "Before: they don't sell your data. Now: they may sell your data." in lines, " | ".join(lines)[:160])
        page.wait_for_timeout(1200)
        page.screenshot(path=str(SHOTS / "13-terms-changed-panel.png"))
        tab_id = sw.evaluate("async () => (await chrome.tabs.query({})).find(t => (t.url||'').startsWith('%s')).id" % BAD)
        rep = ctx.new_page()
        rep.set_viewport_size({"width": 400, "height": 700})
        rep.goto(f"chrome-extension://{ext_id}/popup.html?tab={tab_id}")
        rep.wait_for_timeout(1200)
        rep.get_by_role("tab", name="Receipts").click()
        rep.get_by_role("button", name="Check for changes").first.click()
        rep.wait_for_timeout(2500)
        check("receipts tab shows the change", rep.locator("text=They changed the terms since you agreed").count() >= 1)
        rep.screenshot(path=str(SHOTS / "14-receipts-changed.png"), full_page=True)
        rep.close()

        # ---------------------------------------------------------------- Honest Goods
        print("\nHonest Goods (keeps its word)")
        good = ctx.new_page()
        good.goto(GOOD + "/")
        s = wait_state(sw, GOOD, lambda s: s.get("assessment"), 60)
        a = s.get("assessment") or {}
        check("verdict is green", a.get("verdict") == "green", a.get("headline", ""))
        check("no say-vs-do gaps", not any(f["kind"] == "gap" for f in a.get("flags", [])))
        good.goto(GOOD + "/signup.html")
        wait_state(sw, GOOD + "/signup", lambda s: s.get("assessment"), 30)
        good.wait_for_timeout(800)
        good.click("#agree")
        good.wait_for_timeout(500)
        check("agree gate: safe site is never interrupted", good.is_checked("#agree"))
        good.goto(GOOD + "/")
        wait_state(sw, GOOD, lambda s: s.get("assessment"), 30)
        good.click("button[data-consent='rejected']")
        s = wait_state(sw, GOOD, lambda s: ((s.get("assessment") or {}).get("reject_check") or {}).get("status") == "done", 20)
        check("reject check: held", ((s.get("assessment") or {}).get("reject_check") or {}).get("verdict") == "held")
        good.wait_for_timeout(600)
        good.screenshot(path=str(SHOTS / "11-honestgoods-reject-held.png"))

        # ---------------------------------------------------------------- compare the two shops
        good_id = sw.evaluate("async () => (await chrome.tabs.query({})).find(t => (t.url||'').startsWith('%s')).id" % GOOD)
        cmp = ctx.new_page()
        cmp.set_viewport_size({"width": 400, "height": 700})
        cmp.goto(f"chrome-extension://{ext_id}/popup.html?tab={good_id}")
        cmp.wait_for_timeout(1200)
        cmp.get_by_role("tab", name="Compare").click()
        cmp.wait_for_timeout(600)
        check("compare: other site offered", cmp.locator("select#cmp option").count() >= 1)
        check("compare: trade-offs spelled out", cmp.locator("text=looks better on").count() >= 1)
        cmp.screenshot(path=str(SHOTS / "15-compare.png"), full_page=True)
        cmp.close()

        # leave the demo shop the way we found it
        page.goto(BAD + "/__demo/reset")

        # ---------------------------------------------------------------- settings page
        opts = ctx.new_page()
        opts.goto(f"chrome-extension://{ext_id}/options.html")
        opts.wait_for_timeout(600)
        opts.screenshot(path=str(SHOTS / "12-settings.png"), full_page=True)
        ctx.close()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    (SHOTS / "results.json").write_text(json.dumps(results, indent=1))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
