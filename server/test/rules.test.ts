import { describe, expect, it } from "vitest";
import { policyFromText, looksLikePolicy, tryPolicyFromBlocks } from "../src/policy/extract.js";
import { readPolicyWithRules } from "../src/policy/rules.js";
import type { ClaimKey } from "../src/report/types.js";

const filler = "This section explains how we handle personal information about visitors to our websites and apps. ".repeat(4);

function read(text: string) {
  const r = readPolicyWithRules(policyFromText(`${text}\n\n${filler}`), { pasted: true });
  const claim = (k: ClaimKey) => r.claims.find((c) => c.key === k)!;
  return { r, claim };
}

describe("rule-based policy reader", () => {
  it("reads an explicit GPC commitment and keeps the legal qualifier", () => {
    const { claim } = read("We respond to the Global Privacy Control (GPC) signal to the extent required under applicable State Privacy Laws to effectuate your opt-out.");
    expect(claim("honors_gpc").value).toBe("yes");
    expect(claim("honors_gpc").summary).toContain("to the extent required");
    expect(claim("honors_gpc").quotes[0].text).toMatch(/^We respond to the Global Privacy Control/);
  });

  it("lets a negation win over an affirmation", () => {
    const { claim } = read("We do not currently respond to Do Not Track signals from browsers.\n\nWe do not sell your personal information to anyone.");
    expect(claim("respects_dnt").value).toBe("no");
    expect(claim("sells_personal_info").value).toBe("no");
  });

  it("doesn't count a corporate asset sale as selling your data", () => {
    const { claim, r } = read("If we are involved in a merger or sale of company assets, your information may be transferred as part of that business transaction.");
    expect(claim("sells_personal_info").value).toBe("unspecified");
    expect(r.topics.find((t) => t.key === "data_sale")!.status).toBe("not_found");
  });

  it("stays unspecified when a topic is mentioned without a commitment", () => {
    const { claim } = read("Learn more about Global Privacy Control at the GPC website.");
    expect(claim("honors_gpc").value).toBe("unspecified");
    expect(claim("honors_gpc").quotes).toHaveLength(1);
  });

  it("reports conflicting statements instead of picking one", () => {
    const { claim } = read("We do not sell personal information.\n\nNOTICE: We may sell your sensitive personal data.");
    const sale = claim("sells_personal_info");
    expect(sale.value).toBe("unspecified");
    expect(sale.quotes).toHaveLength(2);
    expect(sale.summary).toMatch(/both directions/);
  });

  it("tells a specific retention period from a vague one", () => {
    expect(read("We retain account data for 24 months after your last login.").r.topics.find((t) => t.key === "retention")!.status).toBe("stated");
    expect(read("We retain personal information for as long as necessary to provide the services.").r.topics.find((t) => t.key === "retention")!.status).toBe("unclear");
  });

  it("finds opt-out routes the policy documents, with their quotes", () => {
    const { r } = read("To exercise your rights, email privacy@example.com or call 1-800-555-0100 to submit a privacy request.\n\nYou can manage cookies through the Cookie Settings link in the footer.");
    expect(r.optOuts.map((o) => o.kind)).toEqual(expect.arrayContaining(["email", "phone", "setting"]));
    expect(r.optOuts.every((o) => o.quotes.length === 1)).toBe(true);
  });

  it("verifies every quote it produces", () => {
    const { r } = read("We share data with advertising partners who use cookies for interest-based advertising. We do not sell personal information.");
    expect(r.evidence.verified).toBe(r.evidence.proposed);
    expect(r.model).toMatch(/no AI/);
  });
});

