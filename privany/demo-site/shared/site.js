// Demo-only behavior. Both shops are fictional. BrightCart breaks its own
// policy on purpose; Honest Goods follows it. All cookies are local fakes
// named like real ad-platform cookies; nothing is sent to any real company.

(function () {
  const MODE = document.documentElement.dataset.mode; // "bad" | "good"
  const CHOICE_KEY = "demo_consent";

  function setCookie(name, value, days) {
    const exp = new Date(Date.now() + days * 864e5).toUTCString();
    document.cookie = `${name}=${value}; expires=${exp}; path=/; SameSite=Lax`;
  }
  function rand() { return Math.random().toString(36).slice(2, 12); }

  function adCookies(stage) {
    // names match real Meta / Google / TikTok / Bing cookies so classification is realistic
    setCookie("_fbp", `fb.1.${Date.now()}.${rand()}`, 90);
    setCookie("_gcl_au", `1.1.${rand()}`, 90);
    if (stage !== "load") {
      setCookie("_ttp", rand(), 390);
      setCookie("_uetsid", rand(), 1);
    }
  }

  function choice() { try { return localStorage.getItem(CHOICE_KEY); } catch { return null; } }

  // everyone gets a session cookie + analytics
  setCookie("session_id", rand(), 1);
  setCookie("_ga", `GA1.1.${rand()}`, 400);

  const gpc = navigator.globalPrivacyControl === true;

  if (MODE === "bad") {
    // ignores GPC, tracks before you choose
    adCookies("load");
  } else if (choice() === "accepted" && !gpc) {
    adCookies("load");
  }

  // ---- cookie banner ----
  const banner = document.getElementById("cookie-consent-banner");
  if (banner && !choice()) banner.hidden = false;

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-consent]");
    if (!btn) return;
    const c = btn.dataset.consent;
    try { localStorage.setItem(CHOICE_KEY, c); } catch {}
    banner.hidden = true;
    if (c === "accepted") {
      if (!(MODE === "good" && gpc)) adCookies("after");
    } else if (MODE === "bad") {
      // the "Reject all" button does nothing useful: more ad cookies show up a beat later
      setTimeout(() => adCookies("after"), 1200);
    } else {
      // honest: wipe ad cookies on reject
      for (const n of ["_fbp", "_gcl_au", "_ttp", "_uetsid"]) setCookie(n, "", -1);
    }
  });

  // reset link for re-running the demo
  const reset = document.getElementById("reset-demo");
  if (reset) reset.addEventListener("click", (e) => {
    e.preventDefault();
    try { localStorage.removeItem(CHOICE_KEY); } catch {}
    for (const n of ["_fbp", "_gcl_au", "_ttp", "_uetsid", "_ga", "session_id"]) setCookie(n, "", -1);
    location.href = "/__demo/reset";   // also puts the original terms back
  });

  // fake form submits
  for (const f of document.querySelectorAll("form[data-demo]")) {
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      const out = f.querySelector(".form-result");
      if (out) out.textContent = "Done. (Demo only, nothing was sent anywhere.)";
    });
  }
})();
