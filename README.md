# Multimodal Interaction with Indoor Airflow Simulation and Optimization for Non-Expert Users

Turn everyday comfort goals — *"keep my bedroom cool"*, *"keep the kitchen smell off the bed"* — into physical airflow objectives, evaluated live inside an interactive 3D home editor.

**▶ Live demo: <https://josephleonard04.github.io/interactive-airflow/>** — runs entirely in the browser (WebGL). Nothing to install, no server, no account.

> Research project. Author: Joseph Leonard. Advisors: Prof. Haoran Xie (JAIST), Prof. Takeo Igarashi (University of Tokyo), Prof. Bo Zhu (Georgia Tech).

---

## What this is

Airflow design tools assume you can already state the problem in physics. A person cannot: they know their bedroom is cold and the kitchen smells, not that they want a higher air-change rate in zone 3. This project puts a real fluid solver behind ordinary sentences, and lets the same intent be expressed three ways — **by hand**, **by typing**, or **by drawing** — so a study can watch which one people reach for and when.

Everything runs client-side: an in-browser Euler solver, the language layer, and the placement search. The live demo above is the whole system.

## Three ways to say what you want

1. **By hand** — drag devices, aim them, open and close doors and windows.
2. **By typing** — *"I want both rooms to be similar temperature"*. A dictionary parses it offline and instantly; a model (`backend/goal_parser.py`) is tried only for wording the dictionary cannot match, and answers in the same fixed objective vocabulary so the result stays checkable against the solver. A sentence neither can read still produces a search, against the task's own goals, and says so.
3. **By drawing** — box an area and pick *warm / cool / fresh air / no wind*, or draw an arrow for "move air from here to there".

Typed and drawn intents both feed **Find solutions**, which searches your actual layout with the simulator and offers a gallery of complete arrangements. Clicking one applies it; there is no confirmation step, and Undo is the way back.

## The optimizer

Intent becomes a **constrained combinatorial optimization** over device placement, solved against the same fluid solver that draws the views. Nothing is sampled at random and nothing is tuned by hand at runtime.

**Decision variables.** Per movable device: position on a 0.25 m lattice, heading, and vertical aim quantized to 15° over ±60° (±30° for free-standing units, whose heading is already continuous). Per opening: a boolean. Wall-mounted units contribute aim only — their heading is fixed by the wall they are bolted to. Feasibility is enforced by construction rather than by rejection: candidate positions are projected onto the free space by a collision solver that already knows about furniture, doorway keep-clear zones and per-task room confinement, so infeasible points are never scored.

**Objective.** A scalarization of the parsed request over the solver's steady fields, with the active task's own thresholds entering as constraints. The composite is lexicographic in three tiers, which is what stops a good number in one place buying a violation somewhere else:

```
score = request(x) − 100·|violated constraints| − 3·Σ shortfallᵢ − 1·Σ marginᵢ
```

Each shortfall is normalized by its own goal's tolerance, so a 0.03 m/s draft overshoot and a 0.4 °C temperature overshoot are commensurable. The margin term is the same distance measured against a bar drawn a quarter-tolerance inside the real one — it orders solutions that all satisfy the constraints by how much headroom they leave, so nothing is recommended sitting exactly on its own limit.

**Multi-fidelity cascade.** Evaluating every candidate at reporting fidelity is far too slow for an interactive loop, so the solver's cost is spent where it discriminates. Three rungs, each a coarser discretization of the same Euler solve:

| Rung | Cells | Pressure iterations | Steps | Role |
|---|---|---|---|---|
| Screen | 1 200 | 4 | 8 | ranks the full candidate set under a 300-evaluation budget |
| Mid | 1 800 | 6 | 12 | re-ranks the shortlist |
| Final | 4 200 | 8 | 22 | re-scores finalists at the fidelity the goal checks use |

Because the last rung is the one the checkboxes are scored on, a card's printed numbers and its checkboxes cannot disagree.

**Local refinement.** Finalists are polished by coordinate descent over (x, z, heading, tilt) — eight translations, two rotations, two tilts per step, projected back onto the feasible set each move, under a separate 70-evaluation budget. This is what reaches positions strictly off the candidate lattice.

**Constraint handling from the drawing.** A sketched arrow is a directional constraint, not an objective term: it restricts admissible headings to a 60° cone about the bearing to the arrow's head, so the returned layout satisfies the drawn direction by construction instead of trading it away.

### Measured against exhaustive search

Both tasks brute-forced over their reachable space at reporting fidelity, and compared against what the optimizer returns:

| Task | Request | As delivered | Exhaustive best | Optimizer | Rank |
|---|---|---|---|---|---|
| Winter | *"make the bedroom warm"* | 13.51 °C | 21.49 °C | **20.77 °C** | top 0.8% of 384 |
| Apartment | *"cool the whole apartment"* | 24.89 °C | 24.58 °C | **24.66 °C** | top 1.4% of 148 feasible |

The apartment row is scored against the **feasible** subset for a reason. The unconstrained optimum over that grid is 24.47 °C and it puts **1.15 m/s across the bed** — six times the task's draft limit. It is the coldest arrangement and it is not an answer; 284 of the grid's 432 layouts are infeasible the same way. The optimizer is solving the constrained problem, so the honest comparison is against the 148 layouts that also keep the bed calm, and there it lands third.

A search completes in roughly 3–8 s in the browser, single-threaded.

**Feasibility is verified, not assumed.** Every returned layout is diffed against what its task permits — no relocating a bolted vent, no turning a wall-mounted unit, no touching a power dial the task fixes — across all four tasks on every change to the search.

