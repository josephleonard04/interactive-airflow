# Interactive Airflow — Intent-to-Physics Indoor Airflow Design for Non-Experts

Turn everyday comfort goals — *"keep my bedroom cool"*, *"keep the kitchen smell out of the bedroom"* — into physical airflow objectives, evaluated live inside an interactive 3D home editor, with an optional accurate CFD pass.

> Research project. Author: Joseph Leonard. Advisors: Prof. Haoran Xie (JAIST), Prof. Takeo Igarashi, Prof. Bo Zhu (Georgia Tech).

---

## Repository layout

| Path | What it is |
|------|------------|
| **[`frontend/`](frontend/)** | **The primary app.** Multi-room home editor + real-time airflow simulation + intent layer + optimizer + two-engine support. All current work happens here. |
| [`app/`](app/) | Prof. Xie's original single-room "Living Room Airflow Designer" handoff (kept as reference; its UI/viz/two-engine ideas were merged into `frontend/`). |
| [`backend/`](backend/) | Local FastAPI server for the **accurate engine**: runs an OpenFOAM case exported from the editor and streams the field back. Returns a labelled approximate preview when OpenFOAM isn't installed. |
| [`bridge/`](bridge/), [`intent/`](intent/) | Earlier LFM (GPU simulator) bridge + notes. Not needed to run the app. |
| [`docs/`](docs/) | Design docs: [two-engine architecture + OpenFOAM install](docs/openfoam-engine.md), meeting notes, related work, positioning. |

## Quick start

Prerequisites: **Node.js 18+** (frontend) and optionally **Python 3.10+** (backend).

```sh
# 1) The app (everything except the OpenFOAM button works without the backend)
cd frontend
npm install
npm run dev            # → http://localhost:5173

# 2) Optional: the accurate-engine backend (second terminal)
cd backend
python -m venv .venv
.venv\Scripts\activate         # Windows;  source .venv/bin/activate elsewhere
pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8000
#   (Windows shortcut: .\run.ps1 does all of the above)
```

Real CFD needs OpenFOAM (WSL recommended) — full steps in [docs/openfoam-engine.md](docs/openfoam-engine.md). Until then the Accurate button returns an honest "preview (no OpenFOAM)" field.

## Using the app

1. **Setup screen** — choose *Example layout* (furnished 4-room home) or *Start from scratch*, enter home size (m/ft).
2. **Edit the home** — drag furniture/devices; **R** rotates 90° (or use the dial); *Add wall* draws walls on a grid; click a wall to add a door/window; click a door/window to open/close it. Camera: **Top / Iso / Fit / Free** buttons (top-right); right-drag pans.
3. **Simulate** — press **▶ Simulate airflow**. Views: **Airflow** (particle dots *or* flowing streamlines), **Temp**, **Smell**, **Noise**. Fields are steady-state, carried by the computed airflow.
4. **Presets** — Comfort / Cool down / Fresh air / Warm up / Circulate. Each one reconfigures the *whole home*: device on/off + power + fan sweep, doors & windows, **and relocates devices** via the optimizer.
5. **Plain-language goals** — type e.g. *"keep my bedroom cool"* → **✨ Best solution** searches your actual layout with the simulator and applies the best configuration. Every change shows a **review card (Accept / Modify / Cancel)**.
6. **Two engines** — ⚡ Real-time (always live, in-browser) vs 🧪 Accurate (exports the scene to an OpenFOAM `buoyantSimpleFoam` case, runs it on the local backend, renders the returned field in the same view; includes a flux-balance check).

## Architecture

```
plain-language goal ──► intent→physics ──► objective {room, scalar, direction}
                                              │
       3D home (rooms/walls/doors/furniture/devices)
                    │                         │
                    ▼                         ▼
        compileLfmScene / buildSim3D   searchOptimize (sim-scored placement search)
                    │                         │
        ┌───────────┴───────────┐             ▼
        ▼                       ▼      best device layout + settings (review card)
  Real-time Euler solver   OpenFOAM case → backend → sampled field
        │                       │
        └───────► same 3D visualization (streamlines / particles / heat layers)
                                │
                                ▼
                 per-room levels → plain-language verdict
```

### Code map (`frontend/src/`)