describe("page text from the extension", () => {
  it("tells a policy page from a homepage", () => {
    const policy = tryPolicyFromBlocks(
      Array.from({ length: 20 }, (_, i) => ({ kind: "text" as const, text: `Section ${i}: we collect personal information, use cookies, and disclose data to third parties; you may opt out of this processing.` })),
      { url: "https://example.com/privacy" },
    )!;
    expect(looksLikePolicy(policy)).toBe(true);
    const home = tryPolicyFromBlocks(
      Array.from({ length: 20 }, (_, i) => ({ kind: "text" as const, text: `Recipe ${i}: chop the onions, warm the pan and stir in the garlic until it is fragrant and golden.` })),
      { url: "https://example.com/" },
    )!;
    expect(looksLikePolicy(home)).toBe(false);
  });

  it("returns nothing for a nearly empty page", () => {
    expect(tryPolicyFromBlocks([{ kind: "text", text: "Loading…" }], {})).toBeUndefined();
  });

  describe("AI training claim", () => {
    it("reads training on user content as yes", () => {
      const { claim } = read("We may use your content and usage data to train and improve our machine learning models.");
      expect(claim("uses_data_for_ai_training").value).toBe("yes");
      expect(claim("uses_data_for_ai_training").quotes[0].text).toContain("train and improve our machine learning models");
    });

    it("reads an explicit negation as no", () => {
      const { claim } = read("We do not use your content to train our AI models.");
      expect(claim("uses_data_for_ai_training").value).toBe("no");
    });

    it("reads a passive negation as no", () => {
      const { claim } = read("Your personal data will never be used to train artificial intelligence systems.");
      expect(claim("uses_data_for_ai_training").value).toBe("no");
    });

    it("reports conflicting statements instead of picking one", () => {
      const { claim } = read(
        "We may train and improve our artificial intelligence and machine learning models and algorithms.\n\nWe use artificial intelligence tools, including large language models, but we do not collect, use, or sell Personal Information for the purpose of training large language models.",
      );
      expect(claim("uses_data_for_ai_training").value).toBe("unspecified");
      expect(claim("uses_data_for_ai_training").quotes).toHaveLength(2);
    });

    it("reads a negation with a comma-separated list of verbs", () => {
      const { claim } = read("We do not collect, use, or sell your content for the purpose of training large language models.");
      expect(claim("uses_data_for_ai_training").value).toBe("no");
    });

    it("leaves AI features without training unspecified", () => {
      const { claim } = read("Our assistant is an AI feature that can summarize pages for you when you ask it to.");
      expect(claim("uses_data_for_ai_training").value).toBe("unspecified");
    });

    it("is unspecified when AI isn't mentioned", () => {
      const { claim } = read("We collect your email address when you create an account.");
      expect(claim("uses_data_for_ai_training").value).toBe("unspecified");
      expect(claim("uses_data_for_ai_training").quotes).toHaveLength(0);
    });
  });
});

describe("notes for form fields", () => {
  const uses = (text: string) => read(text).r.fieldUses ?? [];

  it("says what a personal detail is used for, keeping 'may'", () => {
    const phone = uses("We may use your phone number to send you marketing text messages and we may share it with our marketing partners.").find((u) => u.field === "phone");
    expect(phone?.purposes).toEqual(expect.arrayContaining(["marketing", "sharing"]));
    expect(phone?.note).toBe("Their policy says your phone number may be used for marketing and shared with other companies.");
    expect(phone?.quote.text).toMatch(/^We may use your phone number/);
  });

  it("prefers the sentence that names a purpose over a 'we collect' list", () => {
    const bday = uses("We collect your name, email address and date of birth when you sign up.\n\nWe use your date of birth to send birthday offers and to personalize advertising.").find((u) => u.field === "birthday");
    expect(bday?.purposes).toEqual(expect.arrayContaining(["ads", "marketing"]));
    expect(bday?.quote.text).toMatch(/^We use your date of birth/);
  });

  it("claims no purpose when the sentence only lists the detail, or denies the use", () => {
    expect(uses("We collect your email address when you create an account.").find((u) => u.field === "email")?.purposes).toEqual([]);
    expect(uses("We do not sell or share your phone number with advertisers.").find((u) => u.field === "phone")?.purposes).toEqual([]);
  });
});
