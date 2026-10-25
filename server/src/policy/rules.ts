import type { ClaimKey, ClaimValue, OptOut, OptOutKind, PolicyAnalysis, PolicyBlock, PolicyClaim, PolicyTopic, Quote, TopicKey, TopicStatus } from "../report/types.js";
import type { ExtractedPolicy } from "./extract.js";
import { findInjectionAttempts, verifyQuotes } from "./verify.js";

// A free, offline policy reader. It never paraphrases inside a quote: every
// quote is a sentence copied from the policy, and an answer is "yes" or "no"
// only when a sentence states it in recognizable words. Anything less explicit
// stays "unspecified", which the report shows as "not promised" rather than a
// guess. It misses unusual phrasing; that is the trade for costing nothing and
// never inventing a claim.

export const RULES_MODEL = "Privany rules v1 (no AI)";

interface Sentence {
  block: PolicyBlock;
  text: string;
}

const MAX_QUOTE = 320;

function sentences(blocks: PolicyBlock[]): Sentence[] {
  const out: Sentence[] = [];
  for (const block of blocks) {
    if (block.kind !== "text") continue;
    // Split after ., ! or ? followed by a space and a capital/quote/digit; keeps
    // abbreviations like "e.g. the" together.
    const parts = block.text.split(/(?<=[.!?;])\s+(?=[A-Z0-9“"(])/);
    for (const p of parts) {
      const t = p.trim();
      if (t.length >= 25) out.push({ block, text: t.length > MAX_QUOTE ? clip(t) : t });
    }
  }
  return out;
}

/** Shortens a long sentence at a word boundary; a prefix is still an exact quote. */
function clip(t: string): string {
  const cut = t.slice(0, MAX_QUOTE);
  return cut.slice(0, cut.lastIndexOf(" "));
}

const quote = (s: Sentence): Quote => ({ blockId: s.block.id, text: s.text, section: s.block.section });

const NEG = String.raw`(?:do(?:es)?\s+not|don['’]t|doesn['’]t|will\s+not|won['’]t|never|not\s+currently|cannot|can['’]t|are\s+not\s+able\s+to|is\s+not\s+able\s+to|unable\s+to|have\s+not|has\s+not|haven['’]t|hasn['’]t)`;
const neg = (verb: string) => new RegExp(String.raw`\b${NEG}\s+(?:\w+\s+){0,3}?${verb}`, "i");

interface ClaimRule {
  topic: RegExp;
  yes: RegExp;
  no: RegExp;
  summary: Record<ClaimValue, string>;
}

const CLAIM_RULES: Record<ClaimKey, ClaimRule> = {
  honors_gpc: {
    topic: /global privacy control|\bGPC\b|opt[- ]?out preference signal|universal opt[- ]?out|browser[- ](?:based )?(?:privacy |opt[- ]?out )?signal|privacy signals?/i,
    yes: /\b(honou?r|recogni[sz]e|respect|treat|process|accept|respond to|comply with|apply)\w*\b/i,
    no: neg(String.raw`(?:honou?r|recogni[sz]e|respect|respond|process|support)`),
    summary: {
      yes: "The policy says it treats Global Privacy Control or similar browser signals as an opt-out request.",
      no: "The policy says it does not respond to Global Privacy Control or similar browser signals.",
      unspecified: "The policy doesn't clearly say whether it honors Global Privacy Control.",
    },
  },
  respects_dnt: {
    topic: /do[- ]not[- ]track|\bDNT\b/i,
    yes: /\b(honou?r|recogni[sz]e|respect|respond to|comply with)\w*\b/i,
    no: new RegExp(String.raw`${neg(String.raw`(?:honou?r|recogni[sz]e|respect|respond|support|alter|change)`).source}|no (?:uniform|industry|common) standard`, "i"),
    summary: {
      yes: "The policy says it responds to Do Not Track signals.",
      no: "The policy says it does not respond to Do Not Track signals.",
      unspecified: "The policy doesn't mention Do Not Track.",
    },
  },
  sells_personal_info: {
    topic: /\bsell(?:s|ing)?\b|\bsale\b|\bsold\b/i,
    yes: /\bwe (?:may |also )?(?:sell|have sold)\b|\b(?:has|have) sold\b|\bsold\b[^.]{0,80}\b(?:past|preceding|last) (?:12|twelve) months|\bmay be considered (?:a )?["“]?sale/i,
    no: neg(String.raw`(?:sell|sold|rent)`),
    summary: {
      yes: "The policy says some personal information is sold, or may count as a \"sale\" under state law.",
      no: "The policy says it does not sell personal information.",
      unspecified: "The policy doesn't clearly say whether it sells personal information.",
    },
  },
  shares_for_targeted_ads: {
    topic: /(?:targeted|interest[- ]based|personali[sz]ed|cross[- ]context(?:ual)? behavio(?:u)?ral|behavio(?:u)?ral|tailored) (?:advertis|ads?\b)/i,
    yes: /\b(share|disclose|provide|allow|permit|enable|work with|partner|use|serve|deliver|show)\w*\b/i,
    no: neg(String.raw`(?:share|disclose|use|serve|allow|engage)`),
    summary: {
      yes: "The policy says data is used or shared for targeted (interest-based) advertising.",
      no: "The policy says it does not share data for targeted advertising.",
      unspecified: "The policy doesn't clearly address targeted advertising.",
    },
  },
  uses_third_party_trackers: {
    topic: /third[- ]part(?:y|ies)|(?:advertising|analytics|marketing) (?:partners|providers|networks|companies)|\bpartners\b/i,
    yes: /\b(cookies?|pixels?|web beacons?|tags?|SDKs?|tracking technolog\w*|similar technolog\w*)\b/i,
    no: new RegExp(String.raw`${neg(String.raw`(?:allow|permit|use)`).source}[^.]{0,60}third[- ]part|only (?:use )?first[- ]party cookies`, "i"),
    summary: {
      yes: "The policy says third parties such as ad networks or analytics providers may use cookies or similar trackers on the site.",
      no: "The policy says third parties don't track visitors on the site.",
      unspecified: "The policy doesn't clearly say whether third parties track on the site.",
    },
  },
  uses_data_for_ai_training: {
    topic: /artificial intelligence|\bAI\b|machine[- ]learning|large language model|\bLLMs?\b|\balgorithms?\b|\bgenerative\b|\b(?:our|the|its|their|these|such)\s+(?:\w+\s+)?models?\b/i,
    // Only sentences that talk about training count (see decideClaim), so this just says "training happens".
    yes: /\b(?:train\w*|fine-?tun\w*|improv\w*|develop\w*)\b/i,
    // Sentences here are already about AI and training, so a negation anywhere before the training verb counts ("do not collect, use, or sell ... for the purpose of training").
    no: new RegExp(String.raw`${NEG}[^.]{0,100}\b(?:train\w*|fine-?tun\w*)\b|\bnot\s+(?:be\s+)?used\s+(?:\w+\s+){0,4}?(?:to|for)\s+(?:train|improv|develop)|\bnever\s+(?:be\s+)?used\s+(?:\w+\s+){0,4}?(?:to|for)\s+(?:train|improv|develop)`, "i"),
    summary: {
      yes: "The policy says your data or content may be used to train or improve AI or machine-learning models.",
      no: "The policy says your data or content is not used to train AI or machine-learning models.",
      unspecified: "The policy doesn't clearly say whether your data is used to train AI.",
    },
  },
  tracking_requires_consent: {
    topic: /\bconsent\b/i,
    yes: /(?:with|obtain|ask for|request|seek|only (?:with|after)|upon|based on) (?:your )?(?:prior |explicit )?consent[^.]{0,80}(?:cookie|tracking|non[- ]essential|analytic|advertis)|(?:cookie|tracking|non[- ]essential|analytic|advertis)[^.]{0,80}(?:with|obtain|ask for|request|seek|only (?:with|after)|upon) (?:your )?(?:prior |explicit )?consent/i,
    no: /\bby default\b|\bunless you (?:opt[- ]?out|disable|change)/i,
    summary: {
      yes: "The policy says non-essential cookies or tracking need your consent first (check for limits such as \"where required by law\").",
      no: "The policy says tracking is on by default unless you opt out.",
      unspecified: "The policy doesn't say tracking waits for your consent.",
    },
  },
};

// A sentence counts toward the cookie/consent claim only if it is about cookies or tracking.
const CONSENT_CONTEXT = /cookie|tracking|track|non[- ]essential|pixel|analytic|advertis/i;

const AI_TRAINING_CONTEXT = /\b(?:train\w*|fine-?tun\w*|improv\w*|develop\w*)\b[^.]{0,80}\b(?:models?|AI|artificial intelligence|machine[- ]learning|algorithms?|LLMs?)\b|\b(?:models?|AI|machine[- ]learning|algorithms?|LLMs?)\b[^.]{0,60}\b(?:train\w*|fine-?tun\w*)\b/i;

// "Sale" in the sense of a merger or asset sale isn't selling your data.
const CORPORATE_SALE = /sale of (?:(?:all|some|part|substantially all) of )?(?:our |the )?(?:company|business|assets|stock)|merger|acquisition|bankruptcy|business transaction|reorgani[sz]ation/i;

function decideClaim(key: ClaimKey, all: Sentence[]): PolicyClaim {
  const rule = CLAIM_RULES[key];
  let relevant = all.filter((s) => rule.topic.test(s.text));
  if (key === "sells_personal_info") relevant = relevant.filter((s) => !CORPORATE_SALE.test(s.text));
  if (key === "tracking_requires_consent") relevant = relevant.filter((s) => CONSENT_CONTEXT.test(s.text));
  // AI features alone aren't a training claim; the sentence has to talk about training or improving models.
  if (key === "uses_data_for_ai_training") relevant = relevant.filter((s) => AI_TRAINING_CONTEXT.test(s.text));
  if (key === "uses_third_party_trackers") relevant = relevant.filter((s) => rule.yes.test(s.text) || rule.no.test(s.text));
  // Negations win over affirmations in the same sentence ("we do not sell…").
  const noHits = relevant.filter((s) => rule.no.test(s.text));
  const yesHits = relevant.filter((s) => !rule.no.test(s.text) && rule.yes.test(s.text));
  let value: ClaimValue = "unspecified";
  let quotes: Quote[] = [];
  let summary = rule.summary.unspecified;
  if (noHits.length && yesHits.length && (key === "honors_gpc" || key === "sells_personal_info" || key === "shares_for_targeted_ads" || key === "uses_data_for_ai_training")) {
    // Conflicting statements: report both rather than pick one.
    quotes = [quote(noHits[0]), quote(yesHits[0])];
    summary = `${rule.summary.unspecified} It contains statements in both directions; read both quotes.`;
  } else if (noHits.length) {
    value = "no";
    quotes = noHits.slice(0, 2).map(quote);
    summary = rule.summary.no;
  } else if (yesHits.length) {
    value = "yes";
    quotes = yesHits.slice(0, 2).map(quote);
    summary = rule.summary.yes;
  } else if (relevant.length) {
    quotes = [quote(relevant[0])];
    summary = `${rule.summary.unspecified} It mentions the topic without a clear commitment.`;
  }
  return { key, value, summary: qualify(summary, quotes), quotes, unsupported: false };
}

/** Carries over limits that change the meaning, like "California residents" or "where required by law". */
function qualify(summary: string, quotes: Quote[]): string {
  const text = quotes.map((q) => q.text).join(" ");
  const notes: string[] = [];
  const state = text.match(/\b(California|Colorado|Connecticut|Virginia|Texas|Oregon|EU|EEA|European|UK)\b[^.]{0,30}\b(residents?|users?|consumers?)/i);
  if (state) notes.push(`it applies to ${state[0].replace(/\s+/g, " ")}`);
  const legal = text.match(/where required by (?:applicable )?law|to the extent required(?: by| under)?(?: the| applicable)?(?: [A-Z][\w ]{0,30}?Laws?)?/i);
  if (legal) notes.push(`only "${legal[0]}"`);
  if (/\bmay\b/i.test(text) && !/may not/i.test(text)) notes.push(`the wording is "may"`);
  return notes.length ? `${summary} Note: ${notes.join("; ")}.` : summary;
}

interface TopicRule {
  find: RegExp;
  stated?: RegExp;
  vague?: RegExp;
  summary: Record<TopicStatus, string>;
}

const TOPIC_RULES: Record<TopicKey, TopicRule> = {
  data_collected: {
    find: /\bwe (?:may |also |automatically )?(?:collect|receive|obtain|gather)\b|information (?:we|that we) collect/i,
    summary: { stated: "The policy lists the kinds of information it collects; see the quotes.", unclear: "The policy mentions collecting information without listing what.", not_found: "We couldn't find where the policy describes what it collects." },
  },
  advertising_tracking: {
    find: /\b(cookies?|pixels?|web beacons?|tracking technolog\w*|device identifiers?|advertising ID)\b/i,
    summary: { stated: "The policy describes cookies or similar tracking technologies.", unclear: "", not_found: "The policy doesn't describe cookies or tracking technologies." },
  },
  third_party_sharing: {
    find: /\b(?:share|disclose|provide|transfer)\w*\b[^.]{0,80}\b(?:with|to)\b[^.]{0,40}\b(?:third[- ]part|partners|affiliates|service providers|vendors|advertisers)/i,
    summary: { stated: "The policy names kinds of companies it shares information with.", unclear: "", not_found: "We couldn't find a description of who the site shares data with." },
  },
  data_sale: {
    find: /\bsell(?:s|ing)?\b|\bsale\b|\bsold\b/i,
    summary: { stated: "The policy addresses selling personal information.", unclear: "", not_found: "The policy doesn't mention selling personal information." },
  },
  retention: {
    find: /\bretain|\bretention\b|\bkeep (?:your |the |this )?(?:personal )?(?:information|data)|\bstore (?:your )?(?:personal )?(?:information|data) for/i,
    stated: /\b\d+\s*(?:days?|weeks?|months?|years?)\b|\b(?:one|two|three|five|seven|ten|thirty|ninety)\s+(?:days?|months?|years?)\b/i,
    vague: /as long as (?:is )?(?:necessary|needed|required|reasonably)|(?:reasonably )?necessary to (?:fulfil|fulfill|provide|achieve)|for (?:the )?(?:period|time) necessary|no longer than (?:is )?necessary/i,
    summary: { stated: "The policy gives specific retention periods for at least some data.", unclear: "The policy says data is kept \"as long as necessary\" without a specific period.", not_found: "We couldn't find how long data is kept." },
  },
  deletion_rights: {
    find: /\bdelet\w*|\beras\w*/i,
    stated: /\b(request|right|ask|contact|submit|email|form|account settings)\b/i,
    summary: { stated: "The policy describes a way to request deletion of your data.", unclear: "The policy mentions deletion without a clear way to request it.", not_found: "We couldn't find a way to request deletion." },
  },
  ai_training: {
    find: /artificial intelligence|\bAI\b|machine[- ]learning|large language model|\bLLMs?\b|train(?:ing)? (?:our |its |the |their )?(?:models?|algorithms|AI)|(?:improve|develop) (?:our )?(?:models|algorithms)/,
    summary: { stated: "The policy mentions AI or machine learning; read the quotes for how your data is involved.", unclear: "", not_found: "The policy doesn't mention AI or model training." },
  },
  user_rights: {
    find: /\bright to (?:know|access|correct|rectif|portab|appeal|opt[- ]?out|limit|object|restrict)|\b(?:access|correct|port) (?:your )?(?:personal )?(?:information|data)\b/i,
    summary: { stated: "The policy lists privacy rights such as access or correction; check which places they apply to.", unclear: "", not_found: "We couldn't find a list of your privacy rights." },
  },
};

function decideTopic(key: TopicKey, all: Sentence[]): PolicyTopic {
  const rule = TOPIC_RULES[key];
  const hits = all.filter((s) => rule.find.test(s.text) && !(key === "data_sale" && CORPORATE_SALE.test(s.text)));
  if (!hits.length) return { key, status: "not_found", summary: rule.summary.not_found, quotes: [], unsupported: false };
  let status: TopicStatus = "stated";
  let best = hits;
  if (rule.stated) {
    const strong = hits.filter((s) => rule.stated!.test(s.text));
    if (strong.length) best = strong;
    else status = "unclear";
  }
  if (rule.vague && status === "unclear") {
    const vague = hits.filter((s) => rule.vague!.test(s.text));
    if (vague.length) best = vague;
  }
  return { key, status, summary: rule.summary[status], quotes: best.slice(0, 2).map(quote), unsupported: false };
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE = /(?:\+?1[-. ]?)?\(?\b8\d\d\)?[-. ]\d{3}[-. ]\d{4}\b|\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/;
const PRIVACY_ACTION = /privacy|opt[- ]?out|delet|request|rights|sell|share|access/i;

function findOptOuts(all: Sentence[]): OptOut[] {
  const out: OptOut[] = [];
  const add = (kind: OptOutKind, label: string, detail: string, s: Sentence) => {
    if (out.some((o) => o.label === label)) return;
    out.push({ kind, label, detail, quotes: [quote(s)] });
  };
  for (const s of all) {
    const t = s.text;
    // Opt-outs run by a named ad partner aren't the site's own control.
    const partnerOnly = /\b(?:Nielsen|Google|Facebook|Meta|Adobe|ID5|LiveRamp)\b/.test(t);
    if (/do not sell(?: or share)?(?: my)?|your privacy choices|opt[- ]?out of (?:the )?sale/i.test(t) && /link|click|visit|page|form|button|toggle/i.test(t) && !partnerOnly) {
      add("link", /your privacy choices/i.test(t) ? "\"Your Privacy Choices\" link" : "\"Do Not Sell or Share\" link", "The policy points to a link or page for opting out of the sale or sharing of your data.", s);
    }
    if (/cookie (?:settings|preferences|banner|consent tool|preference cent(?:er|re)|choices)|manage (?:your )?cookies/i.test(t)) {
      add("setting", "Cookie settings", "The policy says you can change cookie choices through the site's cookie settings or preference center.", s);
    }
    if (/global privacy control|opt[- ]?out preference signal/i.test(t) && /(honou?r|recogni[sz]e|treat|process|respond to)/i.test(t) && !neg("(?:honou?r|recogni[sz]e|process)").test(t)) {
      add("browser_signal", "Global Privacy Control", "Turning on GPC in your browser sends an opt-out request this policy says it recognizes.", s);
    }
    if (/\b(?:browser|device) settings\b/i.test(t) && /cookie/i.test(t)) {
      add("setting", "Browser cookie controls", "The policy says you can block or delete cookies in your browser settings.", s);
    }
    const email = t.match(EMAIL)?.[0];
    if (email && PRIVACY_ACTION.test(t)) add("email", `Email ${email}`, "The policy gives this address for privacy requests.", s);
    const phone = t.match(PHONE)?.[0];
    if (phone && PRIVACY_ACTION.test(t)) add("phone", `Call ${phone}`, "The policy gives this number for privacy requests.", s);
    if (/\b(?:web )?form\b/i.test(t) && /(?:delet|access|request|rights|your data)/i.test(t) && /(submit|complete|fill|use|click)/i.test(t) && !/marketing|e-?mails?\b|newsletter/i.test(t)) {
      add("form", "Privacy request form", "The policy points to a form for privacy requests such as access or deletion.", s);
    }
    if (out.length >= 8) break;
  }
  return out;
}

export function readPolicyWithRules(policy: ExtractedPolicy, opts: { pasted: boolean }): PolicyAnalysis {
  const all = sentences(policy.blocks);
  const index = new Map(policy.blocks.map((b) => [b.id, b]));
  let proposed = 0;
  let verified = 0;
  // The quotes are copied from the policy, but they still go through the same
  // check as model output so the evidence count means one thing everywhere.
  const check = (qs: Quote[]) => {
    const r = verifyQuotes(qs.map((q) => ({ block_id: q.blockId, text: q.text })), policy.blocks, index);
    proposed += qs.length;
    verified += r.quotes.length;
    return r.quotes;
  };
  const claims = (Object.keys(CLAIM_RULES) as ClaimKey[]).map((k) => {
    const c = decideClaim(k, all);
    return { ...c, quotes: check(c.quotes) };
  });
  const topics = (Object.keys(TOPIC_RULES) as TopicKey[]).map((k) => {
    const t = decideTopic(k, all);
    return { ...t, quotes: check(t.quotes) };
  });
  const optOuts = findOptOuts(all).map((o) => ({ ...o, quotes: check(o.quotes) }));
  const policyWords = all.filter((s) => /personal (?:information|data)|privacy|cookies?/i.test(s.text)).length;
  return {
    source: { url: policy.url, pasted: opts.pasted, retrievedAt: policy.retrievedAt, title: policy.title, sha256: policy.sha256, chars: policy.chars, truncated: policy.truncated },
    blocks: policy.blocks,
    isPrivacyPolicy: policyWords >= 5,
    claims,
    topics,
    optOuts,
    evidence: { proposed, verified },
    injectionWarnings: findInjectionAttempts(policy.blocks),
    model: RULES_MODEL,
  };
}
