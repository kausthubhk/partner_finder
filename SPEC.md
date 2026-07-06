# PartnerFinder Technical Specification

## Goals and non-goals

PartnerFinder evaluates the profile currently visible in a user's browser feed against local,
user-maintained rules. It uses deterministic parsing where possible and optional structured
extraction for free text. The result is a local show/hide verdict with a score and explanations.

It is not a profile crawler, a shared profile database, or a system for inferring protected or
sensitive traits. The service processes only explicitly displayed or self-declared information and
returns `unknown` when evidence is absent.

## Local architecture

```
Supported web client
  -> userscript collector
  -> localhost FastAPI service
  -> enrichment and SQLite cache
  -> rules engine
  -> verdict HUD
```

The collector reads the currently visible card, extracts displayed text, structured badges, age,
and height, then sends a bounded payload to `POST /evaluate`. The service responds with the
verdict, score, reasons, and enriched attributes. `GET /health` provides a local health check.

The service is intended to remain local. The SQLite cache is a disposable performance cache keyed
by input data; runtime cache creation is automatic.

## Collector and userscript

The Tampermonkey userscript uses per-site adapters and a `MutationObserver` to detect a new profile
card. It favors stable visible content and fixed badge vocabulary over brittle CSS class names.

The collector submits:

```json
{
  "source_app": "tinder",
  "raw_text": "visible profile content",
  "badges": ["Vegetarian", "Non-smoker"],
  "age": 25,
  "height_cm": 165
}
```

Payload limits and the existing local transport are part of the API boundary. The HUD applies the
returned verdict according to `CFG.applyVerdict`: hide, dim, or HUD-only. Use
`window.__pf_debug()` to inspect what the collector captured.

## FastAPI service

`server/app.py` validates incoming profile fields and exposes two stable endpoints:

- `POST /evaluate`: enriches a profile and evaluates the configured rules.
- `GET /health`: returns a small health response.

CORS is restricted to the supported web origins. The service reloads `filters.yaml` for each
evaluation so rule adjustments take effect without a restart.

## Deterministic parsing and optional enrichment

`server/enrich.py` first parses known badge vocabulary and numeric data deterministically. Badge
parsing is ordered to avoid ambiguity such as treating a non-matching lifestyle badge as a match.
Age and height are range checked before they enter rules evaluation.

Free text can be passed to structured model extraction. Every extracted field permits `unknown`.
The extraction prompt must only populate `community_selfdeclared` when profile text explicitly
self-identifies a community or background. It must never infer that information, or any sensitive
trait, from a name, surname, photo, location, language, or proxy.

Successful enrichment results are stored in SQLite. Failed model calls degrade for the current
request and are not cached, allowing a later request to recover.

## Rules and scoring

`filters.yaml` separates hard requirements, soft preferences, and red flags.

- Required age and height ranges, and required diet, drinking, and smoking values retain their
  existing hard-filter semantics: a known mismatch hides the profile.
- Unknown required values use `on_unknown`; `show_flagged` retains the profile with a reason,
  while `hide` hides it.
- Preferred values add score only. An empty preference list contributes no score.
- `community_selfdeclared` is retained as an optional compatibility field for explicitly
  self-declared community/background information. The default preference list is empty.
- Red-flag behavior is unchanged and remains independently configurable.

## Data flow

1. The userscript observes a visible profile card.
2. It sends the bounded card payload to the local service.
3. Enrichment combines deterministic badge parsing, optional free-text extraction, and cached data.
4. The rules engine returns `verdict`, `score`, and `reasons`.
5. The userscript renders the verdict HUD.

## Implementation risks

- Web clients can change DOM structure or selector behavior; adapters and `__pf_debug()` make this
  observable and repairable.
- Badge vocabulary may change; deterministic maps should be updated with tests for conflicting
  terms.
- Model extraction can be incomplete or incorrect; the schema should prefer `unknown` over a
  guess, preserve evidence-based decisions, and never infer sensitive traits from proxies.
- SQLite lock contention and transient model failures should degrade safely without corrupting the
  cache or changing the API contract.
