import { boundsOf, buildWalls } from "./geometry";
import {
  against,
  doorsForRoom,
  idGen,
  inCorner,
  placeDoor,
  placeEntrance,
  placeWindows,
  type IdGen,
} from "./home";
import { VENT_SIZE, ventMountY } from "./catalog";
import { rasterize } from "./raster";
import { resolveOverlaps } from "./collision";
import type { FloorPlan, Opening, PlacedItem, RoomDef } from "./types";

// Study scenarios: one prebuilt home per task, plus the set of controls that
// task is allowed to touch.
//
// Two design rules, both from the pilot survey and both deliberate:
//
//  1. **No task is solvable by typing one sentence.** Every scenario carries a
//     second clause that pulls against the first (cool BOTH rooms; keep the
//     smell out AND clear the source; fit a layout AND keep the smell away), so
//     a single goal satisfies half of it and the participant has to see the
//     other half fail and respond. That is the whole point of comparing a
//     multimodal condition against manual: if one prompt finished the job there
//     would be nothing to observe.
//  2. **Only the controls the task is about are shown.** The homes are already
//     furnished and the participant is not being asked to decorate, so the
//     furniture palette, the size control and (where irrelevant) the wall tool
//     are hidden. Every remaining control is one the task actually turns on.
//
// Scenario 1 designs a home from an empty shell; scenarios 2 and 3 are prebuilt
// homes to adjust.

export type ScenarioId = "design" | "twoRooms" | "smell";

export interface ScenarioTools {
  /** Item types the participant may move. Empty = none movable. */
  movable: string[];
  /** Item types offered in the "add" palette. Empty = palette hidden. */
  addable: string[];
  /** Draw new interior walls. */
  walls: boolean;
  /** Add / remove / open / close doors and windows. */
  openings: boolean;
  /** Change the home's footprint. */
  resize: boolean;
}

export interface Scenario {
  id: ScenarioId;
  /** Short label for the facilitator. */
  title: string;
  /** Outdoor air temperature (°C) for this task. FIXED — the participant must
   *  not be able to change the weather, or a cooling task is "solved" by
   *  dragging the outdoor slider down. */
  outdoorTemp: number;
  /** Running-cost ceiling, or null if this task has no budget. */
  costBudget?: number;
  /** Read to the participant verbatim — comfort goal only, no physics. */
  brief: string;
  /** What the participant may change, in plain words, shown in the panel. */
  youCanChange: string;
  tools: ScenarioTools;
  /** Researcher-facing: what counts as done. Not shown to the participant. */
  success: string;
  build: () => FloorPlan;
}

const H = 2.7;

/** Finish a hand-authored layout: walls, doors, windows, grid. */
function assemble(
  name: string,
  rooms: RoomDef[],
  wire: (walls: ReturnType<typeof buildWalls>, gen: IdGen, doors: Opening[]) => void,
  makeItems: (gen: IdGen, rooms: RoomDef[], openings: Opening[]) => PlacedItem[],
  opts: { windows?: boolean } = {},
): FloorPlan {
  const gen = idGen();
  const bounds = boundsOf(rooms);
  const walls = buildWalls(rooms, H);
  const doors: Opening[] = [];
  wire(walls, gen, doors);
  // Interior doors start OPEN so the home is in a plausible everyday state and
  // the participant has to decide whether that is what they want.
  for (const d of doors) if (!d.rooms.includes("outside")) d.open = true;
  const windows = opts.windows === false ? [] : placeWindows(walls, gen, rooms);
  const items = resolveOverlaps(makeItems(gen, rooms, [...doors, ...windows]), rooms, [...doors, ...windows]);
  const size = { length: bounds.w, width: bounds.d, height: H };
  return { name, size, bounds, wallHeight: H, rooms, walls, doors, windows, items, grid: rasterize(rooms, bounds) };
}

const room = (id: string, type: RoomDef["type"], name: string, x: number, z: number, w: number, d: number): RoomDef => ({
  id,
  type,
  name,
  rect: { x, z, w, d },
});

// ---------------------------------------------------------------- scenario 1

