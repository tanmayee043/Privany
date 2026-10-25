export type Severity = "high" | "medium" | "low" | "info";
export type Verdict = "red" | "yellow" | "green" | "unknown";
export type Context = "any" | "banner" | "signup" | "checkout" | "upload";

export interface Evidence {
  quote: string;
  verified: boolean;
  url: string | null;
  para: number | null;
  doc_kind?: string;
}

export interface Flag {
  id: string;
  kind: "gap" | "behavior" | "policy" | "change" | "prior";
  severity: Severity;
  title: string;
  detail: string;
  evidence: { quotes: Evidence[]; observed: string[]; test?: string };
  actions: { label: string; how: string; url?: string | null }[];
  caveat: string;
  contexts: Context[];
}

export interface GoodSign {
  id: string;
  title: string;
  detail: string;
  quote?: Evidence | null;
}

export interface FieldHint {
  use: string;
  shared_for_ads: "true" | "false" | "unspecified";
  quote: Evidence;
}

export interface Assessment {
  verdict: Verdict;
  headline: string;
  flags: Flag[];
  good_signs: GoodSign[];
  unknowns: { claim: string; label: string }[];
  field_hints: Record<string, FieldHint>;
  reject_check: { status: "watching" | "done"; verdict: "held" | "broken" | null; detail: string; observed?: string[] } | null;
}

export interface Claim {
  value: "true" | "false" | "unspecified";
  evidence: Evidence;
  note: string;
}

export interface Finding {
  category: string;
  stance: "permits" | "prohibits" | "provides_right" | "unclear";
  statement: string;
  evidence: Evidence;
}

export interface DocMeta {
  url: string;
  kind: string;
  content_hash: string;
  retrieved_at: string;
  paragraphs: number;
  partial: boolean;
  rendered?: boolean;
  notes: string[];
}

export interface PriorAudit {
  policy_url: string | null;
  claims: Record<string, unknown>;
  cookies: Record<string, number> | null;
  crawl_date: string | null;
  gaps: { rule: string; detail: string }[];
}

export interface AnalysisResult {
  site: string;
  engine: string | null;
  analyzed_at?: string;
  documents: DocMeta[];
  analysis: {
    summary: string;
    claims: Record<string, Claim>;
    findings: Finding[];
    field_uses: { field: string; use: string; shared_for_ads: string; evidence: Evidence }[];
    opt_outs: { label: string; how: string; url: string; evidence: Evidence }[];
    quote_check: { total: number; verified: number };
  } | null;
  prior_audit: PriorAudit | null;
  errors: string[];
  cached?: boolean;
}

export interface SeenCookie {
  name: string;
  domain: string;
  category: string;
  third_party: boolean;
  owner: string | null;
  ad_platform: boolean;
  at: number;
  before_choice: boolean;
  via: "http" | "js";
}

export interface SeenTracker {
  domain: string;
  owner: string;
  ad: boolean;
  requests: number;
  first_at: number;
  before_choice: boolean;
}

export interface RejectCheck {
  clicked_at: number;
  window_s: number;
  status: "watching" | "done";
  new_cookies: { name: string; domain: string; owner: string | null }[];
  ad_requests: { domain: string; owner: string; ad: boolean; requests: number }[];
}

export interface PageInfo {
  url: string;
  title: string;
  links: { privacy: string[]; terms: string[]; cookies: string[] };
  banner: { found: boolean; cmp: string | null };
  contexts: Context[];
  fields: string[];
  agreeBoxes: number;
}

export interface GpcAudit {
  site: string;
  ran_at: string;
  browser: string;
  method: string;
  default: AuditRun;
  gpc: AuditRun;
  targeting_reduction: number | null;
  well_known_gpc: { gpc: boolean; lastUpdate?: string } | null;
  inconclusive: string[];
  limits: string[];
}

export interface AuditRun {
  ok: boolean;
  error: string | null;
  cookies: { name: string; domain: string; category: string; third_party: boolean; owner: string | null; ad_platform: boolean }[];
  trackers: { domain: string; owner: string; ad: boolean; requests: number }[];
  counts: { total: number; targeting: number; targeting_3p: number; ad_platform: number; ad_trackers: number };
  banner: { found: boolean; cmp: string | null };
}

export interface TabState {
  tabId: number;
  url: string;
  origin: string;
  site: string;        // registrable domain (for cookie matching)
  siteKey: string;     // cache key (keeps port for localhost)
  startedAt: number;
  page?: PageInfo;
  cookies: Record<string, SeenCookie>;
  trackers: Record<string, SeenTracker>;
  choice: { value: "none" | "accepted" | "rejected"; at: number | null };
  reject?: RejectCheck;
  status: "idle" | "analyzing" | "ready" | "error" | "skipped" | "paused";
  error?: string;
  analysis?: AnalysisResult;
  assessment?: Assessment;
  gpc?: { status: "none" | "running" | "done" | "error"; result?: GpcAudit; error?: string };
}

export interface Receipt {
  id: string;
  siteKey: string;
  site: string;
  agreed_at: string;
  page_url: string;
  how: "checkbox" | "submit" | "banner_accept";
  documents: { url: string; kind: string; content_hash: string; retrieved_at: string; paragraphs: string[] }[];
  verdict_then: Verdict;
  headline_then: string;
  // the promises as they stood when you agreed, to compare against later
  claims_then?: Record<string, { value: string; quote: string }>;
  findings_then?: { category: string; stance: string }[];
}

export interface Preferences {
  ad_tracking: number;
  selling_sharing: number;
  ai_training: number;
  sensitive_fields: number;
  legal_traps: number;
  retention_deletion: number;
}

export interface Settings {
  backendUrl: string;
  mode: "auto" | "moments";
  sendGpc: boolean;
  autoGpcTest: boolean;
  gate: boolean;            // stop and ask before you agree on a risky site
  preferences: Preferences;
  paused: string[];
  onboarded: boolean;
}
