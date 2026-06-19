# frontend — interactive 3D room editor

A 3D analogue of SketchFluid's Fig. 11: a fixed-layout room with **movable objects** (furniture obstacles, supply/return vents). Built with Vite + React + TypeScript + [react-three-fiber](https://docs.pmnd.rs/react-three-fiber) / Three.js, state in [zustand](https://github.com/pmndrs/zustand).

## Run

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173
```

## The two control paths (advisor requirement)

Both mutate the **same** zustand store, so they can never disagree:

1. **Mouse** — click an object to select it, drag the translate gizmo to move it; the side panel also has numeric position fields and an add/remove list.
2. **Programmatic** — `window.airflow` (see [`src/scene/sceneApi.ts`](src/scene/sceneApi.ts)) is the function-call interface the intent layer / scripts use. Try it in the browser console:

   ```js
   airflow.list()                          // all objects
   airflow.translate("bed-1", [0.5, 0, 0]) // move the bed +0.5 m in x
   airflow.add({ kind: "supply", name: "AC 2", position: [1, 2.4, 0], flow: 0.2 })
   airflow.exportBoundaryConditions()      // scene -> BC JSON for the solver
   ```

## Layout

```
src/
  scene/
    types.ts        Vec3, SceneObject (furniture | supply | return), Room
    store.ts        zustand store: room, objects, selection, mutations
    sceneApi.ts     window.airflow programmatic control surface
  bc/
    exportBoundaryConditions.ts   scene -> solver-neutral BC JSON (the LFM seam)
  components/
    Editor.tsx      Canvas + OrbitControls + TransformControls (gizmo)
    Room.tsx        fixed room shell (floor/walls/wireframe)
    SceneObjectMesh.tsx  one movable object
    Panel.tsx       add / list / inspect / export UI
```

## The simulator seam

`exportBoundaryConditions()` turns the scene into a solver-neutral description
(axis-aligned solids + inlet/outlet flow patches). This is the boundary we'll
adapt to LFM once Yuchen confirms how it defines solid objects / BCs
(see [`../docs/draft-reply-yuchen.md`](../docs/draft-reply-yuchen.md), Q4). Moving
an object re-derives this — that's the core interaction.

## Not done yet

- Oriented (rotated) obstacles — boxes are axis-aligned for now (`rotationY` is stored but ignored in the BC export).
- Live coupling to LFM (currently exports JSON; no solver running — needs the GPU machine).
- Flow-field visualization overlay (comes once LFM is feeding fields back).