/**
 * SHELL — a bare one-bedroom apartment being planned. The wet block (kitchen +
 * bathroom) is fixed along the east side because plumbing is; everything west of
 * it is one undivided space the participant has to partition.
 *
 * From the survey: "How can I design the layout to prevent unpleasant smells
 * from the kitchen and bathroom from spreading into the bedrooms?" and
 * "bathrooms and kitchens should have more windows and AC should be placed
 * strategically so that these rooms have more air flow."
 */
function buildShell(): FloorPlan {
  const rooms = [
    room("open", "living", "Open space", 0, 0, 6.2, 6.6),
    room("kitchen", "kitchen", "Kitchen", 6.2, 3.3, 3.0, 3.3),
    room("bathroom", "bathroom", "Bathroom", 6.2, 0, 3.0, 3.3),
  ];
  return assemble(
    "Apartment being planned",
    rooms,
    (walls, gen, doors) => {
      placeDoor(walls, gen, rooms[0], rooms[1], doors);
      placeDoor(walls, gen, rooms[0], rooms[2], doors);
      placeEntrance(walls, gen, rooms[0], doors);
    },
    (gen, rs, openings) => {
      const c = (r: RoomDef) => doorsForRoom(r, openings);
      const [open, kitchen, bath] = rs;
      return [
        inCorner(gen, kitchen, "north", "start", "kitchen_sink", [1.0, 0.9, 0.6]),
        against(gen, kitchen, c(kitchen), "north", 0.85, "fridge", [0.7, 1.8, 0.7]),
        against(gen, kitchen, c(kitchen), "east", 0.5, "return", VENT_SIZE, {
          category: "hvac", mount: "wall", y: ventMountY(H), flow: 0.02,
        }),
        against(gen, bath, c(bath), "west", 0.3, "toilet", [0.55, 0.75, 0.7]),
        against(gen, bath, c(bath), "east", 0.5, "bathtub", [1.6, 0.6, 0.75]),
        against(gen, bath, c(bath), "east", 0.9, "return", VENT_SIZE, {
          category: "hvac", mount: "wall", y: ventMountY(H), flow: 0.02,
        }),
        // The AC exists but is parked on the west wall — where it goes is the
        // participant's decision, and it is the wrong answer where it starts.
        against(gen, open, c(open), "west", 0.5, "ac", [0.85, 0.32, 0.22], {
          category: "hvac", mount: "wall", y: H - 0.5, flow: 0.25,
        }),
      ];
    },
  );
}

// ---------------------------------------------------------------- scenario 2

/**
 * RAILROAD — two bedrooms at opposite ends of a long apartment with one AC in
 * the middle. The far bedroom cannot be reached by turning the AC up; it is
 * reached by moving it, or by what the doors are doing.
 *
 * From the survey, the most-requested question of all — four of six free-text
 * ideas: "How can I use a single air conditioner to cool multiple rooms?"
 */
function buildRailroad(): FloorPlan {
  const rooms = [
    room("bedroomA", "bedroom", "Bedroom A", 0, 0, 3.2, 6.0),
    room("living", "living", "Living Room", 3.2, 0, 4.6, 3.6),
    room("kitchen", "kitchen", "Kitchen", 3.2, 3.6, 4.6, 2.4),
    room("bedroomB", "bedroom", "Bedroom B", 7.8, 0, 3.2, 6.0),
  ];
  return assemble(
    "Two-bedroom apartment",
    rooms,
    (walls, gen, doors) => {
      placeDoor(walls, gen, rooms[1], rooms[0], doors);
      placeDoor(walls, gen, rooms[1], rooms[2], doors);
      placeDoor(walls, gen, rooms[1], rooms[3], doors);
      placeEntrance(walls, gen, rooms[2], doors);
    },
    (gen, rs, openings) => {
      const c = (r: RoomDef) => doorsForRoom(r, openings);
      const [a, living, kitchen, bthe] = rs;
      return [
        against(gen, a, c(a), "west", 0.4, "bed", [1.5, 0.5, 2.0]),
        against(gen, a, c(a), "north", 0.8, "closet", [1.0, 2.0, 0.6]),
        against(gen, bthe, c(bthe), "east", 0.4, "bed", [1.5, 0.5, 2.0]),
        against(gen, bthe, c(bthe), "north", 0.8, "desk", [1.2, 0.75, 0.6]),
        against(gen, living, c(living), "south", 0.3, "couch", [1.8, 0.8, 0.85]),
        inCorner(gen, kitchen, "north", "start", "kitchen_sink", [1.0, 0.9, 0.6]),
        against(gen, kitchen, c(kitchen), "north", 0.85, "fridge", [0.7, 1.8, 0.7]),
        // One AC, in the middle room, on the wall furthest from both bedrooms.
        against(gen, living, c(living), "south", 0.7, "ac", [0.85, 0.32, 0.22], {
          category: "hvac", mount: "wall", y: H - 0.5, flow: 0.25,
        }),
        against(gen, living, c(living), "north", 0.2, "fan", [0.45, 1.3, 0.45], {
          category: "hvac", mount: "floor", flow: 0, on: false,
        }),
      ];
    },
  );
}

