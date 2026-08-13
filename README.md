# Multimodal Interaction with Indoor Airflow Simulation and Optimization for Non-Expert Users

Turn everyday comfort goals — *"keep my bedroom cool"*, *"keep the kitchen smell off the bed"* — into physical airflow objectives, evaluated live inside an interactive 3D home editor.

**▶ Live demo: <https://josephleonard04.github.io/interactive-airflow/>** — runs entirely in the browser (WebGL). Nothing to install, no server, no account.

> Research project. Author: Joseph Leonard. Advisors: Prof. Haoran Xie (JAIST), Prof. Takeo Igarashi (University of Tokyo), Prof. Bo Zhu (Georgia Tech).

---

## What this is

Airflow design tools assume you can already state the problem in physics. A person cannot: they know their bedroom is cold and the kitchen smells, not that they want a higher air-change rate in zone 3. This project puts a real fluid solver behind ordinary sentences, and lets the same intent be expressed three ways — **by hand**, **by typing**, or **by drawing** — so a study can watch which one people reach for and when.

Everything runs client-side: an in-browser Euler solver, the language layer, and the placement search. The live demo above is the whole system.

## The four study tasks

The app opens on a task picker. Each task is a prebuilt home, a fixed set of controls, and one or two checkable goals — deliberately in tension, so no single move finishes the job.

| Task | Home | Weather | What you may change | Goals |
|---|---|---|---|---|
| ❄️ **Temperature (winter)** | Single-bedroom home | Freezing outside | Move the heater (living room only) and the fan | Both rooms comfortable, and no cold pool at the glass |
| 🗑️ **Kitchen smell** | Studio | Hot summer day | Move and aim the fan; open either window | Keep the kitchen smell off the bed |
| 💧 **Humidity** | Bathroom | Warm | Place the extract vent and the window | Dry the bathroom out fast after a shower |
| 🌬️ **AC blowing on the bed** | Single-bedroom apartment | Hot summer day | Tilt the AC's louvre; move the fan; the bedroom door | No strong draft on the bed **and** both rooms cool everywhere |

Every goal is a threshold the solver checks; the exact numbers, and the sweeps that set them, live next to each goal in [`frontend/src/floorplan/scenarios.ts`](frontend/src/floorplan/scenarios.ts). Participants see the goal, not the number.

Each task ends with **Submit**, which scores the goals one last time and downloads the session as JSON.

## Three ways to say what you want

1. **By hand** — drag devices, aim them, open and close doors and windows.
2. **By typing** — *"I want both rooms to be similar temperature"*. A dictionary parses it offline and instantly; a model (`backend/goal_parser.py`) is tried only for wording the dictionary cannot match, and answers in the same fixed objective vocabulary so the result stays checkable against the solver. A sentence neither can read still produces a search, against the task's own goals, and says so.
3. **By drawing** — box an area and pick *warm / cool / fresh air / no wind*, or draw an arrow for "move air from here to there".

Typed and drawn intents both feed **✨ Find solutions**, which searches your actual layout with the simulator and offers a gallery of complete arrangements. Clicking one applies it; there is no confirmation step, and Undo is the way back.

## How good are the suggestions?

The search explores **116–250 distinct arrangements** per task, ranked on a three-rung fidelity ladder (a cheap screen nominates a shortlist, a middle rung re-ranks it, the finalists are re-scored at the fidelity the checkboxes use) and then hill-climbed locally off the candidate grid.

Measured against brute force over the reachable space at reporting fidelity:

| Task | Sentence | As found | Best in a brute-force grid | What the search finds |
|---|---|---|---|---|
| Winter | *"make the bedroom warm"* | 13.5 °C | 21.09 °C | **21.38 °C** (top 0.7%) |
| Apartment | *"cool the whole apartment"* | 24.89 °C | 24.49 °C | **24.48 °C** (top 0.5%) |

It beats the grid because the polish pass reaches positions the grid does not sample. Searches take roughly 3–8 s.

Every suggestion is also **checked against the task's own rules**: nothing is proposed that the participant could not do by hand — no relocating a bolted vent, no turning a wall-mounted unit sideways, no switching off a device whose power dial the task hides. That is checked by running the search on all four tasks and diffing every offered layout against what the task permits.

## Session logs

**Submit** seals a JSON file (also kept in `localStorage`) built for analysis rather than for reading:

- every event tagged with its **method** — `manual`, `text`, `sketch`, `solution` or `system`
- the **whole layout after every event**, so any step can be scored, diffed or re-simulated on its own without replaying the ones before it
- simulator readings recorded whenever the **value** moves, not only when a checkbox flips
- typed sentences verbatim **with how they were parsed**; searches with everything they were asked and every card they offered, each with that card's layout and predicted numbers
- a schema version, per-method counts, the task's goals and thresholds, and the starting and final layouts

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

- The solver is a coarse real-time prototype (~18k cells). It is calibrated for the four study tasks, not validated against measurements.
- The OpenFOAM path is generated but has not been run against a live install.
- The placement search is greedy and budgeted. It is measurably close to optimal on the tasks above, not provably optimal.
- Scalar fields beyond temperature / smell / drying (CO₂, PM2.5) are not implemented.
- `app/` (the original handoff) still runs independently: `cd app && npm install && npm run dev`.

## License

MIT — see [LICENSE](LICENSE).
