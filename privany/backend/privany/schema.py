"""
What the analyzer has to fill in. The eight `CLAIMS` are PrivAudit's
"semantic behavior claims" (policy_analysis/prompts/ccpa_rubric_prompt.txt),
kept word for word so live results line up with the paper's join rules.
"""

CLAIMS = [
    "honors_gpc",
    "respects_dnt",
    "sets_cookies_before_consent",
    "sets_cookies_after_rejecting_consent",
    "deletes_cookies_on_rejection",
    "uses_tracking_only_after_consent",
    "sells_data",
    "shares_with_third_parties",
]

CLAIM_LABELS = {
    "honors_gpc": "Honors Global Privacy Control",
    "respects_dnt": "Respects Do Not Track",
    "sets_cookies_before_consent": "Sets cookies before you consent",
    "sets_cookies_after_rejecting_consent": "Sets cookies after you reject",
    "deletes_cookies_on_rejection": "Deletes cookies when you reject",
    "uses_tracking_only_after_consent": "Tracks only after you consent",
    "sells_data": "Sells your personal data",
    "shares_with_third_parties": "Shares data with third parties",
}

FINDING_CATEGORIES = [
    # privacy policy side
    "data_selling", "third_party_sharing", "advertising_tracking", "data_retention",
    "deletion_rights", "access_rights", "location_data", "sensitive_data", "children",
    "international_transfer",
    # terms side
    "ai_training", "content_license", "arbitration", "class_action_waiver",
    "auto_renewal", "cancellation_refunds", "liability_limits", "account_termination",
    "policy_changes",
]

CATEGORY_LABELS = {
    "data_selling": "Selling your data",
    "third_party_sharing": "Sharing with others",
    "advertising_tracking": "Ad tracking",
    "data_retention": "How long they keep it",
    "deletion_rights": "Deleting your data",
    "access_rights": "Seeing your data",
    "location_data": "Location data",
    "sensitive_data": "Sensitive data",
    "children": "Kids' data",
    "international_transfer": "Sent abroad",
    "ai_training": "AI training on your stuff",
    "content_license": "Rights to your content",
    "arbitration": "Forced arbitration",
    "class_action_waiver": "No class actions",
    "auto_renewal": "Auto-renewal",
    "cancellation_refunds": "Cancelling & refunds",
    "liability_limits": "Liability limits",
    "account_termination": "Account termination",
    "policy_changes": "Changing the terms",
}

FIELDS = ["phone", "email", "birthday", "address", "location", "gender", "name",
          "payment", "government_id", "photo", "contacts"]

# Gemini responseSchema (OpenAPI 3.0 subset)
_quote = {
    "quote": {"type": "STRING", "description": "Exact sentence copied from the document, including words like may/unless/except. Empty string if none."},
    "doc": {"type": "INTEGER", "description": "Document number the quote comes from."},
    "para": {"type": "INTEGER", "description": "Paragraph number the quote comes from."},
}

RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "summary": {"type": "STRING", "description": "One or two plain sentences on what matters most. No legal advice."},
        "claims": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "claim": {"type": "STRING", "enum": CLAIMS},
                    "value": {"type": "STRING", "enum": ["true", "false", "unspecified"]},
                    **_quote,
                    "note": {"type": "STRING", "description": "One short sentence explaining the call."},
                },
                "required": ["claim", "value", "quote", "doc", "para", "note"],
            },
        },
        "findings": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "category": {"type": "STRING", "enum": FINDING_CATEGORIES},
                    "stance": {"type": "STRING", "enum": ["permits", "prohibits", "provides_right", "unclear"]},
                    "statement": {"type": "STRING", "description": "What the document says, in plain words, one sentence. Say 'may' if the text says may."},
                    **_quote,
                },
                "required": ["category", "stance", "statement", "quote", "doc", "para"],
            },
        },
        "field_uses": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "field": {"type": "STRING", "enum": FIELDS},
                    "use": {"type": "STRING", "description": "What the policy says this data is used for, plain words, under 20 words."},
                    "shared_for_ads": {"type": "STRING", "enum": ["true", "false", "unspecified"]},
                    **_quote,
                },
                "required": ["field", "use", "shared_for_ads", "quote", "doc", "para"],
            },
        },
        "opt_outs": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "label": {"type": "STRING", "description": "Short name, e.g. 'Opt out of targeted ads'."},
                    "how": {"type": "STRING", "description": "How to do it, only as the document describes."},
                    "url": {"type": "STRING", "description": "Link or email exactly as written in the document, or empty."},
                    **_quote,
                },
                "required": ["label", "how", "url", "quote", "doc", "para"],
            },
        },
    },
    "required": ["summary", "claims", "findings", "field_uses", "opt_outs"],
}
