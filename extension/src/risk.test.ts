import { describe, expect, it } from "vitest";
import { assessRisk, type Observed } from "./risk";
import type { ClaimKey, ClaimValue, QuickCheck } from "../../server/src/report/types";

const quiet: Observed = { adTrackers: [], trackingCookies: [], bannerVisible: false };
const adtech: Observed = { adTrackers: [{ domain: "doubleclick.net", owner: "Google" }, { domain: "criteo.com", owner: "Criteo" }], trackingCookies: [], bannerVisible: false };

function quick(claims: Partial<Record<ClaimKey, ClaimValue>> = {}, extra: Partial<QuickCheck> = {}): QuickCheck {
  const keys: ClaimKey[] = ["honors_gpc", "sells_personal_info", "shares_for_targeted_ads", "uses_third_party_trackers", "tracking_requires_consent", "respects_dnt", "uses_data_for_ai_training"];
  return {
    site: "example.com",
    checkedAt: "",
    policy: {
      isPrivacyPolicy: true,
      claims: keys.map((key) => ({ key, value: claims[key] ?? "unspecified", summary: "", quote: claims[key] && claims[key] !== "unspecified" ? { blockId: "b1", text: `quote for ${key}` } : undefined })),
      topics: [],
      optOuts: [],
      fieldUses: [],
    },
    ...extra,
  };
}

describe("risk rules", () => {
  it("is green for a quiet site with a readable policy", () => {
    expect(assessRisk(quiet, quick({ sells_personal_info: "no" }))).toEqual({ level: "green", reasons: [] });
  });

  it("is unknown when there's no policy and nothing seen", () => {
    expect(assessRisk(quiet, { site: "x.com", checkedAt: "", policyError: "no policy" }).level).toBe("unknown");
  });

  it("flags 'doesn't sell' with ad-tech on the page as red (PrivAudit rule)", () => {
    const a = assessRisk(adtech, quick({ sells_personal_info: "no" }));
    expect(a.level).toBe("red");
    expect(a.reasons[0]).toMatchObject({ id: "no_sell_but_adtech", severity: "high", basis: "policy_and_page" });
    expect(a.reasons[0].quote?.text).toContain("sells_personal_info");
    expect(a.reasons[0].detail).toContain("Google, Criteo");
  });

  it("gives one lesser finding a yellow badge, not a pop-up", () => {
    expect(assessRisk(adtech, quick()).level).toBe("yellow");
  });

  it("turns red with two lesser findings together", () => {
    const a = assessRisk({ ...adtech, bannerVisible: true }, quick());
    expect(a.reasons.map((r) => r.id)).toEqual(["silent_with_adtech", "tracking_before_consent"]);
    expect(a.level).toBe("red");
  });

  it("treats tracking before consent as serious when the policy promised to wait", () => {
    const a = assessRisk({ ...quiet, bannerVisible: true, trackingCookies: [{ name: "_fbp" }] }, quick({ tracking_requires_consent: "yes" }));
    expect(a.reasons[0]).toMatchObject({ id: "tracking_before_consent_promised", severity: "high" });
    expect(a.level).toBe("red");
  });

  it("uses PrivAudit's past audit of the site", () => {
    const a = assessRisk(quiet, quick({}, { priorAudit: { crawlDate: "2025-03-08", gaps: [{ rule: "gpc_claim_no_reduction", detail: "Policy says it honors GPC, but targeting cookies only dropped 0%." }] } }));
    expect(a.reasons[0]).toMatchObject({ id: "research_gap", basis: "research" });
    expect(a.reasons[0].title).toContain("2025");
    expect(a.level).toBe("red");
  });

  it("flags a policy that says it sells data, with its quote", () => {
    const a = assessRisk(quiet, quick({ sells_personal_info: "yes" }));
    expect(a.reasons[0]).toMatchObject({ id: "sells_data", severity: "high" });
    expect(a.reasons[0].quote).toBeDefined();
  });

  it("notes ad-tech on a site with no findable policy", () => {
    const a = assessRisk(adtech, { site: "x.com", checkedAt: "", policyError: "none" });
    expect(a.reasons.map((r) => r.id)).toEqual(["no_policy_with_adtech"]);
    expect(a.level).toBe("yellow");
  });
});
