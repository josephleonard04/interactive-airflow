"""Read a typed comfort goal that the keyword dictionary could not.

WHY THERE IS A MODEL BEHIND THE DICTIONARY AGAIN. The dictionary in
frontend/src/intent/objectives.ts is deliberately over-inclusive and handles the
phrasings the pilot produced, but it can only ever match words it was told
about. A participant who writes "it gets stuffy in here after I cook" or "I want
the bed area to be nice to sleep" is being perfectly clear, and a tool that
answers those with silence looks broken rather than limited.

WHAT THIS DOES NOT DO is invent a new vocabulary. The model is asked to map the
sentence onto the SAME small set of objectives the solver already knows how to
evaluate — scalar x direction x region — so whatever comes back is still
checkable against the simulation rather than being free-form text the app has to
trust. A sentence with no comfort wish in it comes back empty, which is the
honest answer.

KEYWORD FIRST, MODEL SECOND. The frontend only calls this when the dictionary
returns nothing, so recognised phrasings stay instant and offline. Every failure
here — no key, no network, a refusal, a malformed reply — resolves to an empty
list with a reason, so a live session degrades to the dictionary's behaviour
instead of erroring in front of a participant.
"""

from __future__ import annotations

import json
import os
from typing import Any

MODEL = "claude-opus-5"

# The objective vocabulary, kept in lockstep with frontend/src/intent/objectives.ts.
SCALARS = ["temperature", "contaminant", "draft"]
DIRECTIONS = ["low", "high"]

OBJECTIVE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "objectives": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "scalar": {
                        "type": "string",
                        "enum": SCALARS,
                        "description": (
                            "temperature = how warm or cool it is. "
                            "contaminant = smell, stale air, damp, moisture, "
                            "mould, steam, or a wish for fresh air. "
                            "draft = air you can feel moving on you."
                        ),
                    },
                    "direction": {
                        "type": "string",
                        "enum": DIRECTIONS,
                        "description": (
                            "What the person WANTS, not what they are complaining "
                            "about. 'It is too cold in here' is a complaint about "
                            "cold and therefore wants temperature HIGH. 'Keep it "
                            "cool' is a wish and wants temperature LOW. Smell, "
                            "damp and stale air are practically always 'low'. A "
                            "draft on someone is 'low'; an explicit request for "
                            "more breeze is 'high'."
                        ),
                    },
                    "regionId": {
                        "type": ["string", "null"],
                        "description": (
                            "id of the room the goal is ABOUT — where the person "
                            "wants the condition met. Must be one of the room ids "
                            "given, or null if the sentence names no place and "
                            "the home has more than one room."
                        ),
                    },
                    "nearItem": {
                        "type": ["string", "null"],
                        "description": (
                            "Set when the goal is about a spot rather than a whole "
                            "room — 'no draught on the bed', 'fresh air by the "
                            "desk'. Must be one of the item types given, or null."
                        ),
                    },
                    "sourceId": {
                        "type": ["string", "null"],
                        "description": (
                            "For a smell goal only: the id of the room the smell "
                            "comes FROM, if the sentence says. Otherwise null."
                        ),
                    },
                },
                "required": ["scalar", "direction", "regionId", "nearItem", "sourceId"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["objectives"],
    "additionalProperties": False,
}

SYSTEM = """You turn one sentence from a non-expert into physical objectives an \
airflow simulation can check. You are the fallback behind a keyword dictionary \
that already failed on this sentence, so expect informal wording, typos, and \
goals stated as complaints.

Rules:

1. Return the objectives the person WANTS, never the problem they describe. A \
complaint asks for its opposite: "my room is much colder than the rest" wants \
temperature high; "it gets so hot in the afternoon" wants temperature low; "it \
is stuffy" wants contaminant low.
2. One sentence can carry more than one objective ("keep the bedroom cool and \
keep the kitchen smell out of it" is two). Compound places get one objective \
each: "cool the living room and the bedroom" is two objectives, not one.
3. Ground every objective in a room id from the list you are given. If the home \
has exactly one room, use it — "it's stuffy in here" needs no room name. If the \
sentence names a spot rather than a room ("on the bed", "where I sleep"), also \
set nearItem to the matching item type.
4. For a smell goal, regionId is the place being PROTECTED and sourceId is where \
the smell comes from, when the sentence says.
5. If the sentence contains no wish about the air at all — a question, a \
greeting, small talk, an instruction about something else — return an empty \
list. Do not guess a goal to be helpful. An empty list is a useful answer; an \
invented one is not.
6. Words about comfort with no quantity named ("make the bed area nice to \
sleep", "I want it bearable in here") do name a goal. Use the outdoor \
temperature you are given to decide which: hot outside means they want it \
cooler, cold outside means warmer, and otherwise they want fresher air."""


