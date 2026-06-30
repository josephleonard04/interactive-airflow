# OpenFOAM backend (accurate engine)

Local FastAPI service that runs the **accurate** simulation engine for the web
app. It receives an exported OpenFOAM case, runs the CFD pipeline, samples the
result onto the viewer grid, and returns it. If OpenFOAM isn't installed it
returns a fast approximate **mock** field (clearly labelled) so the app's
two-engine UX works immediately.

> Not to be confused with `bridge/` (the LFM GPU-simulator bridge, GPU-blocked).
> This backend is CPU OpenFOAM and runs on the laptop today.

## Run

```sh
python -m venv .venv
.venv\Scripts\activate            # Windows  (source .venv/bin/activate on WSL/Linux)
pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8000
```

## Endpoints

- `GET /api/health` → `{ openfoam, version, mode, detail }` — is OpenFOAM reachable?
- `POST /api/run` → body `{ name, files, grid, points }` → `OpenFoamResult`
  with `status` (`ok` | `mock` | `error`), an optional solver `log`, and a
  sampled `grid` of `velocity` + `temperature`.

## Files

- `app.py` — FastAPI app + request handling + mock fallback.
- `openfoam_runner.py` — detect / write case / run pipeline / sample probes.
- `mock_engine.py` — dependency-free approximate field for when OpenFOAM is absent.

## Enabling real OpenFOAM

Install OpenFOAM (WSL recommended) and set `OPENFOAM_RUN_CMD` so the runner
executes inside a sourced OpenFOAM environment, e.g. (PowerShell):

```powershell
$env:OPENFOAM_RUN_CMD = "wsl -e bash -lc"
uvicorn app:app --host 127.0.0.1 --port 8000
```

Full install + architecture: [`../docs/openfoam-engine.md`](../docs/openfoam-engine.md).

## Notes

- Cases are written under `runs/` (gitignored). Each run gets its own timestamped
  directory; inspect or re-run it manually with `./Allrun`.
- Runs time out after 30 minutes.
