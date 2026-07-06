"""
Enrichment: turn a raw profile blob into typed attributes.

Design (see SPEC.md sections 6 & 9):
  1. Field-first  — parse age/height with regex; map structured badges deterministically.
  2. LLM-second   — extract the free-text axes (diet/drink/smoke/community/...) via Claude
                    structured output, forcing 'unknown' rather than guessing.
  3. Cache        — the (expensive) LLM result is cached by a hash of the bio text, so a
                    re-render of the same profile never re-bills the API.

COMMUNITY RULE: populate community_selfdeclared only when the profile explicitly self-identifies a
community/background in supplied text. Never infer sensitive traits or community membership from a
name, surname, photo, location, language, or other proxy. Return unknown when it is not explicitly
stated.
"""
import os
import re
import json
import hashlib
import sqlite3
from typing import Literal, Optional

from pydantic import BaseModel
import anthropic

# Cheap, fast model for high-volume bio extraction. Bump to "claude-opus-4-8" for max accuracy:
#   PF_MODEL=claude-opus-4-8 uvicorn app:app --port 8787
MODEL = os.getenv("PF_MODEL", "claude-haiku-4-5")
# Bump this whenever _SYSTEM or the Attrs schema changes, so stale rows aren't reused.
_PROMPT_VERSION = "v1"

_client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY (or an `ant auth login` profile)
_DB = os.path.join(os.path.dirname(__file__), "cache.sqlite")


# ---------------------------------------------------------------- schema
class Attrs(BaseModel):
    diet: Literal["vegetarian", "vegan", "eggetarian", "non_veg", "unknown"]
    drinks: Literal["yes", "no", "sometimes", "unknown"]
    smokes: Literal["yes", "no", "sometimes", "unknown"]
    religion: str                       # free text, "unknown" if not stated
    religiosity: Literal["practicing", "cultural", "non_religious", "unknown"]
    community_selfdeclared: str         # ONLY if self-stated; else "unknown"
    languages: list[str]
    family_orientation: Literal["wants_kids", "unsure", "no_kids", "unknown"]
    interests: list[str]
    red_flags: list[str]
    notes: str                          # one-line rationale / anything notable


def _unknown() -> Attrs:
    return Attrs(
        diet="unknown", drinks="unknown", smokes="unknown", religion="unknown",
        religiosity="unknown", community_selfdeclared="unknown", languages=[],
        family_orientation="unknown", interests=[], red_flags=[], notes="",
    )


_SYSTEM = (
    "You extract self-declared lifestyle and community attributes from a dating profile's "
    "free text (bio and prompt answers). Extract ONLY what is explicitly stated. Strongly "
    "prefer 'unknown' over a guess — dating bios are sparse. "
    "For community_selfdeclared: populate it ONLY when the profile explicitly self-identifies a "
    "community or background in the supplied text. Never infer sensitive traits or community "
    "membership from a name, surname, photo, location, language, or other proxy. Return "
    "'unknown' when it is not explicitly stated. "
    "Put anything genuinely concerning (scammy, aggressive, contradictory) in red_flags."
)


# ---------------------------------------------------------------- field-first
def parse_height_cm(text: str) -> Optional[int]:
    m = re.search(r"(\d{3})\s*cm", text, re.I)
    if m:
        cm = int(m.group(1))
        if 120 <= cm <= 220:
            return cm
    # 5'4"  /  5’4  /  5ft4  /  5 ft 4 in  /  5 feet 4
    m = re.search(r"\b([4-6])\s*(?:['’]|ft|feet|foot)\s*(\d{1,2})", text, re.I)
    if m:
        cm = round(int(m.group(1)) * 30.48 + int(m.group(2)) * 2.54)
        if 120 <= cm <= 220:
            return cm
    return None


def parse_age(text: str) -> Optional[int]:
    """Fallback only — the collector parses age from the card heading and sends it directly.

    Anchored to the FIRST line (the name/age header) so a stray number in the bio can't be
    read as an age. Tinder renders "Priya 22" with no comma, which the old `, 22` regex missed.
    """
    first = text.strip().split("\n")[0] if text.strip() else ""
    m = re.search(r"(?:^|[\s,])(1[89]|[2-9]\d)\s*$", first)   # "Priya 22" / "Priya, 22"
    return int(m.group(1)) if m else None
    # Deliberately NOT scanning the whole bio for `, NN`: on bio-only text that matches prose
    # ("Been to Goa, 25 times", "Indiranagar, 25 minutes away") and yields a confident-looking
    # `✗ age=25` HIDE on a profile that may well be in range.


