import type { CookieCategory, TopicKey, TopicStatus, Verdict } from "./api";

export const VERDICT: Record<Verdict, { short: string; long: string }> = {
  possible_gap: { short: "Possible gap", long: "What we saw doesn't match what the policy says. Worth a closer look." },
  consistent: { short: "Matches", long: "What we saw is consistent with the policy." },
  not_stated: { short: "Not promised", long: "The policy makes no clear promise here; we show what we saw." },
  not_testable: { short: "Can't test", long: "This happens on the company's servers, out of a browser's view." },
  inconclusive: { short: "Couldn't test", long: "The visits needed for this check didn't complete." },
};

export const TOPIC_TITLE: Record<TopicKey, string> = {
  data_collected: "What it collects",
  advertising_tracking: "Advertising and tracking",
  third_party_sharing: "Who it shares with",
  data_sale: "Selling data",
  retention: "How long it keeps data",
  deletion_rights: "Deleting your data",
  ai_training: "AI and model training",
  user_rights: "Your other rights",
};

export const TOPIC_STATUS: Record<TopicStatus, string> = {
  stated: "Stated",
  unclear: "Vague",
  not_found: "Not found",
};

export const CATEGORY: Record<CookieCategory, string> = {
  advertising: "Advertising",
  analytics: "Analytics",
  functional: "Functional",
  necessary: "Necessary",
  unknown: "Unidentified",
};

export function siteName(host: string): string {
  return host.replace(/^www\./, "");
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** A link that opens the policy scrolled to the quoted sentence (URL text fragment). */
export function quoteLink(url: string | undefined, text: string): string | undefined {
  if (!url) return undefined;
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const enc = (s: string) => encodeURIComponent(s).replace(/-/g, "%2D");
  const fragment = words.length > 10 ? `${enc(words.slice(0, 5).join(" "))},${enc(words.slice(-4).join(" "))}` : enc(words.join(" "));
  return `${url.split("#")[0]}#:~:text=${fragment}`;
}
