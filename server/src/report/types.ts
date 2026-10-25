// Shared shapes for a Privany report. The web app imports these too, so keep
// them free of Node-only types.

export type ClaimKey =
  | "honors_gpc"
  | "sells_personal_info"
  | "shares_for_targeted_ads"
  | "uses_third_party_trackers"
  | "tracking_requires_consent"
  | "respects_dnt";

export type ClaimValue = "yes" | "no" | "unspecified";

export type TopicKey =
  | "data_collected"
  | "advertising_tracking"
  | "third_party_sharing"
  | "data_sale"
  | "retention"
  | "deletion_rights"
  | "ai_training"
  | "user_rights";

export type TopicStatus = "stated" | "unclear" | "not_found";

export type OptOutKind = "link" | "email" | "form" | "setting" | "phone" | "browser_signal" | "other";

export interface PolicyBlock {
  id: string;
  kind: "heading" | "text";
  text: string;
  section?: string;
}

export interface Quote {
  blockId: string;
  text: string;
  section?: string;
}

export interface EvidenceCounts {
  proposed: number;
  verified: number;
}

export interface PolicyClaim {
  key: ClaimKey;
  value: ClaimValue;
  summary: string;
  quotes: Quote[];
  /** The model gave a yes/no answer but none of its quotes appeared in the policy. */
  unsupported: boolean;
}

export interface PolicyTopic {
  key: TopicKey;
  status: TopicStatus;
  summary: string;
  quotes: Quote[];
  unsupported: boolean;
}

export interface OptOut {
  kind: OptOutKind;
  label: string;
  detail: string;
  quotes: Quote[];
}

export interface PolicyAnalysis {
  source: { url?: string; pasted: boolean; retrievedAt: string; title?: string; sha256: string; chars: number; truncated: boolean };
  blocks: PolicyBlock[];
  isPrivacyPolicy: boolean;
  claims: PolicyClaim[];
  topics: PolicyTopic[];
  optOuts: OptOut[];
  evidence: EvidenceCounts;
  /** Text in the policy that looked like instructions aimed at an AI. */
  injectionWarnings: string[];
  model: string;
}

export type CookieCategory = "necessary" | "functional" | "analytics" | "advertising" | "unknown";

export interface ObservedCookie {
  name: string;
  domain: string;
  thirdParty: boolean;
  category: CookieCategory;
  platform?: string;
  description?: string;
  session: boolean;
  expiresInDays?: number;
  /** Only kept for consent-state cookies (e.g. usprivacy), never for identifiers. */
  consentValue?: string;
}

export type AuditConfigKey = "baseline" | "gpc" | "accept_all" | "reject_all";

export interface AuditRun {
  config: AuditConfigKey;
  /** For the Accept All / Reject All visits: whether a button was found and pressed, and its label. */
  consent?: { clicked: boolean; button?: string };
  repeat: number;
  label: string;
  ok: boolean;
  error?: string;
  finalUrl?: string;
  /** Navigation hit the timeout; cookies are what had loaded by then. */
  partial: boolean;
  durationMs: number;
  cookies: ObservedCookie[];
  thirdPartyHosts: string[];
}

export interface CookieTotals {
  total: number;
  thirdParty: number;
  advertising: number;
  analytics: number;
  thirdPartyTracking: number;
}

export interface ConfigSummary {
  config: AuditConfigKey;
  label: string;
  runs: number;
  okRuns: number;
  /** Range of per-run counts, to show how much repeat visits varied. */
  min: CookieTotals;
  max: CookieTotals;
  /** Cookies written in every successful run of this configuration. */
  stableCookies: ObservedCookie[];
  stable: CookieTotals;
}

export interface BrowserAudit {
  site: string;
  startedAt: string;
  browserVersion: string;
  runs: AuditRun[];
  summary: Partial<Record<AuditConfigKey, ConfigSummary>>;
  consentBanner: { detected: boolean; vendor?: string };
  homepageLinks: { privacyPolicy: string[]; optOut: { text: string; href: string }[] };
  gpcJson: { found: boolean; gpc?: boolean; lastUpdate?: string; error?: string };
}

export type Verdict = "consistent" | "possible_gap" | "not_stated" | "not_testable" | "inconclusive";

export interface Comparison {
  key: ClaimKey;
  title: string;
  claim: PolicyClaim;
  verdict: Verdict;
  headline: string;
  explanation: string;
  observed?: {
    baseline?: ConfigSummary;
    gpc?: ConfigSummary;
    rejectAll?: ConfigSummary;
    acceptAll?: ConfigSummary;
    /** The cookies this verdict rests on. */
    cookies?: ObservedCookie[];
  };
  caveats: string[];
}

export type PriorityKey = "ads" | "sale" | "ai" | "retention" | "deletion";

export interface Report {
  id: string;
  createdAt: string;
  input: { url: string; policyUrl?: string; pastedPolicy: boolean };
  site: string;
  policy?: PolicyAnalysis;
  policyError?: string;
  audit?: BrowserAudit;
  auditError?: string;
  comparisons: Comparison[];
  limitations: string[];
  timings: Record<string, number>;
}

export type StepKey = "validate" | "audit" | "policy_fetch" | "policy_analyze" | "compare";
export type StepState = "pending" | "running" | "done" | "skipped" | "failed";

export interface JobStatus {
  id: string;
  state: "queued" | "running" | "done" | "failed";
  steps: { key: StepKey; label: string; state: StepState; detail?: string }[];
  reportId?: string;
  error?: string;
  /** True when an earlier report for the same inputs was reused instead of re-running the audit. */
  cached?: boolean;
}
