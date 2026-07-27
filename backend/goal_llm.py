"""Plain-language goal → structured objectives, via Claude.

The frontend already ships a keyword parser (`intent/objectives.ts`) that
recognises a fixed seed vocabulary — "keep the bedroom cool", "no kitchen smell
in the bedroom". It is fast, offline, and covers the phrasings the pilot survey
produced. What it cannot do is generalise: "it's stuffy in here after I cook"
matches nothing, and the participant gets silence.

This module is the fallback for exactly that case. Claude reads the sentence
plus the rooms that actually exist in the plan, and returns the SAME small
objective vocabulary the solver already understands — scalar, direction, and a
room id. It never invents a new kind of goal, so whatever comes back is still
checkable against the simulation.

The API key stays here. A browser cannot hold one safely, which is the whole
reason this lives in the backend rather than in the frontend.
"""

from __future__ import annotations

import json
import os
from typing import Any

# Claude Sonnet 5 — chosen for this feature: strong at returning strict JSON,
# and fast enough to sit in front of a participant waiting for a result.
MODEL = "claude-sonnet-5"

# The objective vocabulary, mirroring intent/objectives.ts. Kept in sync by
# hand — it is three enums and has not changed since the solver was written.
SCALARS = ("temperature", "contaminant", "draft")
DIRECTIONS = ("low", "high")

SCHEMA = {
    "type": "object",
    "properties": {
        "objectives": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "scalar": {"type": "string", "enum": list(SCALARS)},
                    "direction": {"type": "string", "enum": list(DIRECTIONS)},
                    "regionId": {
                        "type": ["string", "null"],
                        "description": "id of the room the goal is ABOUT, or null if unclear",
                    },
                    "sourceId": {
                        "type": ["string", "null"],
                        "description": "for smell goals: id of the room the smell comes from",
                    },
                },
                "required": ["scalar", "direction", "regionId", "sourceId"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["objectives"],
    "additionalProperties": False,
}

SYSTEM = """You translate a non-expert's everyday comfort wish into a small fixed \
set of physical objectives an airflow simulator can score.

scalar:
  temperature  — how warm or cool somewhere is
  contaminant  — smell, odour, stale or stuffy air
  draft        — moving air you can feel on you

direction: "low" means minimise it, "high" means maximise it.
  "keep the bedroom cool"        -> temperature / low
  "warm up the living room"      -> temperature / high
  "no kitchen smell in the bed"  -> contaminant / low, region=bedroom, source=kitchen
  "don't blow air on the bed"    -> draft / low
  "get some fresh air in here"   -> contaminant / low

Rules:
- Use ONLY the room ids given to you. If the wish names no room you can identify,
  set regionId to null rather than guessing.
- sourceId is only for smell goals that name where the smell comes from;
  otherwise null.
- One wish can carry more than one objective ("cool but no draft on the bed").
- If the sentence expresses no comfort goal at all, return an empty list."""


def available() -> bool:
    """Whether a key is configured. The tool works without one — the frontend
    keyword parser is unaffected; only this fallback goes quiet."""
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def parse_goal(text: str, rooms: list[dict[str, str]]) -> dict[str, Any]:
    """Return {"objectives": [...]} — the same shape the frontend builds itself.

    Raises nothing: every failure comes back as an empty objective list plus a
    reason, so a participant mid-task never sees a stack trace and the caller
    can quietly fall back to the keyword parser.
    """
    if not available():
        return {"objectives": [], "error": "no ANTHROPIC_API_KEY set on the backend"}
    try:
        import anthropic
    except ImportError:
        return {"objectives": [], "error": "anthropic SDK not installed"}

    listing = "\n".join(f"- id={r['id']!r} name={r['name']!r} type={r['type']!r}" for r in rooms)
    try:
        client = anthropic.Anthropic()
        response = client.messages.create(
            model=MODEL,
            max_tokens=1024,
            system=SYSTEM,
            output_config={"format": {"type": "json_schema", "schema": SCHEMA}},
            messages=[
                {
                    "role": "user",
                    "content": f"Rooms in this home:\n{listing}\n\nThe person said:\n{text}",
                }
            ],
        )
    except Exception as exc:  # network, auth, rate limit — all non-fatal here
        return {"objectives": [], "error": f"{type(exc).__name__}: {exc}"}

    # A refusal returns 200 with empty content, so check before indexing.
    if response.stop_reason == "refusal":
        return {"objectives": [], "error": "refused"}

    text_block = next((b.text for b in response.content if b.type == "text"), None)
    if not text_block:
        return {"objectives": [], "error": "empty response"}
    try:
        parsed = json.loads(text_block)
    except json.JSONDecodeError:
        return {"objectives": [], "error": "response was not JSON"}

    # Trust the schema for shape, but not the room ids — the model can still
    # name a room that isn't in this plan, and a bogus id would silently score
    # against nothing.
    valid = {r["id"] for r in rooms}
    out = []
    for o in parsed.get("objectives", []):
        if o.get("scalar") not in SCALARS or o.get("direction") not in DIRECTIONS:
            continue
        region = o.get("regionId")
        source = o.get("sourceId")
        out.append(
            {
                "scalar": o["scalar"],
                "direction": o["direction"],
                "regionId": region if region in valid else None,
                "sourceId": source if source in valid else None,
            }
        )
    return {"objectives": out, "model": MODEL}
