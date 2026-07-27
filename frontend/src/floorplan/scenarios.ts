import { WINDOW_WIDTH, boundsOf, buildWalls, carveOpening, makeOpening } from "./geometry";
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

// Study scenarios — the four tasks agreed with Prof. Igarashi, one prebuilt home
// each, plus the exact set of controls that task is allowed to touch.
//
//   winter    Temperature in winter · DESIGN   — a small home; place the heater
//             and the fan so the far bedroom warms up. The bedroom window is the
//             cold source (it starts open). Buoyancy matters: warm air rises off
//             the heater, cold air sinks from the window — a 3D effect.
//   summer    Temperature in summer · RENTED   — a studio where the AC is bolted
//             to the wall blowing onto the bed. You cannot move it; you re-aim it
//             (angle up/away) and add a fan so the room cools evenly without a
//             draught on the bed.
//   humidity  Humidity / drying · DESIGN       — a bathroom; place a window and an
//             extract vent so the damp corner behind the tub dries (modelled as a
//             moisture source that has to be vented out).
//   smell     Kitchen smell · RENTED           — one open room with the bin, two
//             windows and an extract vent right next to one of them. Choose which
//             window to open and aim a fan; opening the near window short-circuits
//             with the vent, the far one sweeps the smell out.
//
// Naming convention (shown to the facilitator): "<home> · <task> · <type>".
//
// Design rules, both deliberate:
//  1. No task is solvable by one sentence — each has a second clause pulling
//     against the first, so a single goal leaves half of it failing.
//  2. Only the controls the task is about are shown; the home is already
//     furnished, so the furniture palette and (where irrelevant) the wall tool
//     are hidden.

export type ScenarioId = "winter" | "summer" | "humidity" | "smell";

export interface ScenarioTools {
  /** Item types the participant may MOVE (drag to a new position). */
  movable: string[];
  /** Item types the participant may RE-AIM (rotate + tilt) without moving —
   *  e.g. a wall-mounted AC in a rented home: fixed in place, but you set its
   *  louvre angle. `movable` items are always aimable too. */
  aimable: string[];
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
  /** Short label for the facilitator: "<home> · <task> · <type>". */
  title: string;
  /** Outdoor air temperature (°C) for this task. FIXED — the participant must
   *  not be able to change the weather, or a cooling/heating task is "solved" by
   *  dragging the outdoor slider. */
  outdoorTemp: number;
  /** Running-cost ceiling, or null if this task has no budget. */
  costBudget?: number;
  /** Read to the participant verbatim — comfort goal only, no physics. */
  brief: string;
  /** What the participant may change, in plain words, shown in the panel. */
  youCanChange: string;
  tools: ScenarioTools;
  /** Researcher-facing: what counts as done. Not shown to the participant.
   *  NOTE: thresholds are provisional until calibrated by running the sim. */
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
  // Interior doors start OPEN so the home is in a plausible everyday state.
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

const clampf = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Add an extra window to a room's wall AFTER assembly (placeWindows only makes
 *  one per room). `side` is which wall of the room; `frac` is 0..1 along it. */
function addWindow(plan: FloorPlan, roomId: string, side: "north" | "south" | "east" | "west", frac: number, open: boolean): void {
  const r = plan.rooms.find((x) => x.id === roomId);
  if (!r) return;
  const { x, z, w, d } = r.rect;
  const [axis, line, lo, hi] =
    side === "north" ? (["x", z + d, x, x + w] as const)
    : side === "south" ? (["x", z, x, x + w] as const)
    : side === "east" ? (["z", x + w, z, z + d] as const)
    : (["z", x, z, z + d] as const);
  const mid = lo + frac * (hi - lo);
  const s = clampf(mid - WINDOW_WIDTH / 2, lo + 0.2, hi - 0.2 - WINDOW_WIDTH);
  const o = makeOpening(`window-x-${roomId}-${side}`, "window", axis, line, s, s + WINDOW_WIDTH, [roomId, "outside"]);
  o.open = open;
  carveOpening(plan.walls, o);
  plan.windows.push(o);
}

