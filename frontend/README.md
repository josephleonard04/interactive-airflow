# frontend — residential floor-plan generator + 3D editor

Generates realistic residential floor plans and renders them as an interactive
3D "dollhouse" editor. Built with Vite + React + TypeScript +
[react-three-fiber](https://docs.pmnd.rs/react-three-fiber) / Three.js, state in
[zustand](https://github.com/pmndrs/zustand).

## Run

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173
```

## Housing types

Pick from five curated layouts (top of the panel, or `airflow.generate(...)`):

| id | layout |
|----|--------|
| `studio` | open living/kitchen/sleep space + bathroom + entry |
| `one_bedroom` | living + kitchen/dining + bedroom + bath + entry |
| `two_bedroom` | living + kitchen, hallway to two bedrooms + bath |
| `small_family_house` | living/dining/kitchen, hallway to bedrooms, bath, laundry, entry |
| `shared_student` | shared living + kitchen, hallway to three bedrooms + bath |

## How generation works

Each housing type is a **curated room template** (a non-overlapping tiling of
rectangles with room types + door connections). Everything else is *derived*:

```
template rooms ─▶ walls (from room adjacencies, exterior flags)
               ─▶ doors (carved into shared walls / exterior for the entry)
               ─▶ windows (on exterior walls of habitable rooms)
               ─▶ furniture (per-room placement recipes, parametric to the rect)
               ─▶ HVAC (supply per room, central return, wall AC, optional fans)
               ─▶ occupancy grid (rasterised room labels for the simulator)
```

This gives realistic, deterministic layouts rather than random rectangles.

`floorplan/` module:

```
types.ts        FloorPlan, RoomDef, WallSeg, Opening, PlacedItem, OccupancyGrid
templates.ts    the 5 housing templates (rooms + door connections)
geometry.ts     walls from rooms, shared-edge detection, opening carving, wall render pieces
furniture.ts    per-room furniture recipes (bed→wall, sofa↔tv, dining→kitchen, bath fixtures…)
hvac.ts         supply/return/ac/fan placement rules
raster.ts       rasterise rooms → labelled cell grid (the room hierarchy)
generate.ts     generateFloorPlan(housingType) → FloorPlan (ties it all together)
palette.ts      room / item colours
```

## Editing (for non-expert homeowners)

The layout is a starting point — every home is editable:

- **Move furniture**: click an item and **drag it across the floor**, drop to place. No typing.
- **Add furniture / vents**: pick from the palette (furniture, kitchen & bath, HVAC); the new item drops in the centre to drag where you want.
- **Remove**: select an item and press Delete (or use the ✕ / "Remove" button).
- **Walls**: "Add wall" mode — click two floor points to draw an axis-aligned wall. Click an existing wall to select it, then Delete to open up a room.

Furniture is placed minimally and **avoids blocking doorways** (placement skips door spans). HVAC is sensible: one ceiling supply per conditioned room, **one central return**, a wall AC unit, bathroom exhaust fans, and optional ceiling fans. Every exterior wall of a habitable room gets a window.

## The two control paths (advisor requirement)

Both mutate the same store, so they never disagree:

1. **Mouse** — select + drag furniture, draw/delete walls, add/remove from the panel.
2. **Programmatic** — `window.airflow` (see `src/scene/sceneApi.ts`):

   ```js
   airflow.generate("two_bedroom")        // switch floor plan
   airflow.listRooms()                    // room hierarchy
   airflow.list()                         // movable items (furniture + HVAC)
   airflow.add("plant", [2, 0, 2])        // add an item at a floor point
   airflow.remove("sofa-1")               // remove an item
   airflow.addWall([1, 1], [3, 1])        // draw an axis-aligned wall
   airflow.translate("bed-1", [0.5,0,0])  // move it (= change a boundary condition)
   airflow.exportBoundaryConditions()     // full plan → solver JSON
   ```

## The simulator seam

`exportBoundaryConditions()` returns a solver-neutral description for LFM: the
**room-label grid** (which cells belong to which room), wall/door/window
geometry, furniture as solid AABBs, and HVAC supply/return as inlet/outlet flow
patches. Moving an item re-derives it — that's the core interaction. The exact
schema will be adapted to LFM once Yuchen confirms its boundary-condition API
(see [`../docs/draft-reply-yuchen.md`](../docs/draft-reply-yuchen.md), Q4).

## Not done yet

- Oriented (rotated) furniture / walls — geometry is axis-aligned (`rotationY` stored but ignored in BC).
- Dense multi-program rooms (studio) use simple wall-slot placement; no overlap solver.
- Live coupling to LFM (currently exports JSON; needs the GPU machine).
- Flow-field visualization overlay.