## Repository layout

| Path | What it is |
|---|---|
| **[`frontend/`](frontend/)** | **The app.** Home editor, real-time solver, intent layer, placement search, study tasks, session logging. All current work is here. |
| [`backend/`](backend/) | Optional FastAPI server: the LLM goal parser, and an OpenFOAM "accurate engine" pass. The app runs fully without it. |
| [`app/`](app/) | Prof. Xie's original single-room handoff, kept as reference. |
| [`bridge/`](bridge/), [`intent/`](intent/) | Earlier LFM (GPU solver) bridge and notes. Parked. |
| [`docs/`](docs/) | [Study protocol](docs/user-study-protocol.md), [positioning](docs/contribution-positioning.md), [related work](docs/related-work.md), [optimizer notes](docs/optimizer-research.md), [two-engine design](docs/openfoam-engine.md). |

## Running it locally

Prerequisites: **Node.js 18+**. (Python 3.10+ only if you want the optional backend.)

```sh
cd frontend
npm install
npm run dev            # → http://localhost:5173
```

That is the whole app. The optional backend adds the model-based goal parser and the OpenFOAM path:

```sh
cd backend
python -m venv .venv
.venv\Scripts\activate         # Windows;  source .venv/bin/activate elsewhere
pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8000
```

Real CFD needs OpenFOAM (WSL recommended) — see [docs/openfoam-engine.md](docs/openfoam-engine.md). Without it the Accurate button returns a labeled "preview (no OpenFOAM)" field.

**Deploying:** `.github/workflows/pages.yml` rebuilds from `main` and publishes to GitHub Pages on every push. `npm run build` produces a plain static `dist/`; `npm run build:single` produces one self-contained ~1.5 MB HTML file.

## Architecture

```
        by hand          by typing            by drawing
            │                │                     │
            │        dictionary → model      area / arrow
            │                └──────┬──────────────┘
            │                       ▼
            │            objective { room, scalar, direction }
            │                       │
            ▼                       ▼
   3D home (rooms, walls, openings, furniture, devices)
            │                       │
            ▼                       ▼
      buildSim3D ───────────► placement search
   (Euler solver, MAC grid)   (screen → re-rank → polish,
            │                  scored on the same solver)
            ▼                       │
   steady flow + geodesic  ◄────────┘
   transport of temp /
   smell / drying
            │
            ├─► 3D views: airflow, temperature, humidity/smell
            ├─► task checkboxes (same solve, so they cannot disagree)
            └─► session log
```

### Code map (`frontend/src/`)

| Area | Files | Notes |
|---|---|---|
| **Study tasks** | `floorplan/scenarios.ts` | The four homes, their controls, their goals and the measured thresholds behind each. Every number in it is recorded with the sweep that produced it. |
| **Floor plan** | `floorplan/types.ts`, `home.ts`, `geometry.ts`, `catalog.ts`, `collision.ts`, `openings.ts`, `raster.ts` | Rooms/walls/openings/items; collision and doorway keep-clear rules shared by the drag, the rotate and the search |
| **State** | `scene/store.ts`, `scene/logSnapshot.ts` | Zustand store: plan, selection, undo/redo, search actions, session log |
| **Editor & UI** | `components/Editor.tsx`, `Panel.tsx`, `SimPanel.tsx`, `SketchCanvas.tsx`, `SubmitTask.tsx`, `models.tsx`, `ItemMesh.tsx`, `FlowField3D.tsx` | Theme lives in `styles.css` |
| **Solver** | `sim/euler3d.ts`, `sim/sim3d.ts` | Incompressible Euler on a MAC grid with buoyancy; the home is voxelized into solids, jets, inlets and outlets, and temperature / smell / drying are carried along the converged flow by a geodesic transport |
| **Intent** | `intent/objectives.ts`, `llmGoal.ts`, `evaluate.ts`, `sketch.ts`, `fallback.ts` | Dictionary first, model second, task goals as a last resort so the box is never a dead end |
| **Search** | `intent/solutions.ts`, `searchOptimize.ts` | Candidate generation, the fidelity ladder, the local polish, and the rules about what each task may change |
| **Goals** | `intent/goals.ts` | Scores a task's checkboxes on the same solve the views draw |

## Verifying changes

```sh
cd frontend && npx tsc --noEmit
```

There is no unit-test suite. What the project relies on instead is that the simulation modules are importable headlessly, so behavior is checked by measurement: bundle a throwaway script with `esbuild --bundle --platform=node --define:import.meta.env='{}'` and run it in Node to sweep layouts, fingerprint every scenario before and after a change, or brute-force a task's answer. Every threshold in `scenarios.ts` was set that way, and the numbers are written down next to them.

## Known limitations

- The solver is a coarse real-time prototype — 3,024–4,256 cells at reporting fidelity across the four homes, at a cell size of 0.24–0.40 m, inviscid with no turbulence model. It is calibrated so the study tasks order layouts the way the physics does, not validated against measurement or a reference CFD solve.
- The OpenFOAM path is generated but has not been run against a live install.
- The optimizer is a budgeted local method over a discretized design space. It carries no optimality certificate — the guarantee is empirical, measured against exhaustive search on two tasks, and the cascade's cheap rung can in principle discard a region the accurate rung would have preferred.
- Scalar fields beyond temperature / smell / drying (CO₂, PM2.5) are not implemented.
- `app/` (the original handoff) still runs independently: `cd app && npm install && npm run dev`.

## License

MIT — see [LICENSE](LICENSE).