/** Place an item in the CENTRE of a room (e.g. a couch in the middle). */
function centreItem(gen: IdGen, room: RoomDef, type: string, size: [number, number, number]): PlacedItem {
  const { x, z, w, d } = room.rect;
  return {
    id: gen(type),
    category: "furniture",
    type,
    roomId: room.id,
    position: [x + w / 2, size[1] / 2, z + d / 2],
    size,
    rotationY: 0,
    mount: "floor",
    movable: true,
  };
}

// ---------------------------------------------------------------- winter

/**
 * WINTER · DESIGN. A one-bedroom home like the pilot sketch: the bedroom sits
 * off the top-right of a big living-and-kitchen room. It is 2 °C outside; the
 * bedroom window is open and the cold is pouring in. The single heater lives in
 * the living room and has to reach the far bedroom — which only happens if the
 * cold window is closed, the door is open, and warm air is carried across (and
 * it rises, so where the heat starts vertically matters). Placing the heater
 * and a fan is the task.
 */
function buildWinter(): FloorPlan {
  const rooms = [
    room("living", "living", "Living + kitchen", 0, 4.0, 8.4, 3.6),
    room("bedroom", "bedroom", "Bedroom", 5.6, 0, 2.8, 4.0),
  ];
  const plan = assemble(
    "Single-bedroom home",
    rooms,
    (walls, gen, doors) => {
      placeDoor(walls, gen, rooms[0], rooms[1], doors);
      placeEntrance(walls, gen, rooms[0], doors);
    },
    (gen, rs, openings) => {
      const c = (r: RoomDef) => doorsForRoom(r, openings);
      const [living, bedroom] = rs;
      return [
        // Living + kitchen: couch in the MIDDLE; kitchen in the top-left corner
        // (sink, fridge and the extract vent); TV on the right-hand wall.
        centreItem(gen, living, "couch", [1.8, 0.8, 0.85]),
        inCorner(gen, living, "south", "start", "kitchen_sink", [1.0, 0.9, 0.6]),
        against(gen, living, c(living), "south", 0.22, "fridge", [0.7, 1.8, 0.7]),
        against(gen, living, c(living), "south", 0.06, "return", VENT_SIZE, {
          category: "hvac", mount: "wall", y: ventMountY(H), flow: 0.02,
        }),
        against(gen, living, c(living), "east", 0.5, "tv", [1.4, 0.8, 0.1], { mount: "wall", y: 1.0 }),
        // Bedroom (a tall room): bed in the corner against the walls, desk along
        // a wall, closet in a corner. NO heater or fan — the participant PLACES
        // those (the whole point of the design task).
        inCorner(gen, bedroom, "south", "end", "bed", [1.4, 0.5, 2.0]),
        against(gen, bedroom, c(bedroom), "west", 0.5, "desk", [1.2, 0.75, 0.6]),
        inCorner(gen, bedroom, "north", "start", "closet", [0.9, 2.0, 0.6]),
      ];
    },
    { windows: false },
  );
  // A window on the living room's right-hand wall and one in the bedroom — both
  // start CLOSED (like every window in these tasks).
  addWindow(plan, "living", "east", 0.85, false);
  addWindow(plan, "bedroom", "east", 0.75, false);
  return plan;
}

// ---------------------------------------------------------------- summer

/**
 * SUMMER · RENTED. A studio. The AC is fixed high on the east wall, blowing
 * straight west onto the bed — the classic bad placement. You cannot move it,
 * only re-aim it (angle it up / away) and add a fan, so the room cools evenly
 * without a draught on the sleeper.
 */
function buildStudio(): FloorPlan {
  const rooms = [room("studio", "bedroom", "Studio", 0, 0, 4.2, 5.0)];
  return assemble(
    "Studio apartment",
    rooms,
    (walls, gen, doors) => {
      placeEntrance(walls, gen, rooms[0], doors);
    },
    (gen, rs, openings) => {
      const c = (r: RoomDef) => doorsForRoom(r, openings);
      const [studio] = rs;
      return [
        against(gen, studio, c(studio), "west", 0.5, "bed", [1.5, 0.5, 2.0]),
        inCorner(gen, studio, "north", "end", "closet", [1.0, 2.0, 0.6]),
        against(gen, studio, c(studio), "south", 0.35, "desk", [1.2, 0.75, 0.6]),
        // AC on the EAST wall, facing WEST (rotationY from `against(east)`), i.e.
        // straight at the bed. Fixed in place — the participant re-aims it.
        against(gen, studio, c(studio), "east", 0.5, "ac", [0.85, 0.32, 0.22], {
          category: "hvac", mount: "wall", y: H - 0.5, flow: 0.25, on: true,
        }),
        against(gen, studio, c(studio), "south", 0.8, "fan", [0.45, 1.3, 0.45], {
          category: "hvac", mount: "floor", flow: 0, on: false,
        }),
      ];
    },
  );
}

