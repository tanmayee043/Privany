import type { ClaimKey, TopicKey } from "../report/types.js";

// The behavioral claims follow PrivAudit's CCPA rubric
// (policy_analysis/prompts/ccpa_rubric_prompt.txt): each is something the policy
// can promise and the browser audit can test. Definitions are spelled out so
// "yes" always means the same thing across sites.
export const CLAIMS: Record<ClaimKey, { title: string; definition: string }> = {
  honors_gpc: {
    title: "Honors Global Privacy Control",
    definition: "yes = the policy says it honors/recognizes Global Privacy Control (GPC) or browser-based opt-out preference signals as a request to opt out. no = it says it does not. unspecified = GPC/opt-out preference signals are not mentioned.",
  },
  sells_personal_info: {
    title: "Sells personal information",
    definition: "yes = the policy says it sells personal information (including 'sale' as defined by CCPA/state law). no = it states it does not sell personal information. unspecified = it doesn't say.",
  },
  shares_for_targeted_ads: {
    title: "Shares data for targeted advertising",
    definition: "yes = the policy says it shares personal information for cross-context behavioral / targeted / interest-based advertising, or lets ad partners collect data on its site for that purpose. no = it states it does not. unspecified = it doesn't say.",
  },
  uses_third_party_trackers: {
    title: "Lets third parties track on the site",
    definition: "yes = the policy says third parties (ad networks, analytics providers, social media) may place cookies, pixels, SDKs or similar trackers on its site. no = it states only first-party cookies are used or no third-party tracking occurs. unspecified = it doesn't say.",
  },
  tracking_requires_consent: {
    title: "Waits for consent before tracking",
    definition: "yes = the policy says non-essential (analytics/advertising) cookies or trackers are used only after the user consents, for all users or for the user's region as stated. no = it says such cookies are used by default / unless the user opts out. unspecified = it doesn't say.",
  },
  respects_dnt: {
    title: "Respects Do Not Track",
    definition: "yes = the policy says it responds to browser Do Not Track (DNT) signals. no = it says it does not respond to DNT. unspecified = DNT is not mentioned.",
  },
};

export const TOPICS: Record<TopicKey, { title: string; definition: string }> = {
  data_collected: { title: "What it collects", definition: "Categories of personal information collected, especially sensitive ones (precise location, health, biometrics, financial, children's data)." },
  advertising_tracking: { title: "Advertising and tracking", definition: "Use of cookies, pixels, device identifiers and cross-site tracking for analytics or advertising." },
  third_party_sharing: { title: "Who it shares with", definition: "Which kinds of companies receive personal information (service providers, advertisers, data brokers, affiliates, government) and for what." },
  data_sale: { title: "Selling data", definition: "Whether personal information is sold or 'shared' as defined by state privacy laws, and to whom." },
  retention: { title: "How long it keeps data", definition: "Stated retention periods or criteria. 'As long as necessary' without a period is unclear." },
  deletion_rights: { title: "Deleting your data", definition: "Whether and how users can request deletion, and any stated limits." },
  ai_training: { title: "AI and model training", definition: "Whether user data or content is used to train or improve AI / machine-learning models, and whether users can opt out." },
  user_rights: { title: "Your other rights", definition: "Access, correction, portability, opt-out of profiling, appeal, and which jurisdictions these apply to." },
};
