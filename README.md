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

## System overview

A 3D interactive room (a 3D analogue of SketchFluid's Fig. 11) where:

1. **Furniture / objects are movable** — by mouse *and* by a programmatic function-call API. Moving an object changes the flow's **boundary conditions**, hence the velocity / temperature / concentration fields.
2. **The room layout is fixed**; what changes is object placement and the "AC" (supply-air) configuration.
3. A **real-time GPU fluid simulator** (LFM) provides the interactive flow field — *not* OpenFOAM, which is too slow for this loop.
4. An **intent→physics layer** maps natural-language goals to objectives over regions and scalars.

## Architecture (planned)

| Component | Path | Responsibility |
|-----------|------|----------------|
| 3D room editor | [`frontend/`](frontend/) | Interactive 3D scene: room, movable objects, supply/return vents. Mouse editing **and** a programmatic transform API. |
| Intent→physics layer | [`intent/`](intent/) | NL goal → `{region, scalar, target, hard/soft}` objectives. Starts with a domain dictionary (cool/warm → temperature, etc.). |
| Simulator integration | [`simulator/`](simulator/) | Bridge to Yuchen Sun's LFM real-time fluid simulator (CUDA + Vulkan volumetric renderer). Object placement → boundary conditions → flow field. |
| Docs | [`docs/`](docs/) | Meeting notes, related-work summaries, design decisions. |

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

🚧 Scaffolding. Next: stand up the 3D room editor and obtain/build LFM.
