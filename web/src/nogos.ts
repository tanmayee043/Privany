import type { ClaimKey, ObservedCookie, PolicyClaim, PolicyTopic, Quote, Report, TopicKey } from "./api";

// "No-goes" are the user's dealbreakers, chosen from this fixed menu. Each one
// is checked against data the report already has; nothing is sent anywhere.
// Silence in a policy is "unknown", never "broken", except for the "must say"
// rules where saying nothing is the failure, or when the user turns on strict mode.

export type NoGoId =
  | "no_sale"
  | "no_ai_training"
  | "must_allow_deletion"
  | "must_state_retention"
  | "must_honor_gpc"
  | "no_tracking_before_consent"
  | "no_ad_sharing"
  | "no_third_party_trackers";

export interface NoGoInfo {
  id: NoGoId;
  label: string;
  hint: string;
  /** What evidence the rule can use: the policy's words, what the browser saw, or both. */
  kind: "policy" | "behavior" | "both";
}

export const NO_GO_CATALOG: NoGoInfo[] = [
  { id: "no_sale", label: "Don't sell my data", hint: "The policy shouldn't say it sells personal information", kind: "policy" },
  { id: "no_ai_training", label: "Don't train AI on my data", hint: "The policy shouldn't say your content trains AI models", kind: "policy" },
  { id: "must_allow_deletion", label: "Must let me delete my data", hint: "The policy should describe a way to request deletion", kind: "policy" },
  { id: "must_state_retention", label: "Must say how long it keeps data", hint: "A real time period, not just \"as long as necessary\"", kind: "policy" },
  { id: "must_honor_gpc", label: "Must honor my opt-out signal (GPC)", hint: "Promises to honor Global Privacy Control, and does in our test", kind: "both" },
  { id: "no_tracking_before_consent", label: "No tracking before I agree", hint: "No analytics or ad cookies before you click anything", kind: "both" },
  { id: "no_ad_sharing", label: "Don't share my data with advertisers", hint: "No targeted-ad sharing, no outside ad cookies", kind: "both" },
  { id: "no_third_party_trackers", label: "No third-party trackers", hint: "No outside analytics or advertising cookies on the site", kind: "both" },
];

export type NoGoStatus = "broken" | "ok" | "unknown";

export interface NoGoResult {
  id: NoGoId;
  status: NoGoStatus;
  /** Where the evidence comes from: the policy's words, what the test saw, or both. */
  basis: "policy" | "seen" | "both";
  explanation: string;
  quotes: Quote[];
  cookies?: ObservedCookie[];
}

export interface NoGoPrefs {
  selected: NoGoId[];
  /** Treat "the policy doesn't say" as breaking the no-go. */
  strict: boolean;
}

const claimOf = (r: Report, k: ClaimKey): PolicyClaim | undefined => r.policy?.claims.find((c) => c.key === k);
const topicOf = (r: Report, k: TopicKey): PolicyTopic | undefined => r.policy?.topics.find((t) => t.key === k);
const isTracking = (c: ObservedCookie) => c.category === "analytics" || c.category === "advertising";
const uniqueCookies = (cs: ObservedCookie[]) => [...new Map(cs.map((c) => [`${c.name}@${c.domain}`, c])).values()].slice(0, 12);