# Badge vocabularies are fixed (the person picked from a list), so a lookup table beats an
# LLM call. ORDER MATTERS: most-specific first. A naive `"vegetarian" in text` check matches
# "Non-vegetarian" too, which would pass a meat-eater through the vegetarian hard filter —
# the single worst failure this tool can have. Same trap with "smoker" inside "non-smoker".
_DIET_MAP = [
    ("non-vegetarian", "non_veg"), ("non vegetarian", "non_veg"), ("nonvegetarian", "non_veg"),
    ("non-veg", "non_veg"), ("non veg", "non_veg"),
    ("vegan", "vegan"),
    ("eggetarian", "eggetarian"), ("eggitarian", "eggetarian"),
    ("pescatarian", "non_veg"), ("carnivore", "non_veg"), ("omnivore", "non_veg"),
    ("vegetarian", "vegetarian"),
]
_SMOKE_MAP = [
    ("non-smoker", "no"), ("non smoker", "no"), ("nonsmoker", "no"),
    ("doesn't smoke", "no"), ("does not smoke", "no"), ("never smoke", "no"),
    ("trying to quit", "sometimes"),
    ("smokes socially", "sometimes"), ("social smoker", "sometimes"),
    ("smoker", "yes"), ("smokes", "yes"),
]
_DRINK_MAP = [
    ("non-drinker", "no"), ("non drinker", "no"), ("nondrinker", "no"),
    ("doesn't drink", "no"), ("does not drink", "no"), ("never drink", "no"),
    ("teetotal", "no"), ("sober", "no"),
    ("drinks socially", "sometimes"), ("social drinker", "sometimes"),
    ("on special occasions", "sometimes"), ("occasionally", "sometimes"),
    ("frequently drink", "yes"), ("drinker", "yes"), ("drinks", "yes"),
]


def _match_badge(badge: str, table: list[tuple[str, str]]) -> Optional[str]:
    """First (most-specific) entry whose needle appears in this ONE badge."""
    t = badge.lower().replace("’", "'").strip()
    for needle, value in table:
        if needle in t:
            return value
    return None


def badges_to_attrs(badges: list[str]) -> dict:
    """Map fixed-vocabulary profile badges (Bumble/Tinder/Hinge) — high confidence, no LLM.

    Each badge is matched independently; joining them into one blob lets one badge's text
    satisfy another's test (e.g. a "Vegetarian" badge next to a "Smoker" badge).
    """
    out: dict = {}
    for badge in badges:
        for field, table in (("diet", _DIET_MAP), ("smokes", _SMOKE_MAP), ("drinks", _DRINK_MAP)):
            if field in out:
                continue  # first badge to speak for a field wins
            v = _match_badge(badge, table)
            if v is not None:
                out[field] = v
    return out


# ---------------------------------------------------------------- cache
def _conn():
    # timeout: FastAPI runs the sync endpoint in a threadpool, so a burst of cards can hit
    # sqlite concurrently and raise "database is locked" -> uncaught 500.
    c = sqlite3.connect(_DB, timeout=5)
    c.execute("CREATE TABLE IF NOT EXISTS c (k TEXT PRIMARY KEY, v TEXT)")
    return c


def _cache_get(k: str) -> Optional[dict]:
    c = _conn()
    row = c.execute("SELECT v FROM c WHERE k=?", (k,)).fetchone()
    c.close()
    return json.loads(row[0]) if row else None


def _cache_put(k: str, v: dict) -> None:
    c = _conn()
    c.execute("INSERT OR REPLACE INTO c (k, v) VALUES (?, ?)", (k, json.dumps(v)))
    c.commit()
    c.close()


# ---------------------------------------------------------------- LLM
def llm_extract(raw: str) -> Optional[Attrs]:
    """Returns None on FAILURE (vs an all-unknown Attrs on a genuinely empty bio).

    The caller needs to tell these apart: an empty extraction is a real answer worth caching,
    a failure is not. Caching failures poisons the row permanently — a profile seen while your
    API key was missing would stay 'unknown' forever, even after you fix the key.
    """
    if not raw.strip():
        return _unknown()
    try:
        resp = _client.messages.parse(
            model=MODEL,
            max_tokens=1024,
            system=_SYSTEM,
            messages=[{"role": "user",
                       "content": f"Profile text:\n\n{raw.strip()[:8000]}\n\nExtract the attributes."}],
            output_format=Attrs,
        )
        return resp.parsed_output
    except Exception as e:          # network / auth / refusal / parse failure
        print("[enrich] LLM extract failed:", e)
        return None


# ---------------------------------------------------------------- public
def _coerce(value, lo: int, hi: int) -> Optional[int]:
    """Trust the collector's number only if it's actually plausible.

    Note this is deliberately not `payload.get(x) or fallback`: `or` also discards 0, and
    pydantic coerces a JSON `false` to 0. More importantly the DOM scraper is the *least*
    trustworthy input here — a mis-scraped `height_cm: 54` would produce a confident-looking
    `✗ height_cm=54` HIDE with nothing to catch it.
    """
    return value if isinstance(value, int) and not isinstance(value, bool) and lo <= value <= hi else None


def enrich(payload: dict) -> dict:
    raw = payload.get("raw_text", "") or ""
    # Key on the model and prompt version too: switching PF_MODEL to opus (as the README
    # suggests) or editing _SYSTEM must not silently keep serving the old haiku answers.
    key = hashlib.sha256(f"{MODEL}|{_PROMPT_VERSION}|{raw.strip()}".encode("utf-8")).hexdigest()

    base = _cache_get(key)
    if base is None:
        attrs = llm_extract(raw)
        if attrs is None:
            base = _unknown().model_dump()      # degrade for THIS request only
        else:
            base = attrs.model_dump()
            _cache_put(key, base)               # cache successes only

    # structured badges (if any) override the LLM's free-text guess — the person picked these
    # from a list, so they beat anything inferred from prose.
    for k, v in badges_to_attrs(payload.get("badges", []) or []).items():
        base[k] = v

    # numeric axes come from the card, not the LLM
    base["age"] = _coerce(payload.get("age"), 18, 99) or parse_age(raw)
    base["height_cm"] = _coerce(payload.get("height_cm"), 120, 220) or parse_height_cm(raw)
    return base