// ---------------------------------------------------------------- humidity

/**
 * HUMIDITY · DESIGN. A single bathroom: tub, toilet, wash basin. The far corner
 * behind the tub stays wet (a moisture source, modelled with the contaminant
 * field). No window and no vent yet — the participant places one window and one
 * extract vent, and finds that placing them too close lets the air short-circuit
 * and the corner never dries.
 */
function buildBathroom(): FloorPlan {
  const rooms = [room("bathroom", "bathroom", "Bathroom", 0, 0, 3.0, 3.4)];
  return assemble(
    "Bathroom",
    rooms,
    (walls, gen, doors) => {
      placeEntrance(walls, gen, rooms[0], doors);
    },
    (gen, rs, openings) => {
      const c = (r: RoomDef) => doorsForRoom(r, openings);
      const [bath] = rs;
      return [
        against(gen, bath, c(bath), "east", 0.6, "bathtub", [1.6, 0.6, 0.75]),
        against(gen, bath, c(bath), "west", 0.25, "toilet", [0.55, 0.75, 0.7]),
        against(gen, bath, c(bath), "west", 0.72, "sink", [0.7, 0.9, 0.55]),
        // Damp corner behind the tub — moisture that must be vented out. Uses the
        // contaminant ("smell") field as a stand-in for humidity.
        inCorner(gen, bath, "north", "end", "smell", [0.34, 0.5, 0.34], { category: "hvac", mount: "floor" }),
      ];
    },
    { windows: false }, // the participant places the window
  );
}

// ---------------------------------------------------------------- smell

/**
 * SMELL · RENTED. One open room — bed, desk, kitchen with the bin. TWO windows,
 * and the extract vent is right next to the FIRST one. Opening the near window
 * short-circuits with the vent (air in and straight back out); the far window
 * sets up a cross-draught that sweeps the smell out. The participant chooses
 * which window to open and aims a fan; nothing structural moves.
 */
function buildSmell(): FloorPlan {
  const rooms = [room("apt", "kitchen", "One-room apartment", 0, 0, 5.0, 4.2)];
  const plan = assemble(
    "One-room apartment",
    rooms,
    (walls, gen, doors) => {
      placeEntrance(walls, gen, rooms[0], doors);
    },
    (gen, rs, openings) => {
      const c = (r: RoomDef) => doorsForRoom(r, openings);
      const [apt] = rs;
      return [
        against(gen, apt, c(apt), "north", 0.3, "bed", [1.5, 0.5, 2.0]),
        against(gen, apt, c(apt), "west", 0.5, "desk", [1.2, 0.75, 0.6]),
        inCorner(gen, apt, "south", "start", "kitchen_sink", [1.0, 0.9, 0.6]),
        against(gen, apt, c(apt), "south", 0.55, "fridge", [0.7, 1.8, 0.7]),
        // the bin — the smell source — by the kitchen
        against(gen, apt, c(apt), "south", 0.72, "smell", [0.34, 0.5, 0.34], { category: "hvac", mount: "floor" }),
        // extract vent high on the NORTH wall, next to window #1 (added below)
        against(gen, apt, c(apt), "north", 0.82, "return", VENT_SIZE, {
          category: "hvac", mount: "wall", y: ventMountY(H), flow: 0.02,
        }),
        // a fan the participant can aim
        against(gen, apt, c(apt), "west", 0.85, "fan", [0.45, 1.3, 0.45], {
          category: "hvac", mount: "floor", flow: 0, on: false,
        }),
      ];
    },
    { windows: false },
  );
  // window #1 on the NORTH wall next to the vent (the short-circuit trap);
  // window #2 on the far SOUTH wall (the cross-draught). Both start closed —
  // the participant chooses which to open.
  addWindow(plan, "apt", "north", 0.82, false);
  addWindow(plan, "apt", "south", 0.5, false);
  return plan;
}

