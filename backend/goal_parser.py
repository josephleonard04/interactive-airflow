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

# WHICH MODEL READS THE SENTENCE.
#
# Anthropic by default. The alternative is a model on the machine itself, which
# matters for two reasons the hosted one cannot answer: a study session in a room
# with no usable network still has its fallback parser, and a participant's
# verbatim wording never leaves the laptop — which is the thing an ethics
# application has to promise about free-text input.
#
#   GOAL_PARSER_PROVIDER=anthropic   (default)
#   GOAL_PARSER_PROVIDER=local       any OpenAI-compatible server:
#                                    Ollama, LM Studio, llama.cpp, vLLM
#   GOAL_PARSER_BASE_URL=http://localhost:11434/v1
#   GOAL_PARSER_MODEL=llama3.1
#
# Both routes answer in the SAME objective vocabulary and go through the same
# id validation below, so nothing downstream — the solver, the panel, the log —
# can tell which one read the sentence. The log records which did, because a
# coverage gap found by a 7B local model is not the same finding as one found by
# Opus.
#
# THE PROMPT ITSELF LIVES IN shared/goal-contract.json, because there is a third
# runtime now: the Cloudflare Worker that serves the published page (worker/).
# A prompt kept in two languages is a prompt that drifts, and the whole claim of
# this layer is that every route answers in one vocabulary.
_CONTRACT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "shared", "goal-contract.json")

with open(_CONTRACT_PATH, encoding="utf-8") as _f:
    _CONTRACT = json.load(_f)

MODEL = _CONTRACT["model"]
SCALARS = _CONTRACT["scalars"]
DIRECTIONS = _CONTRACT["directions"]
SYSTEM = _CONTRACT["system"]
OBJECTIVE_SCHEMA: dict[str, Any] = _CONTRACT["schema"]
_LOCAL_FORMAT_RULE = _CONTRACT["localFormatRule"]

LOCAL_MODEL_DEFAULT = "llama3.1"
LOCAL_BASE_URL_DEFAULT = "http://localhost:11434/v1"


def _provider() -> str:
    return (os.environ.get("GOAL_PARSER_PROVIDER") or "anthropic").strip().lower()


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
    # A local model needs no credential at all — it is configured as soon as it
    # is pointed at, and whether it is actually RUNNING is a different question,
    # the same one a missing Anthropic key cannot answer either.
    if _provider() == "local":
        return True
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return True
    config = os.environ.get("ANTHROPIC_CONFIG_DIR") or os.path.join(
        os.path.expanduser("~"), ".config", "anthropic"
    )
    return os.path.isdir(os.path.join(config, "credentials"))


def _call_anthropic(prompt: str) -> dict[str, Any]:
    """The hosted route. Returns {"text": ...} or {"error": ...}, never raises."""
    try:
        import anthropic
    except ImportError:
        return {"error": "The anthropic package is not installed (pip install -r requirements.txt)."}

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

    text = next((b.text for b in response.content if b.type == "text"), None)
    if not text:
        return {"error": f"Empty response (stop_reason={response.stop_reason})."}
    return {"text": text}


