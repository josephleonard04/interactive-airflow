# Interactive Airflow — Intent-to-Physics Indoor Airflow Design

Translating non-expert, natural-language comfort goals (e.g. *"keep my bed cool"*, *"keep the kitchen odor out of my bedroom"*) into **physical airflow objectives** — and evaluating them in real time with a GPU fluid simulator inside an interactive 3D room editor.

> Research project. Advisors: Prof. Haoran Xie, Prof. Takeo Igarashi, Prof. Bo Zhu.
> Presenter / author: Joseph Leonard.

---

## The contribution

Prior work assumes the user can already express design goals as geometry, flow sketches, or quantitative physical objectives. This project provides the **missing front-end**: it turns everyday comfort goals into the physical objectives that airflow analysis and optimization require.

```
natural-language goal  ──▶  intent→physics layer  ──▶  physical objectives        ──▶  GPU fluid sim  ──▶  real-time
"keep my bed cool"          (NL → region+scalar)       minimize T in {bed region}       (LFM)              flow feedback
```

The three physical scalars in scope: **velocity**, **temperature**, and **CO₂ / contaminant concentration**, each tied to a **region** of the room and a **hard vs. soft constraint**.

## The app (`app/`)

The primary app is the **Living Room Airflow Designer** — an interactive 3D
room with editable furniture/devices, the intent→language layer, plan-sketch
input, zone metrics, and goal feedback. It runs **two simulation engines** over
the same scene:

- **Real-time** (default, always live): a CPU 3D Stable Fluids solver driving
  velocity + temperature/humidity/PM2.5/CO₂/noise, visualized as streamlines,
  particles, and heatmaps. Updates as you edit.
- **Accurate** (on demand): exports the scene to an **OpenFOAM** CFD case and
  runs it on a local backend (`backend/`), then renders the real velocity/
  temperature field through the same visualization. Triggered by a **Run
  accurate simulation** button.

This matches the advisor guidance — OpenFOAM is *not* in the interactive loop;
it is the optional accurate check, while a real-time solver drives live editing.

```sh
cd app && npm install && npm run dev      # real-time engine, no backend needed
# for the accurate engine, also run the backend (see docs/openfoam-engine.md)
```

See [`docs/openfoam-engine.md`](docs/openfoam-engine.md) for the two-engine
architecture and OpenFOAM install steps.

## System overview

A 3D interactive room (a 3D analogue of SketchFluid's Fig. 11) where:

1. **Furniture / objects are movable** — by mouse *and* by a programmatic function-call API. Moving an object changes the flow's **boundary conditions**, hence the velocity / temperature / concentration fields.
2. **The room layout is fixed**; what changes is object placement and the "AC" (supply-air) configuration.
3. A **real-time GPU fluid simulator** (LFM) provides the interactive flow field — *not* OpenFOAM, which is too slow for this loop.
4. An **intent→physics layer** maps natural-language goals to objectives over regions and scalars.

## Architecture (planned)

| Component | Path | Responsibility |
|-----------|------|----------------|
| **Primary app** (3D editor + 2 engines + intent) | [`app/`](app/) | Living Room Airflow Designer (from Prof. Xie's handoff, extended). Real-time Stable Fluids + accurate OpenFOAM export + intent layer + viz. |
| OpenFOAM backend | [`backend/`](backend/) | Local FastAPI runner for the accurate engine; runs the CFD case and samples the field back (mock fallback when OpenFOAM is absent). |
| Earlier 3D room editor | [`frontend/`](frontend/) | The original floor-plan editor + `exportBoundaryConditions` seam. Kept as reference. |
| LFM simulator bridge | [`bridge/`](bridge/), [`simulator/`](simulator/) | Bridge to Yuchen Sun's LFM real-time GPU simulator (CUDA + Vulkan). GPU-blocked; see `docs/SESSION_HANDOFF.md`. |
| Docs | [`docs/`](docs/) | Meeting notes, related-work, two-engine + LFM design. |

## Key decisions (from 2026-06-20 advisor meeting)

- **Start in 3D directly** — skip the 2D prototype.
- **Do not use OpenFOAM** — integrate the lab's real-time simulator instead.
- **Support moving objects**, not just editing boundary conditions — moving an object *is* a boundary-condition change and is often the most useful control.
- Build the interactive editor first, then wire in the simulator, then layer on the language/intent mapping.
- **Target by next meeting:** a working prototype with interactive flow visualization in a 3D room.

See [`docs/meeting-notes-2026-06-20.md`](docs/meeting-notes-2026-06-20.md) for the full notes and [`docs/related-work.md`](docs/related-work.md) for the literature positioning.

## External dependency

- **LFM** — real-time GPU fluid simulator: https://github.com/yuchen-sun-cg/lfm (CUDA + Vulkan). Access provided by Yuchen Sun (Prof. Zhu's group).

## Status

✅ Interactive 3D app with a live real-time engine and an on-demand accurate
OpenFOAM engine (local backend, mock fallback before OpenFOAM is installed).
🚧 Next: install OpenFOAM and validate the generated case on a real run; add
CO₂/PM2.5 passive-scalar transport to the accurate engine; LFM GPU integration
remains pending a GPU machine (see `docs/SESSION_HANDOFF.md`).
