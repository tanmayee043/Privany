import { describe, expect, it } from "vitest";
import { policyFromText } from "../src/policy/extract.js";
import { ownPolicyScore, rankPolicyLinks, scorePolicyHref } from "../src/policy/links.js";

describe("choosing the site's own policy link", () => {
  it("puts a site's own policy ahead of product and template pages (Termly's footer)", () => {
    const ranked = rankPolicyLinks([
      "https://termly.io/products/privacy-policy-generator/",
      "https://termly.io/resources/templates/privacy-policy-template/",
      "https://termly.io/privacy-center/",
      "https://termly.io/our-privacy-policy/",
    ]);
    expect(ranked[0]).toBe("https://termly.io/our-privacy-policy/");
  });

  it("scores ordinary policy paths highly and article pages low", () => {
    expect(scorePolicyHref("https://example.com/privacy")).toBeGreaterThan(5);
    expect(scorePolicyHref("https://example.com/legal/privacy-policy")).toBeGreaterThan(5);
    expect(scorePolicyHref("https://example.com/blog/what-is-a-privacy-policy")).toBeLessThan(0);
    expect(scorePolicyHref("not a url")).toBeLessThan(0);
  });

  it("keeps the page's order for links that score the same", () => {
    expect(rankPolicyLinks(["https://a.com/privacy", "https://a.com/privacy-policy"])).toEqual(["https://a.com/privacy", "https://a.com/privacy-policy"]);
  });
});

describe("checking a page is the site's own policy", () => {
  // Pages under 400 characters are rejected as "probably not a policy", so both samples get neutral padding.
  const pad = "This page was last updated in October 2026 and applies to our websites and apps in every region we serve. ".repeat(3);
  const own = policyFromText(
    [
      "Privacy Policy",
      "We collect your personal information when you create an account. We use your personal information to provide the service.",
      "We share your personal data with service providers. We may disclose your information when required by law.",
      "You can ask us to delete your personal information at any time by contacting privacy@example.com.",
      pad,
    ].join("\n\n"),
  );
  const product = policyFromText(
    [
      "Free Privacy Policy Generator",
      "Create a privacy policy for your website in minutes. Our privacy policy generator asks a few questions about your business and builds a policy that covers the laws that apply to you.",
      "Thousands of businesses trust our templates. Most websites that collect email addresses or payment details need a privacy policy, and many app stores require one.",
      pad,
    ].join("\n\n"),
  );

  it("accepts a policy that talks about 'we' and 'your data'", () => {
    expect(ownPolicyScore(own).own).toBe(true);
  });

  it("rejects a product page about privacy policies", () => {
    const r = ownPolicyScore(product);
    expect(r.own).toBe(false);
    expect(r.score).toBeLessThan(ownPolicyScore(own).score);
  });
});