| Area | Files | Notes |
|------|-------|-------|
| **Floor plan model** | `floorplan/types.ts`, `home.ts`, `geometry.ts`, `catalog.ts`, `collision.ts`, `raster.ts` | Rooms/walls/openings/items; example-home generator; **collision.ts** = no-overlap + doorway keep-clear rules used everywhere |
| **State** | `scene/store.ts` | Zustand store: plan, selection, undo/redo, sim state, presets, optimizer actions, engine state |
| **3D editor & UI** | `components/Editor.tsx` (canvas, drag, walls, camera views), `Panel.tsx` (right panel + inspector), `SimPanel.tsx` (sim controls, presets, intent box, engine toggle), `SetupScreen.tsx`, `models.tsx` (all furniture/device meshes), `ItemMesh.tsx` (selection + fan sweep animation), `FlowField3D.tsx` (runs the sim, renders all field views) | **UI work starts here** — theme lives in `styles.css` (CSS variables at the top) |
| **Solver** | `sim/euler3d.ts` (incompressible Euler, MAC grid, semi-Lagrangian advection, pressure projection, buoyancy), `sim/sim3d.ts` (voxelizes the home → solids/inlets/outlets/jets; `advectDiffuseFill` carries temp/smell along the converged flow), `sim/noise.ts` (appliance noise: dB falloff + per-wall attenuation) | Coarsened (~18k cells) to stay real-time single-threaded |
| **Viz** | `viz/streamlines.ts` | RK2 integration, whole-house seeding, Catmull-Rom smoothing, speed colouring; drawn as animated dashed fat lines |
| **Intent** | `intent/objectives.ts` (lexicon parse + room grounding → objective), `intent/evaluate.ts` (objective vs simulated field → verdict), `intent/optimize.ts` + `intent/searchOptimize.ts` (**derivative-free greedy search**: layout-derived candidates, constraint filter, each candidate scored by a coarse solver run, ~20 evals ≈ 1–2 s) | Not differentiable / no ML — deliberate; see slide notes |
| **Accurate engine** | `engine/accurate.ts`, `bc/lfm.ts` (`compileLfmScene`: scene → domain grid + solids + flux-balanced inlets/outlets) | Talks to `backend/` at `http://127.0.0.1:8000` |

### Backend API (`backend/`)

- `GET /api/health` → `{ openfoam, version, mode }` — is OpenFOAM available?
- `POST /api/run` → writes the exported case, runs `blockMesh → snappyHexMesh → topoSet → createPatch → buoyantSimpleFoam`, samples U/T at the viewer's grid points, returns `{ status: ok|mock|error, grid, log }`. `mock_engine.py` supplies the approximate preview when OpenFOAM is absent. Configure WSL/Docker via `OPENFOAM_RUN_CMD` (e.g. `wsl -e bash -lc`).

## Verifying changes

```sh
cd frontend && npx tsc --noEmit     # typecheck (no test suite yet)
```
The sim modules are importable headlessly (Node or browser console):
`buildSim3D(plan)` → `sim.step(dt)` loop → inspect fields; `searchOptimize(plan, goal, roomId, budget)` for the optimizer.

## Known limitations / notes

- Solver is a coarse prototype (real-time first); OpenFOAM path is generated but untested against a live install yet.
- Scalar fields beyond temp/smell/noise (CO₂, humidity, PM2.5) are planned.
- Intent parsing is a dictionary — deterministic, offline, and checkable. Every
  sentence it reads maps to the same small objective vocabulary the solver
  scores, so a goal is never free-form text. What it cannot read it says so
  about, and the sentence is logged verbatim as the coverage gap.
- The optimizer is greedy + budgeted, not globally optimal — every change is user-reviewable by design.
- `app/` (the original handoff) still runs independently: `cd app && npm install && npm run dev`.

## Key documents

- [docs/openfoam-engine.md](docs/openfoam-engine.md) — two-engine design + OpenFOAM install (WSL)
- [docs/contribution-positioning.md](docs/contribution-positioning.md) — research question & what's-new
- [docs/related-work.md](docs/related-work.md) — comparison matrix (Dai 2025, Zhang 2025, Liu 2017)
- [docs/SESSION_HANDOFF.md](docs/SESSION_HANDOFF.md) — LFM (GPU solver) integration notes, currently parked
