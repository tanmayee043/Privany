import type { BrowserAudit, ClaimKey, Comparison, ObservedCookie, PolicyAnalysis, PolicyClaim, Verdict } from "../report/types.js";
import { CLAIMS } from "../policy/definitions.js";
import { isTracking } from "../audit/cookies.js";

// Deterministic rules that set each policy claim against what the browser
// audit observed. They mirror PrivAudit's "joint lens" (disclosure vs.
// behavior): a mismatch is a signal for a closer look, never proof of a
// violation. No model is involved here, so the same evidence always gives the
// same verdict.

const COMMON_CAVEATS = [
  "Cookies are only one way to track. Fingerprinting and server-side sharing aren't measured; outside domains contacted are listed under How we tested.",
  "We visited the homepage and one other page, scrolling through each, but didn't log in or click anything on the page (apart from the separate cookie-banner test). Clicking can load more ads and trackers, so real numbers may be higher.",
];

const GPC_CAVEATS = [
  "Privacy laws let a site honor GPC by not selling or sharing your data on its servers, even if ad cookies are still written. A cookie alone doesn't show that data was sold.",
  "Some sites honor GPC only for visitors in certain states. This test ran from the server's location.",
];

const list = (cs: ObservedCookie[], n = 5) => {
  const names = [...new Set(cs.map((c) => c.platform ?? c.domain))];
  return names.slice(0, n).join(", ") + (names.length > n ? ` and ${names.length - n} more` : "");
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function base(claim: PolicyClaim, audit: BrowserAudit | undefined) {
  return {
    key: claim.key,
    title: CLAIMS[claim.key].title,
    claim,
    observed: audit ? { baseline: audit.summary.baseline, gpc: audit.summary.gpc, rejectAll: audit.summary.reject_all, acceptAll: audit.summary.accept_all } : undefined,
  };
}

function inconclusive(claim: PolicyClaim, audit: BrowserAudit | undefined, why: string): Comparison {
  return { ...base(claim, audit), verdict: "inconclusive", headline: "We couldn't test this", explanation: why, caveats: [] };
}

function compareGpc(claim: PolicyClaim, audit: BrowserAudit | undefined): Comparison {
  const gpc = audit?.summary.gpc;
  if (!audit || !gpc) return inconclusive(claim, audit, "The visit with Global Privacy Control turned on didn't complete.");
  const ads = gpc.stableCookies.filter((c) => c.category === "advertising");
  const thirdPartyAds = ads.filter((c) => c.thirdParty);
  const baselineAds = audit.summary.baseline?.stable.advertising;
  const change = baselineAds !== undefined ? ` (${baselineAds} without GPC)` : "";
  const gpcJson = audit.gpcJson.found ? (audit.gpcJson.gpc ? " The site also publishes a /.well-known/gpc.json file saying it supports GPC." : " The site's /.well-known/gpc.json file does not declare GPC support.") : "";
  const caveats = [...GPC_CAVEATS, ...COMMON_CAVEATS];

  if (claim.value === "yes") {
    if (thirdPartyAds.length > 0) {
      return {
        ...base(claim, audit),
        verdict: "possible_gap",
        headline: `${plural(thirdPartyAds.length, "third-party advertising cookie")} still set with GPC on`,
        explanation: `The policy says it honors GPC, but with GPC turned on, every visit still wrote ${plural(ads.length, "advertising cookie")}${change}, ${thirdPartyAds.length} of them from outside companies such as ${list(thirdPartyAds)}.${gpcJson}`,
        observed: { baseline: audit.summary.baseline, gpc, cookies: thirdPartyAds },
        caveats,
      };
    }
    return {
      ...base(claim, audit),
      verdict: "consistent",
      headline: ads.length ? "Only the site's own ad cookies with GPC on" : "No advertising cookies with GPC on",
      explanation: `The policy says it honors GPC, and with GPC turned on no outside company wrote an advertising cookie on every visit${change}.${gpcJson}`,
      observed: { baseline: audit.summary.baseline, gpc, cookies: ads },
      caveats,
    };
  }
  return {
    ...base(claim, audit),
    verdict: "not_stated",
    headline: claim.value === "no" ? "The policy says it doesn't honor GPC" : "The policy doesn't mention GPC",
    explanation: `With GPC turned on, every visit wrote ${plural(ads.length, "advertising cookie")}${change}.${gpcJson}`,
    observed: { baseline: audit.summary.baseline, gpc, cookies: thirdPartyAds },
    caveats,
  };
}

function compareThirdPartyTracking(claim: PolicyClaim, audit: BrowserAudit | undefined): Comparison {
  const b = audit?.summary.baseline;
  if (!audit || !b) return inconclusive(claim, audit, "The default visit didn't complete.");
  const tracking = b.stableCookies.filter((c) => c.thirdParty && isTracking(c));
  const unknown3p = b.stableCookies.filter((c) => c.thirdParty && c.category === "unknown").length;
  const extra = unknown3p ? ` Another ${plural(unknown3p, "third-party cookie")} couldn't be identified.` : "";
  const observed = `${plural(tracking.length, "third-party analytics or advertising cookie")} on every visit${tracking.length ? `, from ${list(tracking)}` : ""}.${extra}`;
  if (claim.value === "no" && tracking.length > 0) {
    return { ...base(claim, audit), verdict: "possible_gap", headline: "Third-party trackers found despite the policy", explanation: `The policy says third parties don't track on the site, but we saw ${observed}`, observed: { baseline: b, cookies: tracking }, caveats: COMMON_CAVEATS };
  }
  if (claim.value === "yes") {
    return { ...base(claim, audit), verdict: "consistent", headline: tracking.length ? "Disclosed, and we saw it" : "Disclosed; none seen on the homepage", explanation: `The policy says third parties may track on the site. We saw ${observed}`, observed: { baseline: b, cookies: tracking }, caveats: COMMON_CAVEATS };
  }
  return { ...base(claim, audit), verdict: tracking.length && claim.value === "unspecified" ? "possible_gap" : "not_stated", headline: tracking.length ? "Third-party trackers the policy doesn't mention" : "Not mentioned, and none seen", explanation: `The policy doesn't say whether third parties track on the site. We saw ${observed}`, observed: { baseline: b, cookies: tracking }, caveats: COMMON_CAVEATS };
}

function compareConsent(claim: PolicyClaim, audit: BrowserAudit | undefined): Comparison {
  const b = audit?.summary.baseline;
  if (!audit || !b) return inconclusive(claim, audit, "The default visit didn't complete.");
  const tracking = b.stableCookies.filter(isTracking);
  const banner = audit.consentBanner.detected ? `A consent banner${audit.consentBanner.vendor ? ` (${audit.consentBanner.vendor})` : ""} was shown; the default visits didn't click it.` : "We didn't detect a consent banner.";
  const rejectRun = audit.runs.find((r) => r.config === "reject_all");
  const rejected = audit.summary.reject_all;
  const afterReject = rejected?.stableCookies.filter(isTracking) ?? [];
  const rejectNote = !rejectRun
    ? ""
    : !rejected
      ? " We didn't find a one-click Reject All button on the banner's first screen (refusing may take extra steps, or our button matching missed it), so what happens after refusing wasn't tested."
      : afterReject.length
        ? ` After clicking "${rejectRun.consent?.button}", ${plural(afterReject.length, "tracking cookie")} (${list(afterReject)}) were still written.`
        : ` After clicking "${rejectRun.consent?.button}", no tracking cookies were written.`;
  const caveats = ["Consent rules differ by region: many US sites track by default and ask for consent only in Europe. This test ran from the server's location.", ...COMMON_CAVEATS];
  if (claim.value === "yes") {
    if (tracking.length > 0) {
      return { ...base(claim, audit), verdict: "possible_gap", headline: `${plural(tracking.length, "tracking cookie")} before any consent`, explanation: `The policy says non-essential cookies wait for consent. ${banner} Every visit still wrote ${plural(tracking.length, "analytics or advertising cookie")}, from ${list(tracking)}.${rejectNote}`, observed: { baseline: b, cookies: tracking }, caveats };
    }
    return { ...base(claim, audit), verdict: "consistent", headline: "No tracking cookies before consent", explanation: `The policy says non-essential cookies wait for consent. ${banner} No analytics or advertising cookie was written on every visit.${rejectNote}`, observed: { baseline: b, cookies: [] }, caveats };
  }
  return { ...base(claim, audit), verdict: "not_stated", headline: claim.value === "no" ? "The policy says tracking starts by default" : "The policy doesn't say tracking waits for consent", explanation: `${banner} Every visit wrote ${plural(tracking.length, "analytics or advertising cookie")} before any choice was made.${rejectNote}`, observed: { baseline: b, cookies: tracking }, caveats };
}

function compareSaleOrSharing(claim: PolicyClaim, audit: BrowserAudit | undefined): Comparison {
  const b = audit?.summary.baseline;
  const adPartners = b?.stableCookies.filter((c) => c.thirdParty && c.category === "advertising") ?? [];
  const saleWord = claim.key === "sells_personal_info" ? "sell" : "share for targeted ads";
  const context = b ? `For context, every default visit wrote ${plural(adPartners.length, "advertising cookie")} from outside companies${adPartners.length ? ` such as ${list(adPartners)}` : ""}.` : "";
  if (claim.key === "shares_for_targeted_ads" && claim.value === "no" && adPartners.length > 0) {
    return { ...base(claim, audit), verdict: "possible_gap", headline: "Ad-tech cookies despite saying it doesn't share", explanation: `The policy says it doesn't share data for targeted advertising. ${context} Those companies typically use such cookies for targeted ads, which is worth a closer look.`, observed: { baseline: b, cookies: adPartners }, caveats: COMMON_CAVEATS };
  }
  return {
    ...base(claim, audit),
    verdict: claim.value === "unspecified" ? "not_stated" : "not_testable",
    headline: claim.value === "yes" ? `The policy says it does ${saleWord}` : claim.value === "no" ? `The policy says it doesn't ${saleWord}` : `The policy doesn't say whether it does ${saleWord}`,
    explanation: `What happens to data on the company's servers can't be seen from a browser. ${context}`.trim(),
    observed: b ? { baseline: b, cookies: adPartners } : undefined,
    caveats: COMMON_CAVEATS,
  };
}

function compareDnt(claim: PolicyClaim, audit: BrowserAudit | undefined): Comparison {
  return { ...base(claim, audit), verdict: claim.value === "unspecified" ? "not_stated" : "not_testable", headline: claim.value === "yes" ? "The policy says it respects Do Not Track" : claim.value === "no" ? "The policy says it ignores Do Not Track" : "The policy doesn't mention Do Not Track", explanation: "This audit doesn't send the Do Not Track signal, so the claim wasn't tested.", caveats: [] };
}

function compareAiTraining(claim: PolicyClaim, audit: BrowserAudit | undefined): Comparison {
  return {
    ...base(claim, audit),
    verdict: claim.value === "unspecified" ? "not_stated" : "not_testable",
    headline: claim.value === "yes" ? "The policy says your data may train AI" : claim.value === "no" ? "The policy says your data isn't used to train AI" : "The policy doesn't say whether your data trains AI",
    explanation: "A browser can't see how a company uses data once it has it, so this claim wasn't tested. It rests on the policy's own words.",
    caveats: [],
  };
}

const RULES: Record<ClaimKey, (c: PolicyClaim, a: BrowserAudit | undefined) => Comparison> = {
  honors_gpc: compareGpc,
  uses_third_party_trackers: compareThirdPartyTracking,
  tracking_requires_consent: compareConsent,
  shares_for_targeted_ads: compareSaleOrSharing,
  sells_personal_info: compareSaleOrSharing,
  respects_dnt: compareDnt,
  uses_data_for_ai_training: compareAiTraining,
};

const ORDER: Verdict[] = ["possible_gap", "consistent", "not_stated", "not_testable", "inconclusive"];

/** Without an analyzed policy there's nothing to compare, so the report shows observations alone. */
export function compare(policy: PolicyAnalysis | undefined, audit: BrowserAudit | undefined): Comparison[] {
  if (!policy) return [];
  return policy.claims.map((c) => RULES[c.key](c, audit)).sort((a, b) => ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict));
}
