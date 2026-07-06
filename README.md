# PartnerFinder

**A local, explainable profile filter for the browser feed already in front of you.**

PartnerFinder turns the visible details on a profile card into a clear verdict: show it, hide it,
or flag it for a closer look. It pairs a small browser userscript with a localhost FastAPI service,
so the rules are yours to inspect and adjust rather than a black box built into a dating app.

> Privacy rule: use only information explicitly displayed or self-declared in a profile. Never
> infer sensitive traits from a name, surname, photo, location, language, or another proxy.

## What it does

- Reads the currently visible card—rather than crawling a feed or building a profile dataset.
- Parses age, height, and structured lifestyle badges deterministically.
- Optionally extracts explicitly stated facts from free text, returning `unknown` when evidence is
  missing.
- Applies live rules from `filters.yaml` and displays a score with human-readable reasons.
- Keeps a disposable, local SQLite cache to avoid repeatedly enriching the same text.

```text
Visible profile card
       |
       v
Userscript collector -- bounded localhost request --> FastAPI service
                                                       |
                                                       v
                                             enrichment + local cache
                                                       |
                                                       v
                                             rules, score, and reasons
                                                       |
                                                       v
                                                  verdict HUD
```

## Repository map

| Path | Purpose |
| --- | --- |
| `userscript/partnerfinder.user.js` | Browser collector, site adapters, and verdict HUD. |
| `server/app.py` | Local FastAPI service: `POST /evaluate` and `GET /health`. |
| `server/enrich.py` | Deterministic parsing, optional structured extraction, and cache access. |
| `server/rules.py` | Required rules, preference scoring, red-flag handling, and explanations. |
| `filters.yaml` | Live-editable filtering and scoring configuration. |
| `SPEC.md` | Technical architecture, data flow, and implementation constraints. |

## Quick start

1. Start the local service:

   ```bash
   cd server
   pip install -r requirements.txt
   export ANTHROPIC_API_KEY="<your-key>"
   uvicorn app:app --port 8787
   ```

   `claude-haiku-4-5` is the default model. Set `PF_MODEL` before starting the service if you
   need a different compatible model.

2. Install Tampermonkey or Violentmonkey, create a userscript, and paste in
   `userscript/partnerfinder.user.js`.

3. Open a supported web client. The HUD will update as a new visible card is collected.

## Configure the filter

`filters.yaml` is reloaded for each evaluation, so edits take effect without restarting the
service.

```yaml
required:
  age:       { min: 20, max: 23 }
  height_cm: { min: 150, max: 165 }
  diet:      ["vegetarian", "vegan"]
  drinks:    ["no"]
  smokes:    ["no"]

preferred:
  community_selfdeclared: []
  languages: [tamil]

on_unknown: show_flagged
```

- **Required** values are hard filters: a known mismatch hides the profile.
- **Unknown** required values follow `on_unknown`; `show_flagged` keeps them visible with an
  explanation, while `hide` filters them out.
- **Preferred** values add score only. `community_selfdeclared` is retained for backward
  compatibility as an optional, explicitly self-declared community/background field; its default
  list is empty, so it does not add a score.
- **Red flags** retain their existing independent behavior under `banned.red_flags`.

## Debugging a card

Open the browser developer console on the feed and run:

```js
window.__pf_debug()
```

This returns the data captured from the current card. If a structured value is missing, update the
relevant adapter selector or badge vocabulary in the userscript. The display behavior is controlled
by `CFG.applyVerdict`:

| Setting | Effect |
| --- | --- |
| `'hide'` | Hide cards that fail a rule. |
| `'dim'` | Keep failures visible with the default subdued treatment. |
| `'off'` | Leave cards unchanged and show only the HUD. |

## Local-first by design

The service binds to localhost, the cache is disposable, and the project is not a shared profile
store. If free-text enrichment is enabled, it should receive only the supplied profile text and
must abstain (`unknown`) instead of guessing. The `community_selfdeclared` field is populated only
when the supplied text explicitly identifies that background.

For implementation details, API boundaries, and known maintenance risks such as selector churn,
see [SPEC.md](SPEC.md).
