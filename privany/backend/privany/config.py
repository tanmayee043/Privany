import os
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
# Check https://ai.google.dev/gemini-api/docs/models for the current model list
# and override with GEMINI_MODEL if this one gets retired.
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash")

# No key, or PRIVANY_LLM=rules -> keyword fallback analyzer (clearly labeled in results)
LLM_MODE = os.environ.get("PRIVANY_LLM", "gemini" if GEMINI_API_KEY else "rules")

DB_PATH = Path(os.environ.get("PRIVANY_DB", Path(__file__).parent.parent / "privany.db"))

# Demo site runs on localhost. Never turn this on for a deployed server:
# it lets the fetcher reach private addresses.
ALLOW_LOCAL = os.environ.get("PRIVANY_ALLOW_LOCAL", "0") == "1"

MAX_DOC_BYTES = 3 * 1024 * 1024
# render JavaScript-built policy pages in Chromium when a plain fetch comes back nearly empty
RENDER_FALLBACK = os.environ.get("PRIVANY_RENDER", "1") == "1"
FETCH_TIMEOUT = 15.0
MAX_REDIRECTS = 5
MAX_POLICY_CHARS = 150_000          # what we send to the LLM per document
ANALYSIS_TTL_DAYS = 7
GPC_AUDIT_TTL_HOURS = 24

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/150.0 Safari/537.36 Privany/0.1 (+privacy policy reader)"
)
