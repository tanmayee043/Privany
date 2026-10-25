import type { Frame, Page } from "puppeteer";
import { JobTimeoutError, withTimeout } from "../limits.js";

export type ConsentChoice = "accept" | "reject";

export interface ConsentClick {
  clicked: boolean;
  /** The label of the button we pressed, so the report can say exactly what was clicked. */
  button?: string;
}

// Known consent-platform buttons, tried before any text matching. Each is the
// platform's own id/class for the "accept all" / "reject all" control.
const VENDOR_SELECTORS: Record<ConsentChoice, string[]> = {
  reject: [
    "#onetrust-reject-all-handler",
    "#CybotCookiebotDialogBodyButtonDecline",
    "#didomi-notice-disagree-button",
    ".osano-cm-denyAll",
    "button.sp_choice_type_REJECT_ALL",
    "#truste-consent-required",
  ],
  accept: [
    "#onetrust-accept-btn-handler",
    "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
    "#CybotCookiebotDialogBodyButtonAccept",
    "#didomi-notice-agree-button",
    ".osano-cm-accept-all",
    "button.sp_choice_type_11",
    "#truste-consent-button",
  ],
};

// Fallback: a button or link whose whole label is one of these, inside an
// element that looks like a consent banner. Labels like "Manage", "Settings"
// or "Learn more" never match, so we can't wander into a preferences flow.
const REJECT_LABEL = /^(reject|decline|deny|refuse|disagree)( all)?( (non-?essential|optional|non-?necessary))?( cookies)?$|^(only|use) (necessary|essential|required) cookies( only)?$|^(necessary|essential) (cookies )?only$/i;
const ACCEPT_LABEL = /^(accept|agree|allow)( all)?( cookies)?$|^i (accept|agree)$|^accept (and|&) continue$/i;
const FRAME_TIMEOUT_MS = 2_500;
const SEARCH_TIMEOUT_MS = 10_000;
const BANNER_HINT = /cookie|consent|gdpr|ccpa|cmp|privacy|onetrust|didomi|cybot|truste|osano|sp_message|usercentrics/i;

/**
 * Presses the banner's Accept All or Reject All once. Never clicks more than
 * one element, and reports `clicked: false` rather than guessing when it
 * can't tell which button is which.
 */
export async function clickConsent(page: Page, choice: ConsentChoice): Promise<ConsentClick> {
  // Several platforms (Sourcepoint, Usercentrics, many custom ones) render the banner in an iframe.
  // Ad frames can be slow or hung, so each frame and the whole search have a time limit.
  const search = async (): Promise<ConsentClick> => {
    for (const frame of page.frames()) {
      if (frame.detached) continue;
      const result = await withTimeout(clickInFrame(frame, choice), FRAME_TIMEOUT_MS, "frame too slow").catch((err) => {
        if (err instanceof JobTimeoutError) return { clicked: false };
        throw err;
      });
      if (result.clicked) return result;
    }
    return { clicked: false };
  };
  return withTimeout(search(), SEARCH_TIMEOUT_MS, "consent search too slow").catch(() => ({ clicked: false }));
}

async function clickInFrame(page: Frame, choice: ConsentChoice): Promise<ConsentClick> {
  for (const sel of VENDOR_SELECTORS[choice]) {
    const label = await page
      .$eval(sel, (el) => {
        const node = el as HTMLElement;
        if (!node.getClientRects().length) return null;
        const text = (node.innerText || node.getAttribute("aria-label") || node.getAttribute("value") || "").replace(/\s+/g, " ").trim();
        node.click();
        return text || "(unlabeled button)";
      })
      .catch(() => null);
    if (label) return { clicked: true, button: label.slice(0, 80) };
  }
  const pattern = choice === "reject" ? REJECT_LABEL : ACCEPT_LABEL;
  const label = await page
    .evaluate(
      (src: string, flags: string, hintSrc: string) => {
        const label = new RegExp(src, flags);
        const hint = new RegExp(hintSrc, "i");
        const candidates = Array.from(document.querySelectorAll("button, a[role='button'], a, [role='button'], input[type='button'], input[type='submit']")) as HTMLElement[];
        const matches = candidates.filter((el) => {
          const text = (el.innerText || el.getAttribute("aria-label") || el.getAttribute("value") || "").replace(/\s+/g, " ").trim();
          if (!text || !label.test(text) || !el.getClientRects().length) return false;
          for (let p: HTMLElement | null = el.parentElement; p; p = p.parentElement) {
            if (hint.test(`${p.id} ${typeof p.className === "string" ? p.className : ""}`) || p.getAttribute("role") === "dialog") return true;
          }
          return false;
        });
        // Two different candidates usually means a page with several banners or
        // a login/newsletter dialog; clicking either would be a guess.
        if (matches.length !== 1) return null;
        const text = (matches[0].innerText || matches[0].getAttribute("aria-label") || matches[0].getAttribute("value") || "").replace(/\s+/g, " ").trim();
        matches[0].click();
        return text;
      },
      pattern.source,
      pattern.flags,
      BANNER_HINT.source,
    )
    .catch(() => null);
  return label ? { clicked: true, button: label.slice(0, 80) } : { clicked: false };
}
