"""Exercise the goal parser's local-model route without a model.

    python check_goal_parser.py

Stands up an OpenAI-compatible /chat/completions on a spare port, points the
parser at it, and checks the things that are easy to get wrong and impossible to
notice in a live session: that a drawn box reaches the prompt, that `usedSketch`
cannot be claimed when nothing was drawn, that a reply wrapped in prose and a
code fence is still read, and that an unreachable model degrades to an error
string rather than raising into a study session.

The hosted (Anthropic) route is not covered here — it needs a real credential,
and the half worth testing offline is the half this file tests.
"""

from __future__ import annotations

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 11599
SEEN: dict[str, str] = {}

# What the fake model answers with. Deliberately fenced and prefaced, because
# that is what small local models actually return however firmly the format rule
# asks them not to — and reading it anyway is the point of _unwrap_json.
REPLY = {
    "objectives": [
        {
            "scalar": "temperature",
            "direction": "high",
            "regionId": "bedroom",
            "nearItem": None,
            "sourceId": None,
            "usedSketch": True,
        }
    ]
}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802 — http.server's spelling
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        SEEN["prompt"] = body["messages"][1]["content"]
        SEEN["system"] = body["messages"][0]["content"]
        SEEN["model"] = body["model"]
        content = "Sure, here you go:\n```json\n" + json.dumps(REPLY) + "\n```"
        out = json.dumps({"choices": [{"message": {"content": content}}]}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *args: object) -> None:
        pass


ROOMS = [
    {"id": "bedroom", "name": "Bedroom", "type": "bedroom"},
    {"id": "living", "name": "Living room", "type": "living"},
]
SKETCH = {"roomId": "bedroom", "roomName": "Bedroom", "x": 1.0, "z": 2.0, "w": 1.2, "d": 0.9}


def main() -> int:
    os.environ["GOAL_PARSER_PROVIDER"] = "local"
    os.environ["GOAL_PARSER_BASE_URL"] = f"http://127.0.0.1:{PORT}/v1"
    os.environ["GOAL_PARSER_MODEL"] = "llama3.1"

    server = HTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    from goal_parser import parse_goal, parser_configured

    # A local model is configured as soon as it is pointed at — no key involved.
    assert parser_configured() is True, "local provider should report configured"

    out = parse_goal("make this bit warmer", ROOMS, ["bed", "ac"], 4.0, SKETCH)
    assert out.get("objectives") == REPLY["objectives"], out
    assert "1.2 x 0.9 m" in SEEN["prompt"], "the drawn box must reach the prompt"
    assert "inside Bedroom" in SEEN["prompt"], "the box's room must reach the prompt"
    assert "usedSketch" in SEEN["system"], "the format rule must describe usedSketch"
    print("ok  drawn region reaches the model, and a fenced reply is read")

    # A model that claims the box when there is no box would ground a goal on a
    # rectangle that does not exist.
    out = parse_goal("make this bit warmer", ROOMS, ["bed"], 4.0, None)
    assert out["objectives"][0]["usedSketch"] is False, out
    assert "has not drawn anything" in SEEN["prompt"]
    print("ok  usedSketch is forced false when nothing was drawn")

    # A hallucinated room must not reach the solver.
    REPLY["objectives"][0]["regionId"] = "conservatory"
    out = parse_goal("warm it up", ROOMS, [], 4.0, SKETCH)
    assert out["objectives"][0]["regionId"] is None, out
    REPLY["objectives"][0]["regionId"] = "bedroom"
    print("ok  an unknown room id is dropped rather than passed on")

    # Nothing here may raise: the caller is a live study session.
    os.environ["GOAL_PARSER_BASE_URL"] = "http://127.0.0.1:1/v1"
    out = parse_goal("warm it up", ROOMS, [], 4.0, None)
    assert "error" in out and "unreachable" in out["error"], out
    print("ok  an unreachable local model degrades to an error string")

    print("\ngoal parser checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