def parser_configured() -> bool:
    """Whether a credential looks available.

    NOT just ANTHROPIC_API_KEY. The SDK also accepts ANTHROPIC_AUTH_TOKEN and a
    profile written by `ant auth login`, so keying this on the one env var
    reports "not configured" to someone who is perfectly well authenticated —
    and the frontend then tells them to start a backend that is already running.

    Says nothing about whether the credential WORKS: a typo'd or expired key
    looks configured right up until every parse comes back 401, which is why the
    frontend keeps 'no credential' and 'credential rejected' apart.
    """
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return True
    config = os.environ.get("ANTHROPIC_CONFIG_DIR") or os.path.join(
        os.path.expanduser("~"), ".config", "anthropic"
    )
    return os.path.isdir(os.path.join(config, "credentials"))


def parse_goal(
    text: str,
    rooms: list[dict[str, Any]],
    items: list[str],
    outdoor_temp: float | None,
) -> dict[str, Any]:
    """Map one sentence onto the objective vocabulary.

    Returns {"objectives": [...]} or {"error": "..."} — never raises, because the
    caller is a live study session and the fallback for every failure is the same
    (say so, and carry on with what the dictionary understood).
    """
    if not text.strip():
        return {"objectives": []}

    try:
        import anthropic
    except ImportError:
        return {"error": "The anthropic package is not installed (pip install -r requirements.txt)."}

    room_lines = "\n".join(f"  - id={r['id']!r} name={r['name']!r} type={r['type']!r}" for r in rooms)
    weather = (
        f"It is {outdoor_temp:.0f} °C outside." if outdoor_temp is not None else "The outdoor temperature is unknown."
    )
    prompt = (
        f"Rooms in this home:\n{room_lines}\n\n"
        f"Item types standing in it: {', '.join(sorted(set(items))) or '(none)'}\n\n"
        f"{weather}\n\n"
        f"The person typed:\n{text.strip()!r}"
    )

    try:
        # Zero-arg: let the SDK resolve whichever credential is actually present
        # rather than second-guessing it here. If there is none it raises, and
        # the message below names ANTHROPIC_API_KEY so the frontend can tell a
        # missing credential from a rejected one.
        client = anthropic.Anthropic()
    except Exception:  # noqa: BLE001
        return {"error": "No credential found — set ANTHROPIC_API_KEY on the backend."}

    try:
        response = client.messages.create(
            model=MODEL,
            max_tokens=2048,
            system=SYSTEM,
            output_config={"format": {"type": "json_schema", "schema": OBJECTIVE_SCHEMA}},
            messages=[{"role": "user", "content": prompt}],
        )
    except Exception as exc:  # noqa: BLE001 — every failure degrades the same way
        message = str(exc)
        # The SDK resolves credentials lazily, so "there is no key" surfaces here
        # as a TypeError from inside the request rather than at construction.
        # Name the env var, because that is what the frontend matches on to tell
        # a missing credential from a rejected one — and they need different
        # advice: set a key, versus fix the key you set.
        if "Could not resolve authentication" in message:
            return {"error": "ANTHROPIC_API_KEY is not set on the backend."}
        return {"error": f"{type(exc).__name__}: {message}"}

    # A refusal carries no usable content; say so rather than reporting "no goal".
    if response.stop_reason == "refusal":
        return {"error": "The model declined to answer this request."}

    payload = next((b.text for b in response.content if b.type == "text"), None)
    if not payload:
        return {"error": f"Empty response (stop_reason={response.stop_reason})."}
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        return {"error": "The model's reply was not valid JSON."}

    room_ids = {r["id"] for r in rooms}
    item_types = set(items)
    clean: list[dict[str, Any]] = []
    for o in parsed.get("objectives", []):
        # Trust the schema for shape, never for the ids: a hallucinated room id
        # would ground a goal to a room that does not exist, and the search would
        # then optimise a part of the home the participant never mentioned.
        if o.get("scalar") not in SCALARS or o.get("direction") not in DIRECTIONS:
            continue
        clean.append(
            {
                "scalar": o["scalar"],
                "direction": o["direction"],
                "regionId": o["regionId"] if o.get("regionId") in room_ids else None,
                "nearItem": o["nearItem"] if o.get("nearItem") in item_types else None,
                "sourceId": o["sourceId"] if o.get("sourceId") in room_ids else None,
            }
        )
    return {"objectives": clean}
