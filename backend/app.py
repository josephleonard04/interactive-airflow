"""Local backend for the accurate (OpenFOAM) engine.

Endpoints
  GET  /api/health  -> whether OpenFOAM is reachable + version
  POST /api/run     -> write the exported case, run OpenFOAM (or mock), and
                       return the sampled velocity/temperature field.

Run it:
  pip install -r requirements.txt
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


@app.get("/api/health")
def health() -> dict[str, Any]:
    info = detect_openfoam()
    return {
        "openfoam": info["available"],
        "version": info["version"],
        "mode": info["mode"],
        "detail": info["detail"],
    }


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
