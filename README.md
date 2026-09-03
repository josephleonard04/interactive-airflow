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
2. **By typing** — *"I want both rooms to be similar temperature"*. A dictionary parses it offline and instantly; a model (Claude Haiku 4.5, via `backend/goal_parser.py` locally or `worker/` in public) is tried only for wording the dictionary cannot match, and answers in the same fixed objective vocabulary so the result stays checkable against the solver. A sentence neither can read still produces a search, against the task's own goals, and says so.
3. **By drawing** — box an area and pick *warm / cool / fresh air / no wind*, or draw an arrow for "move air from here to there".

The third one also combines with the second: **box an area, then type what you want there.** The drawn box answers "where" and the sentence answers "what", so "keep this area out of the draught" needs no room name — the box supplies it. The drawing travels with the sentence into both parsers, and the log records, per step, whether a drawing was on the pad and whether the parse actually used it.

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
| [`backend/`](backend/) | Optional FastAPI server: the LLM goal parser (hosted or a local model), and an OpenFOAM "accurate engine" pass. The app runs fully without it. |
| [`worker/`](worker/) | The goal parser as a public endpoint, so the model half works for anyone with the link. See [worker/README.md](worker/README.md). |
| [`shared/`](shared/) | `goal-contract.json` — the model, prompt, schema and objective vocabulary, read by both the backend and the worker so the routes cannot drift. |
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
export ANTHROPIC_API_KEY=...          # or use a local model, below
uvicorn app:app --host 127.0.0.1 --port 8000
```

**For the published link**, the parser needs a public endpoint — deploy
[`worker/`](worker/) once and set the `GOAL_PARSER_URL` repository variable, and
every visitor gets the model route. Until then the page still runs; typed goals
just fall back to the offline dictionary and the panel says so.

**The goal parser can run on this machine instead of a hosted API** — which matters when the study room has no usable network, and when a participant's verbatim wording should not leave the laptop. Any OpenAI-compatible server works (Ollama, LM Studio, llama.cpp, vLLM):

```sh
ollama serve && ollama pull llama3.1
export GOAL_PARSER_PROVIDER=local
export GOAL_PARSER_BASE_URL=http://localhost:11434/v1   # the default
export GOAL_PARSER_MODEL=llama3.1                       # the default
```

Both routes answer in the same objective vocabulary and go through the same id validation, so nothing downstream can tell which read the sentence. Check the local route without a model running:

```sh
python backend/check_goal_parser.py
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

### What the session log records

One row per action, each self-contained (the whole layout is attached, so any
step can be re-scored without replaying the ones before it). A run is identified
by a **Participant ID**, typed on the start screen before the task begins, which
travels on every event and on the file name.

| | |
|---|---|
| Who and what | participant id, scenario, task brief and thresholds as set |
| When | task start and submit, plus `t` (epoch), `at` (ms into the task) and `seq` on every row |
| What kind of action | `goal` `check` `unparsed` `sketch` `edit` `select` `engine` `review` `goals` `preset` `submit`, each also tagged `method`: manual / text / sketch / solution / system |
| The utterance | the sentence verbatim, including the ones nothing could read — those are logged as `unparsed` with the reason, because a coverage gap is a finding |
| Was a drawing live | `sketchActive` on every row, and `multimodal` when typing and a drawing were in play together |
| What the system understood | the objectives it produced — scalar, direction, region, and `fromSketchArea` when the drawn box was what grounded it |
| Whether it understood at all | dictionary / model / task-goal fallback, and which of those failed |
| What was done with the answer | candidates offered, and accepted, refined or dismissed |
| The end | submit time, the final layout, and the goals scored against it |

Exported two ways: **Study log** downloads the events mid-task (for a session
that has to be abandoned), and **Submit** downloads the full report. Both carry
the participant header; the report adds `multimodalSteps` and
`sketchGroundedSteps` so the headline RQ2 numbers need no recomputing.

## Verifying changes

```sh
cd frontend && npx tsc --noEmit
python backend/check_goal_parser.py     # local-model route, no model needed
node worker/check_worker.mjs            # public endpoint: caps, budgets, CORS
```

There is no unit-test suite. What the project relies on instead is that the simulation modules are importable headlessly, so behavior is checked by measurement: bundle a throwaway script with `esbuild --bundle --platform=node --define:import.meta.env='{}'` and run it in Node to sweep layouts, fingerprint every scenario before and after a change, or brute-force a task's answer. Every threshold in `scenarios.ts` was set that way, and the numbers are written down next to them.

## Known limitations

- The solver is a coarse real-time prototype — 3,024–4,256 cells at reporting fidelity across the four homes, at a cell size of 0.24–0.40 m, inviscid with no turbulence model. It is calibrated so the study tasks order layouts the way the physics does, not validated against measurement or a reference CFD solve.
- The OpenFOAM path is generated but has not been run against a live install.
- The optimizer is a budgeted local method over a discretized design space. It carries no optimality certificate — the guarantee is empirical, measured against exhaustive search on two tasks, and the cascade's cheap rung can in principle discard a region the accurate rung would have preferred.
- Scalar fields beyond temperature / smell / drying (CO₂, PM2.5) are not implemented.

## License

MIT — see [LICENSE](LICENSE).
