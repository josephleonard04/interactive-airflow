"""Local backend for the accurate (OpenFOAM) engine and the goal parser.

Endpoints
  GET  /api/health     -> whether OpenFOAM is reachable + version, and whether
                          the goal parser has a key
  POST /api/run        -> write the exported case, run OpenFOAM (or mock), and
                          return the sampled velocity/temperature field.
  POST /api/parse-goal -> read a typed comfort goal the frontend's keyword
                          dictionary could not (see goal_parser.py)

Run it:
  pip install -r requirements.txt
  export ANTHROPIC_API_KEY=...     # optional; only the goal parser uses it
  uvicorn app:app --host 127.0.0.1 --port 8000

The web app calls http://127.0.0.1:8000 by default (override with
VITE_OPENFOAM_BACKEND). CORS is open to localhost dev origins.
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from goal_parser import parse_goal, parser_configured
from mock_engine import compute_mock_field
from openfoam_runner import (
    detect_openfoam,
    run_case,
    sample_probes,
    write_case,
)

app = FastAPI(title="interactive_airflow OpenFOAM backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class RunRequest(BaseModel):
    name: str = "living-room"
    files: dict[str, str]
    grid: dict[str, int]
    points: list[list[float]]


class ParseGoalRequest(BaseModel):
    """One typed sentence plus just enough of the home to ground it in."""

    text: str
    rooms: list[dict[str, Any]] = []
    items: list[str] = []
    outdoor_temp: float | None = None


@app.get("/api/health")
def health() -> dict[str, Any]:
    info = detect_openfoam()
    return {
        "openfoam": info["available"],
        "version": info["version"],
        "mode": info["mode"],
        "detail": info["detail"],
        # Whether a key is PRESENT, not whether it works — see goal_parser.
        "goalParser": parser_configured(),
    }


@app.post("/api/parse-goal")
def parse_goal_route(req: ParseGoalRequest) -> dict[str, Any]:
    """Read a comfort goal the frontend's keyword dictionary could not.

    Always 200: the caller is a live study session, and every failure mode here
    has the same remedy (tell the participant, keep going). The body carries
    either `objectives` or `error`.
    """
    return parse_goal(req.text, req.rooms, req.items, req.outdoor_temp)


@app.post("/api/run")
def run(req: RunRequest) -> dict[str, Any]:
    n_points = len(req.points)
    case = _case_from_files(req.files)
    info = detect_openfoam()
    started = time.time()

    if not info["available"]:
        field = compute_mock_field(case, req.points)
        return {
            "status": "mock",
            "message": (
                "OpenFOAM not detected — showing a fast approximate preview. "
                "Install OpenFOAM (see docs/openfoam-engine.md) for an accurate run."
            ),
            "seconds": round(time.time() - started, 2),
            "grid": {**req.grid, **field},
        }

    case_dir = write_case(req.name, req.files, req.points)
    ok, log = run_case(case_dir, info["mode"])
    field = sample_probes(case_dir, n_points) if ok else None

    if ok and field is not None:
        return {
            "status": "ok",
            "message": f"OpenFOAM run complete ({info['mode']}).",
            "log": _tail(log),
            "seconds": round(time.time() - started, 2),
            "grid": {**req.grid, **field},
        }

    # Real run failed or produced no samples -> mock + the log so the user can
    # see what went wrong, but still get a usable field.
    field = compute_mock_field(case, req.points)
    return {
        "status": "mock",
        "message": "OpenFOAM run did not complete — showing approximate preview. See log.",
        "log": _tail(log),
        "seconds": round(time.time() - started, 2),
        "grid": {**req.grid, **field},
    }


def _case_from_files(files: dict[str, str]) -> dict[str, Any]:
    """The exporter embeds the engine-neutral case as case.json; mock needs it."""
    import json

    raw = files.get("case.json")
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {}


def _tail(log: str, lines: int = 60) -> str:
    return "\n".join(log.splitlines()[-lines:])


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