// ---------------------------------------------------------------- scenario 3

/**
 * BAD ADJACENCY — the kitchen opens straight onto the bedroom, which is the
 * situation the richest survey response described: doors normally shut, no
 * ventilation where the cooking is, and the smell going where it is least
 * wanted. Sealing the bedroom door is the obvious move and it fails the second
 * half of the brief, because the kitchen then never clears.
 */
function buildAdjacency(): FloorPlan {
  const rooms = [
    room("bedroom", "bedroom", "Bedroom", 0, 0, 3.6, 3.6),
    room("kitchen", "kitchen", "Kitchen", 0, 3.6, 3.6, 3.4),
    room("living", "living", "Living Room", 3.6, 0, 4.6, 4.2),
    room("bathroom", "bathroom", "Bathroom", 3.6, 4.2, 4.6, 2.8),
  ];
  return assemble(
    "Apartment with the kitchen next to the bedroom",
    rooms,
    (walls, gen, doors) => {
      placeDoor(walls, gen, rooms[0], rooms[1], doors); // kitchen ↔ bedroom: the problem
      placeDoor(walls, gen, rooms[0], rooms[2], doors);
      placeDoor(walls, gen, rooms[1], rooms[2], doors);
      placeDoor(walls, gen, rooms[2], rooms[3], doors);
      placeEntrance(walls, gen, rooms[2], doors);
    },
    (gen, rs, openings) => {
      const c = (r: RoomDef) => doorsForRoom(r, openings);
      const [bed, kitchen, living, bath] = rs;
      return [
        against(gen, bed, c(bed), "west", 0.45, "bed", [1.5, 0.5, 2.0]),
        against(gen, bed, c(bed), "south", 0.8, "closet", [1.0, 2.0, 0.6]),
        inCorner(gen, kitchen, "north", "start", "kitchen_sink", [1.0, 0.9, 0.6]),
        against(gen, kitchen, c(kitchen), "north", 0.85, "fridge", [0.7, 1.8, 0.7]),
        // The cooking smell, already placed — this is the thing to contain.
        against(gen, kitchen, c(kitchen), "north", 0.55, "smell", [0.34, 0.5, 0.34], {
          category: "hvac", mount: "floor",
        }),
        against(gen, kitchen, c(kitchen), "west", 0.5, "return", VENT_SIZE, {
          category: "hvac", mount: "wall", y: ventMountY(H), flow: 0.02,
        }),
        against(gen, living, c(living), "east", 0.35, "couch", [1.8, 0.8, 0.85]),
        against(gen, living, c(living), "east", 0.8, "ac", [0.85, 0.32, 0.22], {
          category: "hvac", mount: "wall", y: H - 0.5, flow: 0.25,
        }),
        against(gen, bath, c(bath), "east", 0.5, "bathtub", [1.6, 0.6, 0.75]),
        against(gen, bath, c(bath), "west", 0.3, "toilet", [0.55, 0.75, 0.7]),
        against(gen, bath, c(bath), "east", 0.9, "return", VENT_SIZE, {
          category: "hvac", mount: "wall", y: ventMountY(H), flow: 0.02,
        }),
      ];
    },
  );
}

