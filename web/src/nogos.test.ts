import { describe, expect, it } from "vitest";
import type { ClaimKey, ClaimValue, Comparison, ConfigSummary, ObservedCookie, Report, TopicKey, TopicStatus } from "./api";
import { evaluateNoGos, summarizeNoGos, type NoGoId } from "./nogos";

const q = (text: string) => ({ blockId: "b1", text });
const cookie = (over: Partial<ObservedCookie> = {}): ObservedCookie => ({ name: "_x", domain: ".ads.example", thirdParty: true, category: "advertising", platform: "AdCo", session: false, ...over });

function summary(stable: ObservedCookie[]): ConfigSummary {
  return { config: "baseline", label: "Default", runs: 2, okRuns: 2, stableCookies: stable } as unknown as ConfigSummary;
}

interface Opts {
  claims?: Partial<Record<ClaimKey, ClaimValue>>;
  topics?: Partial<Record<TopicKey, TopicStatus>>;
  cookies?: ObservedCookie[] | null; // null = audit didn't run
  gpc?: "possible_gap" | "consistent";
  noPolicy?: boolean;
}

function report(o: Opts = {}): Report {
  const claims = Object.entries(o.claims ?? {}).map(([key, value]) => ({ key, value, summary: "", quotes: value === "unspecified" ? [] : [q(`quote for ${key}`)], unsupported: false }));
  const topics = Object.entries(o.topics ?? {}).map(([key, status]) => ({ key, status, summary: "", quotes: status === "not_found" ? [] : [q(`quote for ${key}`)], unsupported: false }));
  const comparisons = o.gpc
    ? [{ key: "honors_gpc", verdict: o.gpc, headline: "Ad cookies still set with GPC on", observed: { cookies: [cookie({ name: "gpc_ad" })] } } as unknown as Comparison]
    : [];
  return {
    id: "r",
    site: "example.com",
    policy: o.noPolicy ? undefined : { claims, topics, optOuts: [] },
    audit: o.cookies === null ? undefined : { summary: { baseline: summary(o.cookies ?? []) } },
    comparisons,
  } as unknown as Report;
}

const one = (id: NoGoId, r: Report, strict = false) => evaluateNoGos(r, [id], { strict })[0];

