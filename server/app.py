"""
PartnerFinder local server.

Run (from this folder):
    pip install -r requirements.txt
    export ANTHROPIC_API_KEY="<your-key>"
    uvicorn app:app --port 8787

The Tampermonkey userscript POSTs each profile it sees in YOUR feed to /evaluate.
Nothing leaves your machine except the profile text -> your own Claude API key.
Everything is local, your own authorized feed only (see SPEC.md sections 2 & 13).
"""
import os
import yaml
from typing import Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from enrich import enrich
from rules import evaluate_rules

app = FastAPI(title="PartnerFinder")
# GM_xmlhttpRequest bypasses CORS entirely, so this middleware isn't what makes the userscript
# work — it only matters if you call the API with fetch() from a page. Keep it scoped to the
# apps you actually browse: with allow_origins=["*"], ANY site you visit could POST to this
# port and spend your API key.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://tinder.com", "https://bumble.com", "https://www.bumble.com"],
    allow_methods=["POST"], allow_headers=["Content-Type"],
)

_CFG_PATH = os.path.join(os.path.dirname(__file__), "..", "filters.yaml")


def _load_cfg() -> dict:
    with open(_CFG_PATH, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}      # an empty/blank file is {} , not None


class ProfileIn(BaseModel):
    source_app: str = "unknown"
    # Cap the payload. The collector's `generic` adapter falls back to <main>/<body>, so on an
    # unrecognised page the entire document could otherwise be POSTed here and billed to your key.
    raw_text: str = Field("", max_length=20000)
    badges: list[str] = Field(default_factory=list, max_length=40)
    # Deliberately unbounded here so a mis-scrape degrades instead of 422-ing the whole card;
    # enrich._coerce() range-checks these and falls back to parsing the text.
    age: Optional[int] = None
    height_cm: Optional[int] = None


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/evaluate")
def evaluate(p: ProfileIn):
    enriched = enrich(p.model_dump())
    try:
        result = evaluate_rules(enriched, _load_cfg())
    except Exception as e:
        # filters.yaml is reloaded every request and you're told to edit it live, so a
        # half-saved file is expected. Fail OPEN with a visible reason rather than 500-ing
        # every card in the feed behind an opaque "bad response from server".
        print("[rules] config error:", e)
        result = {"verdict": "SHOW", "score": 0, "reasons": [f"! filters.yaml error: {e}"]}
    return {**result, "enriched": enriched}