def _call_local(prompt: str) -> dict[str, Any]:
    """A model on this machine, over the OpenAI-compatible chat API.

    Ollama, LM Studio, llama.cpp and vLLM all speak it, so one client covers the
    lot. Schema enforcement is weaker than the hosted route's — a small model
    will wrap its JSON in prose or a code fence however firmly it is asked not
    to — so the reply is unwrapped here rather than trusted. Everything it
    returns still goes through the same id validation as the hosted route, which
    is what actually keeps a hallucinated room out of the solver.
    """
    import urllib.error
    import urllib.request

    base = (os.environ.get("GOAL_PARSER_BASE_URL") or LOCAL_BASE_URL_DEFAULT).rstrip("/")
    model = os.environ.get("GOAL_PARSER_MODEL") or LOCAL_MODEL_DEFAULT
    body = json.dumps(
        {
            "model": model,
            "messages": [
                # The schema goes in the prompt, not in a parameter: json_schema
                # support is inconsistent across local servers, and one that
                # ignores an unknown field silently is worse than not asking.
                {"role": "system", "content": SYSTEM + "\n\n" + _LOCAL_FORMAT_RULE},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0,
            "stream": False,
            "response_format": {"type": "json_object"},
        }
    ).encode()

    request = urllib.request.Request(
        f"{base}/chat/completions",
        data=body,
        headers={"content-type": "application/json"},
    )
    key = os.environ.get("GOAL_PARSER_API_KEY")
    if key:
        request.add_header("authorization", f"Bearer {key}")

    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            data = json.loads(response.read())
    except urllib.error.URLError as exc:
        # Named explicitly, because "start Ollama" and "fix your key" are the two
        # different things a researcher might have to do and the frontend shows
        # different words for each.
        return {"error": f"Local model at {base} is unreachable ({exc.reason}). Is it running?"}
    except Exception as exc:  # noqa: BLE001
        return {"error": f"{type(exc).__name__}: {exc}"}

    try:
        text = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        return {"error": "The local model returned no message content."}
    return {"text": _unwrap_json(text)}


def _unwrap_json(text: str) -> str:
    """Pull the JSON object out of a reply that may be fenced or prefaced."""
    body = text.strip()
    if body.startswith("```"):
        body = body.split("```")[1] if "```" in body[3:] else body[3:]
        if body.lstrip().lower().startswith("json"):
            body = body.lstrip()[4:]
    start, end = body.find("{"), body.rfind("}")
    return body[start : end + 1] if start != -1 and end > start else body.strip()


def parse_goal(
    text: str,
    rooms: list[dict[str, Any]],
    items: list[str],
    outdoor_temp: float | None,
    sketch_region: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Map one sentence onto the objective vocabulary.

    Returns {"objectives": [...]} or {"error": "..."} — never raises, because the
    caller is a live study session and the fallback for every failure is the same
    (say so, and carry on with what the dictionary understood).
    """
    if not text.strip():
        return {"objectives": []}

    room_lines = "\n".join(f"  - id={r['id']!r} name={r['name']!r} type={r['type']!r}" for r in rooms)
    weather = (
        f"It is {outdoor_temp:.0f} °C outside." if outdoor_temp is not None else "The outdoor temperature is unknown."
    )
    # The drawing is context for the sentence, not a second request. Described
    # in metres and by the room it lands in, because "a 1.2 x 0.9 m box in the
    # Bedroom" is groundable and a pair of raw corners is not.
    if sketch_region:
        where = sketch_region.get("roomName") or sketch_region.get("roomId") or "the home"
        drawn = (
            "The person has ALSO drawn a box on the floor plan, "
            f"{float(sketch_region.get('w', 0)):.1f} x {float(sketch_region.get('d', 0)):.1f} m, "
            f"inside {where} (room id {sketch_region.get('roomId')!r}). "
            "See rule 6.\n\n"
        )
    else:
        drawn = "The person has not drawn anything on the plan.\n\n"

    prompt = (
        f"Rooms in this home:\n{room_lines}\n\n"
        f"Item types standing in it: {', '.join(sorted(set(items))) or '(none)'}\n\n"
        f"{weather}\n\n"
        f"{drawn}"
        f"The person typed:\n{text.strip()!r}"
    )

    payload = _call_local(prompt) if _provider() == "local" else _call_anthropic(prompt)
    if "error" in payload:
        return payload
    try:
        parsed = json.loads(payload["text"])
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
                # Only meaningful if something was actually drawn: a model that
                # claims the box when there is no box would ground the goal on
                # a rectangle that does not exist.
                "usedSketch": bool(o.get("usedSketch")) and sketch_region is not None,
            }
        )
    return {"objectives": clean}