// ---------------------------------------------------------------------------

export const SCENARIOS: Record<ScenarioId, Scenario> = {
  design: {
    id: "design",
    title: "1 · Plan the apartment",
    outdoorTemp: 33,
    brief:
      "You're planning this apartment before moving in. The kitchen and bathroom " +
      "are fixed — the rest is one open space. Divide it so there's a bedroom " +
      "you can sleep in comfortably on a hot night, and so cooking and bathroom " +
      "smells don't drift into it.",
    youCanChange:
      "Draw interior walls, add or open doors and windows, and place the air conditioner.",
    tools: { movable: ["ac", "supply", "return", "fan"], addable: ["supply", "return"], walls: true, openings: true, resize: false },
    success:
      "A separate bedroom exists; bedroom ≤ 26 °C at 33 °C outdoors; contaminant " +
      "from kitchen in bedroom ≤ 0.12 while the kitchen still has an open exterior path.",
    build: buildShell,
  },
  twoRooms: {
    id: "twoRooms",
    title: "2 · Two bedrooms, one AC",
    outdoorTemp: 33,
    costBudget: 3.2,
    brief:
      "It's a hot afternoon and both bedrooms are in use. There's one air " +
      "conditioner. Make both bedrooms comfortable to be in — and nobody wants " +
      "air blowing straight onto a bed.",
    youCanChange: "Move the air conditioner and the fan, and open, close or move doors and windows.",
    tools: { movable: ["ac", "fan", "supply", "return"], addable: [], walls: false, openings: true, resize: false },
    // Measured on this layout at 33 °C outdoors. Start 29.9 / 28.5 — fails.
    // AC at maximum, doors open: 27.8 / 25.6 — solves ONE bedroom, which is the
    // point. Best found (AC moved to the north wall facing in, plus the fan on):
    // 24.5 / 25.3. So the goal is reachable but only by relocating the unit, not
    // by turning it up.
    success:
      "Both bedrooms ≤ 26 °C at 33 °C outdoors AND mean air speed over each bed ≤ 0.28 m/s.",
    build: buildRailroad,
  },
  smell: {
    id: "smell",
    title: "3 · Cooking smell next door",
    outdoorTemp: 31,
    brief:
      "You're cooking something strong-smelling, and the kitchen opens straight " +
      "onto the bedroom where someone is sleeping. Keep the smell out of the " +
      "bedroom — and don't leave the kitchen smelling all evening either.",
    youCanChange: "Move the extract vents, the AC and the fan, and open, close or move doors and windows.",
    tools: { movable: ["return", "supply", "ac", "fan", "smell"], addable: ["return", "supply", "fan"], walls: false, openings: true, resize: false },
    // Measured on this layout. Start: bedroom 0.279, living 0.187, no exterior
    // path — fails everything. Shutting the kitchen↔bedroom door alone drops the
    // bedroom to 0.077 and leaves the kitchen at 0.563: containment passed, the
    // second clause failed. Sealing EVERY kitchen door scores a perfect 0.000 in
    // both rooms and still fails, because there is then no way out — that is the
    // trap. Solved by shutting the kitchen's interior doors, opening its window
    // and running the extract: bedroom 0.022, living 0.049, path open.
    //
    // Note the kitchen's own level barely moves (0.558 → 0.487) whatever you do,
    // because the source is running continuously — so "has the kitchen cleared"
    // has to be scored as "is there a way out", not as a level.
    success:
      "Contaminant ≤ 0.12 in BOTH the bedroom and the living room (the smell is " +
      "confined to the kitchen) AND the kitchen has an open exterior opening.",
    build: buildAdjacency,
  },
};

export const SCENARIO_ORDER: ScenarioId[] = ["design", "twoRooms", "smell"];

/** Everything unlocked — the normal, non-study app. */
export const FREE_TOOLS: ScenarioTools = {
  movable: [],
  addable: [],
  walls: true,
  openings: true,
  resize: true,
};

/** `movable`/`addable` empty means "no restriction" outside a scenario. */
export function canMove(tools: ScenarioTools, type: string): boolean {
  return tools.movable.length === 0 || tools.movable.includes(type);
}
