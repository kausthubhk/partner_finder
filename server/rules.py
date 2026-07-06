"""
Rules engine: score an enriched profile against filters.yaml and decide show/hide.

- Numeric requireds (age, height_cm): known out-of-range -> HIDE.
- Enum requireds (diet, drinks, smokes): known not-in-allowed -> HIDE.
- Unknowns on any required field follow `on_unknown` (default: show + flag, don't hide).
- Preferred signals only add to the score (community is soft, never a gate).
- Any red flag -> HIDE.
The feed is meant to be re-ranked by `score`, so best-fit profiles surface first.
"""
from typing import Optional

# YAML turns an unquoted `no`/`yes` into a boolean. Coerce those back to strings so an
# allowed-list like [no] (parsed as [False]) still matches the enrichment's "no".
_BOOL2STR = {True: "yes", False: "no"}


def _norm(x):
    return _BOOL2STR[x] if isinstance(x, bool) else str(x).lower()


def _num_ok(v: Optional[float], rng) -> Optional[bool]:
    """None = unknown. Tolerates a half-written range, since filters.yaml is hand-edited
    live and a KeyError here 500s every card in the feed."""
    if v is None or not isinstance(rng, dict):
        return None
    lo = rng.get("min", float("-inf"))
    hi = rng.get("max", float("inf"))
    try:
        return lo <= v <= hi
    except TypeError:                      # non-numeric bound in the YAML
        return None


def evaluate_rules(p: dict, cfg: dict) -> dict:
    reasons: list[str] = []
    weights = cfg.get("weights", {})
    hide_on_unknown = cfg.get("on_unknown") == "hide"
    verdict = "SHOW"
    score = 0

    req = cfg.get("required", {})

    # --- numeric ranges (age, height_cm)
    for field in ("age", "height_cm"):
        if field not in req:
            continue
        ok = _num_ok(p.get(field), req[field])
        if ok is None:
            reasons.append(f"? {field} unknown")
            if hide_on_unknown:
                verdict = "HIDE"
        elif ok:
            reasons.append(f"✓ {field}={p[field]}")
            score += weights.get(field, 0)
        else:
            reasons.append(f"✗ {field}={p[field]}")
            verdict = "HIDE"

    # --- enum requireds (diet, drinks, smokes)
    for field in ("diet", "drinks", "smokes"):
        if field not in req:
            continue
        v = p.get(field, "unknown")
        allowed = [_norm(a) for a in req[field]]
        if v == "unknown" or v is None:
            reasons.append(f"? {field} unknown")
            if hide_on_unknown:
                verdict = "HIDE"
        elif v in allowed:
            reasons.append(f"✓ {field}={v}")
            score += weights.get(field, 0)
        else:
            reasons.append(f"✗ {field}={v}")
            verdict = "HIDE"

    # --- preferred (soft boosts only)
    pref = cfg.get("preferred", {}) or {}
    for field, values in pref.items():
        # A YAML scalar (`community_selfdeclared: background` instead of `[background]`) would
        # iterate into single CHARACTERS, and the substring test below would then match "a"
        # inside almost any value — silently handing this field's weight (the largest in the
        # file) to every profile. Coerce to a list first.
        if not isinstance(values, (list, tuple)):
            values = [values]
        low = [str(x).lower().strip() for x in values if str(x).strip()]
        if not low:
            continue

        v = p.get(field)
        hit = None
        if isinstance(v, str):                       # community, religion, any string field
            vl = v.lower().strip()
            if vl and vl not in ("unknown", "none"):
                hit = next((k for k in low if k in vl), None)
        elif isinstance(v, (list, tuple)):           # languages, interests
            have = [str(i).lower() for i in v]
            hit = next((k for k in low if any(k in h for h in have)), None)

        if hit:
            reasons.append(f"★ {field}={v if isinstance(v, str) else hit}")
            score += weights.get(field, 0)

    # --- banned / red flags
    # `banned.red_flags: ["*"]` = hide on any flag; a list of substrings = hide only on those.
    banned = (cfg.get("banned") or {}).get("red_flags", ["*"])
    if not isinstance(banned, (list, tuple)):
        banned = [banned]
    flags = [str(f) for f in (p.get("red_flags") or [])]
    if flags and banned:
        if "*" in banned:
            hits = flags
        else:
            low_b = [str(b).lower() for b in banned]
            hits = [f for f in flags if any(b in f.lower() for b in low_b)]
        if hits:
            verdict = "HIDE"
            reasons.append("✗ red flags: " + ", ".join(hits))

    return {"verdict": verdict, "score": score, "reasons": reasons}