const owners = (cs: ObservedCookie[]) => {
  const names = [...new Set(cs.map((c) => c.platform ?? c.domain))];
  return names.slice(0, 4).join(", ") + (names.length > 4 ? ` and ${names.length - 4} more` : "");
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

const NO_POLICY = "We couldn't read this site's policy, so there's nothing to check this against.";
const NO_TEST = " The site test didn't run, so this rests on the policy alone.";

type Rule = (r: Report) => Omit<NoGoResult, "id">;

const unknown = (explanation: string, quotes: Quote[] = []): Omit<NoGoResult, "id"> => ({ status: "unknown", basis: "policy", explanation, quotes });

/** An unknown that mentions what the test saw is based on both the policy and the test. */
const withBasis = (base: unknown, r: Omit<NoGoResult, "id">): Omit<NoGoResult, "id"> => (base ? { ...r, basis: "both" } : r);

/** Shared by the claim-only rules: yes → broken, no → ok, otherwise unknown. */
function claimRule(key: ClaimKey, brokenText: string, okText: string, silentText: string): Rule {
  return (r) => {
    const c = claimOf(r, key);
    if (!c) return unknown(NO_POLICY);
    if (c.value === "yes") return { status: "broken", basis: "policy", explanation: brokenText, quotes: c.quotes };
    if (c.value === "no") return { status: "ok", basis: "policy", explanation: okText, quotes: c.quotes };
    return unknown(silentText, c.quotes);
  };
}

const RULES: Record<NoGoId, Rule> = {
  no_sale: claimRule("sells_personal_info", "The policy says it sells personal information.", "The policy says it doesn't sell personal information.", "The policy doesn't say whether it sells your data."),
  no_ai_training: claimRule("uses_data_for_ai_training", "The policy says your data or content may be used to train AI.", "The policy says your data isn't used to train AI.", "The policy doesn't say whether your data trains AI."),

  must_allow_deletion: (r) => {
    const t = topicOf(r, "deletion_rights");
    if (!t) return unknown(NO_POLICY);
    if (t.status === "stated") return { status: "ok", basis: "policy", explanation: "The policy describes a way to request deletion.", quotes: t.quotes };
    return unknown(t.status === "unclear" ? "The policy mentions deletion without a clear way to ask for it." : "We couldn't find a way to request deletion in the policy.", t.quotes);
  },

  // Here silence is the failure: the rule asks the policy to say something.
  must_state_retention: (r) => {
    const t = topicOf(r, "retention");
    if (!t) return unknown(NO_POLICY);
    if (t.status === "stated") return { status: "ok", basis: "policy", explanation: "The policy gives specific retention periods.", quotes: t.quotes };
    return {
      status: "broken",
      basis: "policy",
      explanation: t.status === "unclear" ? "The policy only says it keeps data \"as long as necessary\", with no specific period." : "The policy doesn't say how long it keeps data.",
      quotes: t.quotes,
    };
  },

  must_honor_gpc: (r) => {
    const c = claimOf(r, "honors_gpc");
    const cmp = r.comparisons.find((x) => x.key === "honors_gpc");
    if (!c) return unknown(NO_POLICY);
    if (cmp?.verdict === "possible_gap") {
      const cookies = uniqueCookies(cmp.observed?.cookies ?? []);
      return { status: "broken", basis: "both", explanation: `The policy says it honors GPC, but ${cmp.headline.toLowerCase()} in our test.`, quotes: c.quotes, cookies };
    }
    if (c.value === "no") return { status: "broken", basis: "policy", explanation: "The policy says it doesn't respond to Global Privacy Control.", quotes: c.quotes };
    if (c.value === "yes" && cmp?.verdict === "consistent") return { status: "ok", basis: "both", explanation: "The policy says it honors GPC, and our test with GPC on matched that.", quotes: c.quotes };
    if (c.value === "yes") return unknown("The policy says it honors GPC, but our test couldn't confirm it." + (r.audit ? "" : NO_TEST), c.quotes);
    return unknown("The policy doesn't say whether it honors Global Privacy Control.", c.quotes);
  },

  no_tracking_before_consent: (r) => {
    const c = claimOf(r, "tracking_requires_consent");
    const base = r.audit?.summary.baseline;
    const seen = uniqueCookies(base?.stableCookies.filter(isTracking) ?? []);
    if (seen.length) {
      const policyNo = c?.value === "no";
      return {
        status: "broken",
        basis: policyNo ? "both" : "seen",
        explanation: `Seen in our test: ${plural(seen.length, "analytics or advertising cookie")} written before any choice, from ${owners(seen)}.${policyNo ? " The policy also says tracking is on by default." : ""}`,
        quotes: policyNo ? c.quotes : [],
        cookies: seen,
      };
    }
    if (c?.value === "no") return { status: "broken", basis: "policy", explanation: "The policy says tracking is on by default unless you opt out." + (base ? "" : NO_TEST), quotes: c.quotes };
    if (base) return { status: "ok", basis: c?.value === "yes" ? "both" : "seen", explanation: "No analytics or advertising cookie was written on every visit before any choice.", quotes: c?.value === "yes" ? c.quotes : [] };
    return unknown(`We couldn't test this.${NO_TEST}`, c?.quotes ?? []);
  },

  no_ad_sharing: (r) => {
    const c = claimOf(r, "shares_for_targeted_ads");
    const base = r.audit?.summary.baseline;
    const ads = uniqueCookies(base?.stableCookies.filter((x) => x.thirdParty && x.category === "advertising") ?? []);
    if (c?.value === "yes" || ads.length) {
      const parts = [c?.value === "yes" && "The policy says data is used or shared for targeted advertising.", ads.length && `Seen in our test: ${plural(ads.length, "outside advertising cookie")} from ${owners(ads)}.`];
      return { status: "broken", basis: c?.value === "yes" && ads.length ? "both" : ads.length ? "seen" : "policy", explanation: parts.filter(Boolean).join(" ") + (base ? "" : NO_TEST), quotes: c?.value === "yes" ? c.quotes : [], cookies: ads.length ? ads : undefined };
    }
    if (c?.value === "no" && base) return { status: "ok", basis: "both", explanation: "The policy says it doesn't share for targeted ads, and no outside advertising cookie was seen.", quotes: c.quotes };
    if (!c) return unknown(NO_POLICY + (base ? " No outside advertising cookie was seen." : ""));
    return withBasis(base, unknown(c.value === "no" ? "The policy says it doesn't share for targeted ads." + NO_TEST : "The policy doesn't say, and no outside advertising cookie was seen." + (base ? "" : NO_TEST), c.quotes));
  },

  no_third_party_trackers: (r) => {
    const c = claimOf(r, "uses_third_party_trackers");
    const base = r.audit?.summary.baseline;
    const seen = uniqueCookies(base?.stableCookies.filter((x) => x.thirdParty && isTracking(x)) ?? []);
    if (seen.length || c?.value === "yes") {
      const parts = [seen.length && `Seen in our test: ${plural(seen.length, "outside tracking cookie")} from ${owners(seen)}.`, c?.value === "yes" && "The policy says third parties may track on the site."];
      return { status: "broken", basis: seen.length && c?.value === "yes" ? "both" : seen.length ? "seen" : "policy", explanation: parts.filter(Boolean).join(" ") + (base ? "" : NO_TEST), quotes: c?.value === "yes" ? c.quotes : [], cookies: seen.length ? seen : undefined };
    }
    if (c?.value === "no" && base) return { status: "ok", basis: "both", explanation: "The policy says third parties don't track here, and none were seen in our test.", quotes: c.quotes };
    if (!c) return unknown(NO_POLICY);
    return withBasis(base, unknown(c.value === "no" ? "The policy says third parties don't track here." + NO_TEST : "The policy doesn't say, and no outside tracking cookie was seen." + (base ? "" : NO_TEST), c.quotes));
  },
};

const ORDER: Record<NoGoStatus, number> = { broken: 0, unknown: 1, ok: 2 };

/** Checks each chosen no-go against the report. Broken first, then can't-tell, then ok. */
export function evaluateNoGos(report: Report, selectedIds: NoGoId[], opts: { strict: boolean }): NoGoResult[] {
  const ids = NO_GO_CATALOG.map((n) => n.id).filter((id) => selectedIds.includes(id));
  return ids
    .map((id): NoGoResult => {
      const r = RULES[id](report);
      if (opts.strict && r.status === "unknown") return { id, ...r, status: "broken", explanation: `Strict mode: ${r.explanation[0].toLowerCase()}${r.explanation.slice(1)}` };
      return { id, ...r };
    })
    .sort((a, b) => ORDER[a.status] - ORDER[b.status]);
}

export function summarizeNoGos(results: NoGoResult[]): { broken: number; ok: number; unknown: number; total: number; headline: string; detail?: string } {
  const count = (s: NoGoStatus) => results.filter((r) => r.status === s).length;
  const broken = count("broken");
  const unknownN = count("unknown");
  const total = results.length;
  return {
    broken,
    ok: count("ok"),
    unknown: unknownN,
    total,
    headline: broken ? `Breaks ${broken} of your ${total} no-go${total === 1 ? "" : "es"}` : `Breaks none of your ${total} no-go${total === 1 ? "" : "es"}`,
    detail: unknownN ? `${unknownN} can't be confirmed from the policy` : undefined,
  };
}

// ---- Storage: stays on this device. chrome.storage.sync in the extension, localStorage on the web.

const STORAGE_KEY = "privany.nogos.v1";
export const DEFAULT_NOGOS: NoGoPrefs = { selected: [], strict: false };

interface SyncArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}
const syncArea = (): SyncArea | undefined => (globalThis as { chrome?: { storage?: { sync?: SyncArea } } }).chrome?.storage?.sync;

function clean(raw: unknown): NoGoPrefs {
  const p = (raw ?? {}) as Partial<NoGoPrefs>;
  const known = new Set<string>(NO_GO_CATALOG.map((n) => n.id));
  return { selected: Array.isArray(p.selected) ? (p.selected.filter((id) => known.has(id)) as NoGoId[]) : [], strict: p.strict === true };
}

export async function loadNoGos(): Promise<NoGoPrefs> {
  try {
    const sync = syncArea();
    if (sync) return clean((await sync.get(STORAGE_KEY))[STORAGE_KEY]);
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return clean(JSON.parse(raw));
  } catch {
    // Storage can be unavailable (private mode); an empty list is fine.
  }
  return DEFAULT_NOGOS;
}

export async function saveNoGos(p: NoGoPrefs): Promise<void> {
  try {
    const sync = syncArea();
    if (sync) await sync.set({ [STORAGE_KEY]: p });
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    // Not persisting is acceptable.
  }
}
