import type { ClaimKey, Comparison, OptOut, PriorityKey, Report, TopicKey, Verdict } from "./api";

export type Weight = 0 | 1 | 2;
export type Priorities = Record<PriorityKey, Weight>;

export const PRIORITY_INFO: Record<PriorityKey, { label: string; hint: string }> = {
  ads: { label: "Being tracked for ads", hint: "Cookies and trackers that follow you across sites" },
  sale: { label: "My data being sold or shared", hint: "Data passed to advertisers, brokers or partners" },
  ai: { label: "AI training on my data", hint: "Your content used to train or improve models" },
  retention: { label: "How long data is kept", hint: "Whether there's a clear time limit" },
  deletion: { label: "Being able to delete my data", hint: "A clear way to have it erased" },
};

export const DEFAULT_PRIORITIES: Priorities = { ads: 2, sale: 2, ai: 1, retention: 1, deletion: 1 };

const STORAGE_KEY = "privany.priorities.v1";

export function loadPriorities(): Priorities {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_PRIORITIES, ...(JSON.parse(raw) as Partial<Priorities>) };
  } catch {
    // Storage can be unavailable (private mode); defaults are fine.
  }
  return DEFAULT_PRIORITIES;
}

export function savePriorities(p: Priorities) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    // Not persisting is acceptable.
  }
}

export const CLAIM_PRIORITY: Record<ClaimKey, PriorityKey> = {
  honors_gpc: "sale",
  sells_personal_info: "sale",
  shares_for_targeted_ads: "ads",
  uses_third_party_trackers: "ads",
  tracking_requires_consent: "ads",
  respects_dnt: "ads",
  uses_data_for_ai_training: "ai",
};

export const TOPIC_PRIORITY: Partial<Record<TopicKey, PriorityKey>> = {
  advertising_tracking: "ads",
  third_party_sharing: "sale",
  data_sale: "sale",
  ai_training: "ai",
  retention: "retention",
  deletion_rights: "deletion",
};

const VERDICT_RANK: Record<Verdict, number> = { possible_gap: 3, not_stated: 1.5, consistent: 1, not_testable: 0.5, inconclusive: 0.25 };

/** Orders comparisons by how much they matter to this person: verdict severity times their priority. */
export function rankComparisons(cs: Comparison[], p: Priorities): Comparison[] {
  const score = (c: Comparison) => VERDICT_RANK[c.verdict] * (1 + p[CLAIM_PRIORITY[c.key]]);
  return [...cs].sort((a, b) => score(b) - score(a));
}

export interface NextStep {
  title: string;
  detail: string;
  source: "policy" | "general";
  optOut?: OptOut;
  priority: PriorityKey;
}

/**
 * Finds an opt-out of the given kinds whose policy sentence matches. Matching
 * the quoted sentence (not our own label) and leaving out browser cookie
 * controls keeps "delete cookies in your browser" from passing as a way to
 * have the company delete your data.
 */
function optOutFor(report: Report, kinds: OptOut["kind"][], re: RegExp, unless?: RegExp): OptOut | undefined {
  return report.policy?.optOuts.find((o) => {
    const said = o.quotes.map((q) => q.text).join(" ");
    return kinds.includes(o.kind) && re.test(said) && !(unless && unless.test(said));
  });
}

const REQUEST_ROUTES: OptOut["kind"][] = ["email", "form", "link", "phone"];

/** Builds next steps from the policy's documented choices first, then general, clearly labeled tips. */
export function nextSteps(report: Report, p: Priorities): NextStep[] {
  const steps: NextStep[] = [];
  const gap = (k: ClaimKey) => report.comparisons.find((c) => c.key === k)?.verdict === "possible_gap";
  const saleOptOut = optOutFor(report, [...REQUEST_ROUTES, "browser_signal"], /\bsell|\bsale\b|\bshar(e|ing)\b|opt[- ]?out|privacy choices|targeted|advertis/i);
  const deletion = optOutFor(report, REQUEST_ROUTES, /delet|eras/i, /\bcookies?\b.{0,40}\bdelet|delet\w*.{0,40}\bcookies?\b|browser settings/i);
  const cookieSettings = optOutFor(report, ["setting"], /cookie|consent|preference/i);
  const aiOptOut = optOutFor(report, REQUEST_ROUTES.concat("setting"), /\bAI\b|artificial intelligence|machine learning|train/i);

  if (p.sale > 0 || p.ads > 0) {
    if (saleOptOut) {
      steps.push({
        title: gap("honors_gpc") ? "Use the site's own opt-out; GPC may not be enough here" : `Opt out: ${saleOptOut.label}`,
        detail: saleOptOut.detail,
        source: "policy",
        optOut: saleOptOut,
        priority: "sale",
      });
    }
    if (report.audit?.homepageLinks.optOut.length && !saleOptOut) {
      const l = report.audit.homepageLinks.optOut[0];
      steps.push({ title: `Use the "${l.text}" link on the homepage`, detail: l.href, source: "policy", priority: "sale" });
    }
  }
  if (p.ads > 0 && cookieSettings && cookieSettings !== saleOptOut) {
    steps.push({ title: `Change cookie settings: ${cookieSettings.label}`, detail: cookieSettings.detail, source: "policy", optOut: cookieSettings, priority: "ads" });
  }
  if (p.deletion > 0 && deletion) {
    steps.push({ title: `Request deletion: ${deletion.label}`, detail: deletion.detail, source: "policy", optOut: deletion, priority: "deletion" });
  }
  if (p.ai > 0 && aiOptOut) {
    steps.push({ title: `Opt out of AI training: ${aiOptOut.label}`, detail: aiOptOut.detail, source: "policy", optOut: aiOptOut, priority: "ai" });
  }
  for (const o of report.policy?.optOuts ?? []) {
    if (steps.length >= 5) break;
    if (steps.some((s) => s.optOut === o)) continue;
    steps.push({ title: o.label, detail: o.detail, source: "policy", optOut: o, priority: "sale" });
  }
  if (p.ads > 0 || p.sale > 0) {
    steps.push({
      title: "Turn on Global Privacy Control in your browser",
      detail: "Firefox, Brave and DuckDuckGo have it built in; Chrome and Safari need an extension. It sends an opt-out signal to every site you visit.",
      source: "general",
      priority: "sale",
    });
  }
  const weight = (s: NextStep) => (s.source === "policy" ? 10 : 0) + p[s.priority];
  return steps.sort((a, b) => weight(b) - weight(a));
}