describe("claim-only rules", () => {
  it.each([
    ["no_sale", "sells_personal_info"],
    ["no_ai_training", "uses_data_for_ai_training"],
  ] as const)("%s: yes breaks, no is ok, silence is unknown", (id, claim) => {
    expect(one(id, report({ claims: { [claim]: "yes" } })).status).toBe("broken");
    expect(one(id, report({ claims: { [claim]: "no" } })).status).toBe("ok");
    expect(one(id, report({ claims: { [claim]: "unspecified" } })).status).toBe("unknown");
  });

  it("carries the policy quote on a broken result", () => {
    const r = one("no_sale", report({ claims: { sells_personal_info: "yes" } }));
    expect(r.quotes[0].text).toContain("sells_personal_info");
    expect(r.basis).toBe("policy");
  });

  it("says so when the policy couldn't be read", () => {
    const r = one("no_sale", report({ noPolicy: true }));
    expect(r.status).toBe("unknown");
    expect(r.explanation).toMatch(/couldn't read/);
  });
});

describe("must_allow_deletion", () => {
  it("is ok when stated and unknown otherwise", () => {
    expect(one("must_allow_deletion", report({ topics: { deletion_rights: "stated" } })).status).toBe("ok");
    expect(one("must_allow_deletion", report({ topics: { deletion_rights: "unclear" } })).status).toBe("unknown");
    expect(one("must_allow_deletion", report({ topics: { deletion_rights: "not_found" } })).status).toBe("unknown");
  });
});

describe("must_state_retention", () => {
  it("is ok when stated; broken when vague or missing (silence is the failure)", () => {
    expect(one("must_state_retention", report({ topics: { retention: "stated" } })).status).toBe("ok");
    const vague = one("must_state_retention", report({ topics: { retention: "unclear" } }));
    expect(vague.status).toBe("broken");
    expect(vague.explanation).toMatch(/as long as necessary/);
    expect(one("must_state_retention", report({ topics: { retention: "not_found" } })).explanation).toMatch(/doesn't say/);
  });
});

describe("must_honor_gpc", () => {
  it("breaks by behavior on a possible gap, with cookie evidence", () => {
    const r = one("must_honor_gpc", report({ claims: { honors_gpc: "yes" }, gpc: "possible_gap" }));
    expect(r.status).toBe("broken");
    expect(r.basis).toBe("both");
    expect(r.cookies?.[0].name).toBe("gpc_ad");
  });
  it("breaks by policy when it says it doesn't respond", () => {
    const r = one("must_honor_gpc", report({ claims: { honors_gpc: "no" } }));
    expect(r.status).toBe("broken");
    expect(r.basis).toBe("policy");
  });
  it("is ok when the policy says yes and the test agrees", () => {
    expect(one("must_honor_gpc", report({ claims: { honors_gpc: "yes" }, gpc: "consistent" })).status).toBe("ok");
  });
  it("is unknown when silent, or when yes can't be confirmed", () => {
    expect(one("must_honor_gpc", report({ claims: { honors_gpc: "unspecified" } })).status).toBe("unknown");
    expect(one("must_honor_gpc", report({ claims: { honors_gpc: "yes" }, cookies: null })).status).toBe("unknown");
  });
});

describe("no_tracking_before_consent", () => {
  it("breaks on cookies seen even when the policy is silent", () => {
    const r = one("no_tracking_before_consent", report({ claims: { tracking_requires_consent: "unspecified" }, cookies: [cookie({ category: "analytics", thirdParty: false })] }));
    expect(r.status).toBe("broken");
    expect(r.basis).toBe("seen");
    expect(r.cookies).toHaveLength(1);
  });
  it("breaks on the policy saying tracking is on by default", () => {
    const r = one("no_tracking_before_consent", report({ claims: { tracking_requires_consent: "no" }, cookies: [] }));
    expect(r.status).toBe("broken");
    expect(r.basis).toBe("policy");
  });
  it("is ok when none were seen", () => {
    expect(one("no_tracking_before_consent", report({ cookies: [cookie({ category: "functional" })] })).status).toBe("ok");
  });
  it("without the test, rests on the policy and otherwise can't tell", () => {
    expect(one("no_tracking_before_consent", report({ claims: { tracking_requires_consent: "no" }, cookies: null })).explanation).toMatch(/policy alone/);
    expect(one("no_tracking_before_consent", report({ claims: { tracking_requires_consent: "yes" }, cookies: null })).status).toBe("unknown");
  });
});

describe("no_ad_sharing", () => {
  it("breaks on the policy, on cookies seen, or both", () => {
    expect(one("no_ad_sharing", report({ claims: { shares_for_targeted_ads: "yes" }, cookies: [] })).basis).toBe("policy");
    expect(one("no_ad_sharing", report({ claims: { shares_for_targeted_ads: "unspecified" }, cookies: [cookie()] })).basis).toBe("seen");
    expect(one("no_ad_sharing", report({ claims: { shares_for_targeted_ads: "yes" }, cookies: [cookie()] })).basis).toBe("both");
  });
  it("is ok when the policy says no and none were seen; unknown when silent", () => {
    expect(one("no_ad_sharing", report({ claims: { shares_for_targeted_ads: "no" }, cookies: [] })).status).toBe("ok");
    expect(one("no_ad_sharing", report({ claims: { shares_for_targeted_ads: "unspecified" }, cookies: [] })).status).toBe("unknown");
  });
  it("ignores a first-party ad cookie", () => {
    expect(one("no_ad_sharing", report({ claims: { shares_for_targeted_ads: "unspecified" }, cookies: [cookie({ thirdParty: false })] })).status).toBe("unknown");
  });
});

describe("no_third_party_trackers", () => {
  it("breaks on outside tracking cookies seen, or on the policy saying yes", () => {
    expect(one("no_third_party_trackers", report({ cookies: [cookie({ category: "analytics" })] })).status).toBe("broken");
    expect(one("no_third_party_trackers", report({ claims: { uses_third_party_trackers: "yes" }, cookies: [] })).basis).toBe("policy");
  });
  it("is ok when the policy says no and none were seen; unknown when silent", () => {
    expect(one("no_third_party_trackers", report({ claims: { uses_third_party_trackers: "no" }, cookies: [] })).status).toBe("ok");
    expect(one("no_third_party_trackers", report({ claims: { uses_third_party_trackers: "unspecified" }, cookies: [] })).status).toBe("unknown");
  });
});

describe("audit missing fallback", () => {
  it("behavior rules fall back to the policy alone and say so", () => {
    const r = report({ claims: { shares_for_targeted_ads: "yes", uses_third_party_trackers: "yes" }, cookies: null });
    for (const id of ["no_ad_sharing", "no_third_party_trackers"] as const) {
      const res = one(id, r);
      expect(res.status).toBe("broken");
      expect(res.explanation).toMatch(/policy alone/);
    }
  });
});

describe("strict mode and ordering", () => {
  it("turns unknown into broken, and leaves ok alone", () => {
    const r = report({ claims: { sells_personal_info: "unspecified", uses_data_for_ai_training: "no" } });
    const res = evaluateNoGos(r, ["no_sale", "no_ai_training"], { strict: true });
    expect(res.find((x) => x.id === "no_sale")?.status).toBe("broken");
    expect(res.find((x) => x.id === "no_sale")?.explanation).toMatch(/^Strict mode:/);
    expect(res.find((x) => x.id === "no_ai_training")?.status).toBe("ok");
  });

  it("sorts broken first, then can't tell, then ok, and summarizes", () => {
    const r = report({ claims: { sells_personal_info: "no", uses_data_for_ai_training: "yes" }, topics: { deletion_rights: "unclear" } });
    const res = evaluateNoGos(r, ["no_sale", "must_allow_deletion", "no_ai_training"], { strict: false });
    expect(res.map((x) => x.status)).toEqual(["broken", "unknown", "ok"]);
    const s = summarizeNoGos(res);
    expect(s.headline).toBe("Breaks 1 of your 3 no-goes");
    expect(s.detail).toBe("1 can't be confirmed from the policy");
    expect(summarizeNoGos(evaluateNoGos(report({ claims: { sells_personal_info: "no" } }), ["no_sale"], { strict: false })).headline).toBe("Breaks none of your 1 no-go");
  });

  it("ignores ids that aren't selected", () => {
    expect(evaluateNoGos(report(), [], { strict: false })).toEqual([]);
  });
});
