import type { ClaimKey, ClaimValue, QuickCheck, Quote } from "../../server/src/report/types";

// Decides whether a site is risky enough to interrupt the user, from what the
// page does in their tab and what its policy says. Plain rules, no model, so
// the same evidence always gives the same answer. The first three are
// PrivAudit's disclosure-vs-behavior gap rules (analysis/regen_joint_lens.py);
// the rest follow the same idea for the moment you land on a page.

export interface Observed {
  /** Outside ad-tech companies the page contacted (from the tracker list). */
  adTrackers: { domain: string; owner: string }[];
  /** Advertising/analytics cookies set while you've been on the page. */
  trackingCookies: { name: string; owner?: string }[];
  /** A cookie banner was still on screen when the check ran (so no choice had been made). */
  bannerVisible: boolean;
}

export type Severity = "high" | "medium";

export interface Reason {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  quote?: Quote;
  /** What the reason rests on, shown so the user can judge it. */
  basis: "policy" | "page" | "policy_and_page" | "research";
}

export type Level = "red" | "yellow" | "green" | "unknown";

export interface Assessment {
  level: Level;
  reasons: Reason[];
}

const owners = (o: Observed) => [...new Set(o.adTrackers.map((t) => t.owner))];
const nameList = (xs: string[], n = 3) => xs.slice(0, n).join(", ") + (xs.length > n ? ` and ${xs.length - n} more` : "");

function claim(q: QuickCheck | undefined, key: ClaimKey): { value: ClaimValue; quote?: Quote } {
  const c = q?.policy?.claims.find((x) => x.key === key);
  return { value: c?.value ?? "unspecified", quote: c?.quote };
}

export function assessRisk(obs: Observed, quick: QuickCheck | undefined): Assessment {
  const reasons: Reason[] = [];
  const ads = owners(obs);
  const hasAdTech = ads.length > 0;
  const sells = claim(quick, "sells_personal_info");
  const sharesAds = claim(quick, "shares_for_targeted_ads");
  const consent = claim(quick, "tracking_requires_consent");
  const ai = claim(quick, "uses_data_for_ai_training");

  if (sells.value === "no" && hasAdTech) {
    reasons.push({
      id: "no_sell_but_adtech",
      severity: "high",
      title: "Says it doesn't sell your data, but ad-tech companies are on the page",
      detail: `${nameList(ads)} ${ads.length === 1 ? "is" : "are"} loading here. Ad-tech on the page can collect your data for targeted ads, which privacy laws can count as a sale or share.`,
      quote: sells.quote,
      basis: "policy_and_page",
    });
  }
  if (hasAdTech && sells.value === "unspecified" && sharesAds.value === "unspecified" && quick?.policy) {
    reasons.push({
      id: "silent_with_adtech",
      severity: "medium",
      title: "Ad-tech on the page, and the policy doesn't say whether it sells or shares your data",
      detail: `${nameList(ads)} ${ads.length === 1 ? "is" : "are"} loading here.`,
      basis: "policy_and_page",
    });
  }
  if (sells.value === "yes") {
    reasons.push({ id: "sells_data", severity: "high", title: "The policy says it may sell your data", detail: "Selling can include passing data to advertisers or data brokers.", quote: sells.quote, basis: "policy" });
  }
  if (obs.bannerVisible && (hasAdTech || obs.trackingCookies.length > 0)) {
    const what = hasAdTech ? `${nameList(ads)} started loading` : `${obs.trackingCookies.length} tracking cookie${obs.trackingCookies.length === 1 ? " was" : "s were"} set`;
    reasons.push(
      consent.value === "yes"
        ? { id: "tracking_before_consent_promised", severity: "high", title: "Promises to wait for your consent, but tracking already started", detail: `${what} while the cookie banner was still waiting for your answer.`, quote: consent.quote, basis: "policy_and_page" }
        : { id: "tracking_before_consent", severity: "medium", title: "Tracking started before you answered the cookie banner", detail: `${what} while the banner was still on screen.`, basis: "page" },
    );
  }
  if (sharesAds.value === "yes" && hasAdTech) {
    reasons.push({ id: "shares_for_ads", severity: "medium", title: "Uses your data for targeted ads", detail: `The policy says so, and ${nameList(ads)} ${ads.length === 1 ? "is" : "are"} on the page.`, quote: sharesAds.quote, basis: "policy_and_page" });
  }
  if (ai.value === "yes") {
    reasons.push({ id: "ai_training", severity: "medium", title: "May use your data to train AI", detail: "The policy says your data or content can be used to train or improve AI models.", quote: ai.quote, basis: "policy" });
  }
  const gaps = quick?.priorAudit?.gaps ?? [];
  if (gaps.length) {
    reasons.push({
      id: "research_gap",
      severity: "high",
      title: `Researchers found its promises didn't hold (PrivAudit, ${quick!.priorAudit!.crawlDate.slice(0, 4)})`,
      detail: gaps[0].detail + (gaps.length > 1 ? ` (${gaps.length - 1} more finding${gaps.length > 2 ? "s" : ""})` : ""),
      basis: "research",
    });
  }
  if (quick?.policyError && hasAdTech) {
    reasons.push({ id: "no_policy_with_adtech", severity: "medium", title: "Ad-tech on the page, and we couldn't find a privacy policy", detail: `${nameList(ads)} ${ads.length === 1 ? "is" : "are"} loading here.`, basis: "page" });
  }

  const order: Severity[] = ["high", "medium"];
  reasons.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  const highs = reasons.filter((r) => r.severity === "high").length;
  const mediums = reasons.length - highs;
  // Risky enough to interrupt: one serious finding, or two lesser ones together.
  const level: Level = highs > 0 || mediums >= 2 ? "red" : mediums === 1 ? "yellow" : quick?.policy ? "green" : "unknown";
  return { level, reasons };
}