// ---------------------------------------------------------------------------

export const SCENARIOS: Record<ScenarioId, Scenario> = {
  winter: {
    id: "winter",
    title: "Single-bedroom home · Temperature (winter) · Design",
    outdoorTemp: 2,
    brief:
      "It's 2 °C outside and the bedroom is freezing — the cold pours in through " +
      "its window. There's one heater, in the living room. Get the bedroom warm " +
      "and comfortable without letting the living room get cold.",
    youCanChange: "Place the heater and the fan, and open, close or move doors and windows.",
    tools: { movable: ["heater", "fan"], aimable: [], addable: ["heater", "fan"], walls: false, openings: true, resize: false },
    success:
      "Bedroom ≥ 18 °C at 2 °C outdoors while the living room stays ≥ 18 °C too — " +
      "reached by closing the bedroom window, keeping the door open and carrying " +
      "the heat across, not by one action.",
    build: buildWinter,
  },
  summer: {
    id: "summer",
    title: "Studio · Temperature (summer) · Rented",
    outdoorTemp: 33,
    brief:
      "It's a hot afternoon. The air conditioner is fixed to the wall and blows " +
      "straight onto the bed, so it's a cold draught all night. Cool the whole " +
      "room evenly and keep the air over the bed calm.",
    youCanChange: "Aim the air conditioner (you can't move it), and add, move and aim a fan.",
    tools: { movable: ["fan"], aimable: ["ac"], addable: ["fan"], walls: false, openings: true, resize: false },
    success:
      "Studio ≤ 26 °C at 33 °C outdoors AND mean air speed in the bed zone ≤ 0.25 m/s — " +
      "reached by angling the AC up/away and using the fan to mix, not by blasting the bed.",
    build: buildStudio,
  },
  humidity: {
    id: "humidity",
    title: "Bathroom · Humidity · Design",
    outdoorTemp: 24,
    brief:
      "The corner behind the bathtub stays wet after every shower and grows " +
      "mould. Add one window and one extract vent so that damp corner dries out.",
    youCanChange: "Place an extract vent, and add a window; open, close or move doors and windows.",
    tools: { movable: ["return"], aimable: [], addable: ["return"], walls: false, openings: true, resize: false },
    success:
      "Moisture in the tub corner cleared (contaminant ≤ 0.12) with an open path " +
      "to outside — and NOT solved by putting the window and vent so close they " +
      "short-circuit past the corner.",
    build: buildBathroom,
  },
  smell: {
    id: "smell",
    title: "One-room apartment · Smell · Rented",
    outdoorTemp: 31,
    brief:
      "The kitchen bin smells and your bed is in the same open room. There are " +
      "two windows and an extract vent. Keep the smell away from the bed.",
    youCanChange: "Open or close either window, and add, move and aim a fan.",
    tools: { movable: ["fan"], aimable: [], addable: ["fan"], walls: false, openings: true, resize: false },
    success:
      "Contaminant ≤ 0.12 in the bed zone with an open exterior path — reached by " +
      "opening the FAR window (cross-draught), not the near one (which short-" +
      "circuits with the vent).",
    build: buildSmell,
  },
};

export const SCENARIO_ORDER: ScenarioId[] = ["winter", "summer", "humidity", "smell"];

/** Everything unlocked — the normal, non-study app. */
export const FREE_TOOLS: ScenarioTools = {
  movable: [],
  aimable: [],
  addable: [],
  walls: true,
  openings: true,
  resize: true,
};

/** `movable` empty means "no restriction" outside a scenario. */
export function canMove(tools: ScenarioTools, type: string): boolean {
  return tools.movable.length === 0 || tools.movable.includes(type);
}

/** Whether an item can be RE-AIMED (rotate + tilt). Movable items always can;
 *  `aimable` adds items that are fixed in place but still adjustable (a rented
 *  AC). Outside a scenario (movable empty) everything is aimable. */
export function canAim(tools: ScenarioTools, type: string): boolean {
  return canMove(tools, type) || tools.aimable.includes(type);
}
