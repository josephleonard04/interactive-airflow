# frontend — home airflow designer

A homeowner-friendly 3D home designer: enter your home's size, get a furnished
layout (living room, bedroom, kitchen, bathroom), then drag furniture, edit
walls, and add/remove objects. Built with Vite + React + TypeScript +
[react-three-fiber](https://docs.pmnd.rs/react-three-fiber) / Three.js, state in
[zustand](https://github.com/pmndrs/zustand).

## Run

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173
```

## Flow

1. **Setup screen** — enter Length × Width × Height in **metres or feet**.
2. The app generates **one home**: living room, bedroom, kitchen, bathroom, with
   the entrance opening into the living room, plus windows on exterior walls.
3. A **minimal, curated object set** is placed (door-aware, against walls):
   bedroom — bed, desk, closet, fan; living — couch, TV, table, AC, heater,
   supply vent; kitchen — fridge, sink; bathroom — sink.

## Editing (drag-first, for non-experts)

- **Undo / redo**: buttons in the panel, or **Ctrl/Cmd+Z** / **Ctrl+Shift+Z**. A
  drag counts as a single undo step.
- **Move**: click an item and **drag it across the floor**, drop to place.
- **Rotate**: select an item and press **R** (or the Rotate 90° button).
- **Add**: pick from the palette (furniture / heating-cooling-air); it drops in
  the centre to drag where you want.
- **Remove**: select + Delete, the ✕ in the list, or the "Remove" button.
- **Walls**: "Add wall" mode → click two floor points to draw an axis-aligned
  wall; click an existing wall + Delete to open up a room.
- **Doors & windows**: click a wall, then "Add door" / "Add window". Click a
  door/window (in the view or the list) to **open/close** it or remove it. One
  window per room by default. Open openings let air through; closed ones don't —
  this is carried into the boundary-condition export.
- **Resize**: "Change size" reopens the setup screen.

## Code map

```
floorplan/
  types.ts      FloorPlan, RoomDef, WallSeg, Opening, PlacedItem, OccupancyGrid, HomeSize
  home.ts       generateHome({length,width,height}) → the single 4-room home
  geometry.ts   walls from rooms, shared-edge detection, opening carving, wall render pieces
  raster.ts     rasterise rooms → labelled cell grid (room hierarchy for the solver)
  catalog.ts    item specs + add-palette
  palette.ts    room / item colours
components/
  SetupScreen.tsx   dimension entry (m / ft)
  Editor.tsx        Canvas, OrbitControls, drag-to-move, wall-draw, delete keys
  FloorPlanView.tsx colour-coded room floors (no on-floor labels) + walls
  WallMesh.tsx      wall as boxes carved around doors/windows; selectable
  ItemMesh.tsx      a placed item: model + click target + selection outline
  models.tsx        composite furniture models (bed, desk, closet, couch, tv, …)
  Panel.tsx         home size, edit tools, add palette, room/object browser, save
scene/
  store.ts      zustand store (plan, selection, drag, edit mode, edit actions)
  sceneApi.ts   window.airflow programmatic control surface
bc/
  exportBoundaryConditions.ts   plan → solver-neutral JSON (room grid + geometry + flows)
```

## The two control paths (advisor requirement)

Both mutate the same store, so they never disagree:

1. **Mouse** — select + drag furniture, draw/delete walls, add/remove from the panel.
2. **Programmatic** — `window.airflow`:

   ```js
   airflow.generate({ length: 9, width: 7, height: 2.7 })
   airflow.list(); airflow.find("bed")
   airflow.add("couch", [2, 0, 2]); airflow.remove("tv-1")
   airflow.addWall([1, 1], [3, 1])
   airflow.translate("bed-1", [0.5, 0, 0])   // = change a boundary condition
   airflow.exportBoundaryConditions()        // room grid + walls + openings + solids + flows
   ```

## The simulator seam

`exportBoundaryConditions()` returns the room-label grid, wall/door/window
geometry, furniture solids, and HVAC inlet/outlet flow patches (plus fans and
heaters) for LFM. Moving an item re-derives it. The exact schema will be adapted
to LFM once Yuchen confirms its boundary-condition API (see
[`../docs/draft-reply-yuchen.md`](../docs/draft-reply-yuchen.md), Q4).

## Not done yet

- Furniture is axis-aligned in the BC export (`rotationY` is rendered but the BC
  uses axis-aligned bounding boxes).
- Live coupling to LFM (currently exports JSON; needs the GPU machine).
- Flow-field visualization overlay.
