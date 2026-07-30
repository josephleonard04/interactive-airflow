import { DOOR_WIDTH, WINDOW_WIDTH, boundsOf, buildWalls, carveOpening, makeOpening } from "./geometry";
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
import type { FloorPlan, Opening, PlacedItem, RoomDef, Vec3 } from "./types";
// Type-only, so it is erased at build time and cannot close the import loop
// with the store (which imports this module for the scenario table).
import type { SimMode } from "../scene/store";

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
  /** Open / close doors and windows, and drag the ones that aren't `fixed`. */
  openings: boolean;
  /** Offer "add" / "remove" for openings. False = the set of openings is what
   *  the build gave you; you may reposition an unfixed one but not delete it or
   *  cut a new one. Undefined behaves as true (the unrestricted app). */
  editOpeningSet?: boolean;
  /** Change the home's footprint. */
  resize: boolean;
  /** Hide the on/off + low/medium/high control. Use when the task is about
   *  WHERE a device goes: an exposed dial invites "turn it up" as a substitute
   *  for placement, and turning it up is usually the wrong lesson. */
  lockPower?: boolean;
}

/** One checkable line of the task, shown as a tick-box the participant watches.
 *  A prose verdict ("Bedroom is 15.7 °C — not warm enough. Aim for 21 °C or
 *  above — add a heater there…") buries the answer in advice and has to be
 *  re-read every run; a tick-box answers "am I done yet?" at a glance and keeps
 *  the goal on screen the whole time instead of only after a check. */
export interface ScenarioGoal {
  /** Shown next to the tick-box. Phrased as the thing to achieve. */
  label: string;
  /** What to measure. */
  /** `drying` is measured in MINUTES and scored on the slowest corner of the
   *  room — how long it stays wet after a shower, which is the question people
   *  actually ask about a bathroom. The others are levels, not durations. */
  metric: "temperature" | "smell" | "draft" | "drying";
  /** Room it is measured in. Ignored when `nearItem` is set. */
  roomId: string;
  /** Measure over the footprint of this item type instead of the whole room —
   *  a draught is felt where you lie, not averaged over the floor, and in a
   *  studio a room-mean smell cannot tell the bed from the bin two metres away.
   *  Applies to `draft` and `smell` goals. */
  nearItem?: string;
  /** Extra condition on a room temperature goal: the strip of floor just inside
   *  the room's exterior window must ALSO be at least this warm.
   *
   *  A room mean can sit at a comfortable 23 °C while the air spilling off the
   *  glass is near freezing — that cold pool by the window is the thing a
   *  radiator under it exists to kill, and it is invisible to a room average.
   *  It rides on the existing "is the room comfortable" line rather than being a
   *  goal of its own: it is not a separate thing to achieve, it is part of what
   *  makes a room comfortable to sit in, and a third tick-box spelling it out
   *  hands over half the answer. */
  windowAtLeast?: number;
  /** Pass when the value is at least / at most this. °C for temperature,
   *  0..1 for smell, m/s for draft.
   *
   *  COMFORT IS A BAND, NOT A FLOOR. `atLeast` alone let 29 °C tick a box
   *  labelled "warm enough", which is not a comfortable room — it is an
   *  overheated one, and it let a participant pass by turning the heater to
   *  maximum, the exact instinct this task exists to challenge. Temperature
   *  goals set both bounds. */
  atLeast?: number;
  atMost?: number;
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
  /** The task, as tick-boxes the participant can watch. Omitted = no checklist. */
  goals?: ScenarioGoal[];
  /** Which of the four simulation views this task offers, in order. Omitted =
   *  all of them. A task about moisture has no business showing a noise tab:
   *  every view that cannot answer the question is one more thing to try and
   *  rule out before starting. The contamination view is labelled from the goal
   *  it serves — "Humidity" here, "Smell" elsewhere. */
  views?: SimMode[];
  /** Per-task airflow-visualization tuning. Line density is a per-task judgement
   *  — a two-room home with a doorway path needs far fewer lines to read clearly
   *  than a single room does — so it is set here rather than globally. Omitted =
   *  VIZ_DEFAULT. (Obstacle/wall clipping is NOT tunable: a line through a couch
   *  is wrong everywhere.) */
  viz?: { maxSeeds?: number };
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

const room = (
  id: string,
  type: RoomDef["type"],
  name: string,
  x: number,
  z: number,
  w: number,
  d: number,
  /** Pin the name against auto-naming. Rooms are normally named from what is
   *  standing in them, which is right for a home someone is designing and wrong
   *  for a task whose whole point is that one room is several things at once:
   *  the studio has a fridge and a sink in it, so the moment anything was moved
   *  it renamed itself "Kitchen" — on the panel, and on the sketch map where the
   *  participant is being asked to draw on their bedroom. */
  fixedName = false,
): RoomDef => ({
  id,
  type,
  name,
  rect: { x, z, w, d },
  ...(fixedName ? { renamed: true } : {}),
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

/** Place an item at exact room coordinates with an exact yaw — for the cases
 *  the wall helpers cannot express, e.g. a bed lying along the near wall with
 *  its headboard against the LEFT one. `against`/`inCorner` derive the yaw from
 *  the wall they attach to, so neither can turn an item a quarter-turn out of
 *  that. */
function spot(
  gen: IdGen,
  room: RoomDef,
  type: string,
  size: Vec3,
  x: number,
  z: number,
  rotationY: number,
  opts: { category?: PlacedItem["category"]; mount?: PlacedItem["mount"]; y?: number; flow?: number; on?: boolean } = {},
): PlacedItem {
  const mount = opts.mount ?? "floor";
  return {
    id: gen(type),
    category: opts.category ?? "furniture",
    type,
    roomId: room.id,
    position: [x, mount === "floor" ? size[1] / 2 : opts.y ?? 1.1, z],
    size,
    rotationY,
    mount,
    flow: opts.flow,
    ...(opts.on !== undefined ? { on: opts.on } : {}),
    movable: true,
  };
}

/** Place an item in the CENTRE of a room (e.g. a couch in the middle), facing a
 *  given yaw (default 0). Math.PI/2 faces +x (screen-right / east). */
function centreItem(gen: IdGen, room: RoomDef, type: string, size: [number, number, number], rotationY = 0): PlacedItem {
  const { x, z, w, d } = room.rect;
  return {
    id: gen(type),
    category: "furniture",
    type,
    roomId: room.id,
    position: [x + w / 2, size[1] / 2, z + d / 2],
    size,
    rotationY,
    mount: "floor",
    movable: true,
  };
}

/** Put the entrance on a room's NORTH wall (largest z = screen-bottom), rather
 *  than letting placeEntrance pick the longest exterior wall (which lands on the
 *  top edge here, because buildWalls flags the shared south wall exterior). */
function entranceOnBottom(walls: ReturnType<typeof buildWalls>, gen: IdGen, roomId: string, rect: RoomDef["rect"], doors: Opening[], frac = 0.5): void {
  const cx = clampf(rect.x + frac * rect.w, rect.x + DOOR_WIDTH, rect.x + rect.w - DOOR_WIDTH);
  const ent = makeOpening(gen("door"), "door", "x", rect.z + rect.d, cx - DOOR_WIDTH / 2, cx + DOOR_WIDTH / 2, [roomId, "outside"]);
  carveOpening(walls, ent);
  doors.push(ent);
}

/** The same, on the room's SOUTH wall (smallest z = screen-top). */
function entranceOnTop(walls: ReturnType<typeof buildWalls>, gen: IdGen, roomId: string, rect: RoomDef["rect"], doors: Opening[], frac = 0.5): void {
  const cx = clampf(rect.x + frac * rect.w, rect.x + DOOR_WIDTH, rect.x + rect.w - DOOR_WIDTH);
  const ent = makeOpening(gen("door"), "door", "x", rect.z, cx - DOOR_WIDTH / 2, cx + DOOR_WIDTH / 2, [roomId, "outside"]);
  carveOpening(walls, ent);
  doors.push(ent);
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
    room("living", "living", "Living + kitchen", 0, 4.2, 7.0, 3.8),
    room("bedroom", "bedroom", "Bedroom", 3.6, 0, 3.4, 4.2),
  ];
  const plan = assemble(
    "Single-bedroom home",
    rooms,
    (walls, gen, doors) => {
      placeDoor(walls, gen, rooms[0], rooms[1], doors);
      entranceOnBottom(walls, gen, "living", rooms[0].rect, doors, 0.22); // bottom wall, toward the left
    },
    (gen, rs, openings) => {
      const c = (r: RoomDef) => doorsForRoom(r, openings);
      const [living, bedroom] = rs;
      return [
        // Living + kitchen. Kitchen in the top-left corner: FRIDGE in the corner,
        // SINK next to it, and the extract vent on the wall above the sink.
        inCorner(gen, living, "south", "start", "fridge", [0.7, 1.8, 0.7]),
        against(gen, living, c(living), "south", 0.24, "kitchen_sink", [1.0, 0.9, 0.6]),
        against(gen, living, c(living), "south", 0.24, "return", VENT_SIZE, {
          category: "hvac", mount: "wall", y: ventMountY(H), flow: 0.25,
        }),
        // TV centred (middle) and high on the right-hand wall; couch in the middle
        // FACING the TV (east). A window on the bottom wall near the TV corner.
        against(gen, living, c(living), "east", 0.5, "tv", [1.4, 0.8, 0.1], { mount: "wall", y: 1.5 }),
        centreItem(gen, living, "couch", [1.8, 0.8, 0.85], Math.PI / 2),
        // The one heater and the one fan, delivered and left TOGETHER in the
        // near-left corner of the living room, just inside the front door —
        // where a delivery would actually be dropped, and a poor spot to heat
        // from. They start OUT of the way rather than pre-solved, so where they
        // end up is entirely the participant's call. Both run on medium and the
        // power control is hidden: this task is about WHERE the heat goes, and
        // leaving the dial exposed invites "turn it up" as a substitute for
        // thinking about placement.
        inCorner(gen, living, "north", "start", "heater", [0.8, 0.5, 0.18], {
          category: "hvac", mount: "floor", flow: 0, on: true,
        }),
        // Beside it, against the left wall — same corner, clear of the heater's
        // footprint so neither gets nudged away by the overlap pass.
        against(gen, living, c(living), "west", 0.8, "fan", [0.45, 1.3, 0.45], {
          category: "hvac", mount: "floor", flow: 0, on: true,
        }),
        // Bedroom (bigger, tall). Bed in the corner against the walls, desk in a
        // corner, closet in a corner. NO heater or fan — the participant places
        // those (the whole point of the design task).
        inCorner(gen, bedroom, "south", "start", "bed", [1.5, 0.5, 2.0]),
        inCorner(gen, bedroom, "east", "end", "desk", [1.2, 0.75, 0.6]),
        inCorner(gen, bedroom, "south", "end", "closet", [0.9, 2.0, 0.6]),
      ];
    },
    { windows: false },
  );
  // Living window on the bottom wall near the TV (east) corner; bedroom window on
  // its right wall. Both start CLOSED (like every window in these tasks).
  addWindow(plan, "living", "north", 0.8, false);
  addWindow(plan, "bedroom", "east", 0.5, false);
  // The whole envelope is pinned — doors and every window. This task is about
  // where the heat goes, not about redesigning the building, and leaving the
  // glazing draggable gave the participant a second, unrelated puzzle to solve
  // at the same time. Openings can still be opened and closed.
  for (const o of [...plan.doors, ...plan.windows]) o.fixed = true;
  return plan;
}

// ---------------------------------------------------------------- summer

/**
 * SUMMER · RENTED. A studio, 8 m across by 6 m deep, where the kitchen and the
 * bed share one room. It is hot and the food waste in the kitchen bin has
 * started to smell, and the participant has to sleep in there tonight.
 *
 * The layout puts the two things that must not meet as far apart as the room
 * allows — bed in the near-left corner, kitchen diagonally opposite in the
 * far-right — and then gives exactly three levers: which windows are open, and
 * where a portable fan stands and which way it points. The extract vent over
 * the kitchen runs the whole time and is not the participant's to touch.
 *
 * The tension the task is built on: a hot night wants moving air over the bed,
 * and the cheapest way to get it is to stand the fan by the kitchen and blow
 * across the room — which walks the smell straight onto the pillow. Air has to
 * arrive at the bed from the window side and leave past the kitchen into the
 * vent, which is a different arrangement from the obvious one.
 */
function buildStudio(): FloorPlan {
  // 6.4 × 4.8 — the same 4:3 proportions, scaled down to a studio someone would
  // actually rent. At 8 × 6 the two ends were far enough apart that the bin was
  // barely a problem from the bed.
  const rooms = [room("studio", "bedroom", "Studio", 0, 0, 6.4, 4.8, true)];
  const plan = assemble(
    "Studio apartment",
    rooms,
    (walls, gen, doors) => {
      // Front door on the SOUTH wall (screen-top), over on the left so it does
      // not land in the kitchen corner.
      entranceOnTop(walls, gen, "studio", rooms[0].rect, doors, 0.4);
    },
    (gen, rs, openings) => {
      const c = (r: RoomDef) => doorsForRoom(r, openings);
      const [studio] = rs;
      return [
        // Sleeping end, along the near wall (screen-bottom). The bed keeps its
        // ordinary 1.5 × 2.0 proportions and is TURNED a quarter-turn instead of
        // being reshaped: the model puts the headboard and pillows at its local
        // −z, so yaw = π/2 lays it along the wall with the pillows against the
        // left-hand wall. Reshaping it to 2.0 × 1.5 would have drawn a 2 m-wide
        // headboard, which is a different piece of furniture.
        spot(gen, studio, "bed", [1.5, 0.5, 2.0], 1.06, 3.99, Math.PI / 2),
        inCorner(gen, studio, "north", "end", "closet", [1.0, 2.0, 0.6]),
        // Desk in the far-left corner (screen top-left).
        inCorner(gen, studio, "south", "start", "desk", [1.2, 0.75, 0.6]),
        // Kitchen along the far wall, running right to left: fridge in the
        // corner, sink beside it, bin at the end of the run.
        inCorner(gen, studio, "south", "end", "fridge", [0.7, 1.8, 0.7]),
        against(gen, studio, c(studio), "south", 0.78, "kitchen_sink", [1.0, 0.9, 0.6]),
        spot(gen, studio, "bin", [0.4, 0.7, 0.4], 4.0, 0.26, 0),
        // …and the smell itself, just in front of the bin. Placed by hand rather
        // than against the wall: the overlap pass shoulders two floor items
        // apart along the wall, which left the source a half-metre to one SIDE
        // of the bin it is supposed to be coming out of.
        spot(gen, studio, "smell", [0.34, 0.5, 0.34], 4.0, 0.85, 0, { category: "hvac" }),
        // Extract vent high on the wall above the SINK, where a kitchen hood
        // goes. Always running — the task is about where the air comes FROM, not
        // whether the vent is on.
        against(gen, studio, c(studio), "south", 0.78, "return", VENT_SIZE, {
          category: "hvac", mount: "wall", y: ventMountY(H), flow: 0.06, on: true,
        }),
        // The flat's air conditioner, high on the right-hand wall down at the
        // sleeping end — and OFF, which the brief explains. It is here because a
        // rented studio has one, and because the first thing anyone reaches for
        // on a hot night is the AC: the task is what you do when that is not an
        // option. Not movable, not aimable, no power control.
        against(gen, studio, c(studio), "east", 0.75, "ac", [0.85, 0.32, 0.22], {
          category: "hvac", mount: "wall", y: H - 0.5, flow: 0.25, on: false,
        }),
        // NO FAN. The participant adds one from the palette and decides where it
        // goes — "where would you even put it" is the question being asked.
      ];
    },
    { windows: false },
  );
  // Two windows, both starting closed. One on the RIGHT wall — the trap, since
  // the air it lets in is drawn along the kitchen wall to the extract without
  // ever reaching the bed. One on the NEAR wall (screen-bottom) beside the bed,
  // which sweeps the room from the sleeping end toward the kitchen.
  addWindow(plan, "studio", "east", 0.35, false);
  addWindow(plan, "studio", "north", 0.5, false);
  for (const o of [...plan.doors, ...plan.windows]) o.fixed = true;
  return plan;
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
  // 3.6 × 4.2. The old 3.0 × 3.4 was a cupboard: with a tub down one side there
  // was barely a metre of floor left, so "where does the vent go" had almost no
  // room to be a question, and every answer short-circuited with every other.
  const rooms = [room("bathroom", "bathroom", "Bathroom", 0, 0, 3.6, 4.2, true)];
  const plan = assemble(
    "Bathroom",
    rooms,
    (walls, gen, doors) => {
      // Door on the SOUTH wall (screen-top), toward the left.
      entranceOnTop(walls, gen, "bathroom", rooms[0].rect, doors, 0.28);
    },
    (gen, rs, openings) => {
      const c = (r: RoomDef) => doorsForRoom(r, openings);
      const [bath] = rs;
      return [
        // A real bathroom's wet half and dry half. Tub along the right-hand
        // wall, shower boxed into the far-right corner beyond it, toilet and
        // basin down the left where you can reach them from the door.
        against(gen, bath, c(bath), "east", 0.62, "bathtub", [1.6, 0.6, 0.75]),
        inCorner(gen, bath, "south", "end", "shower", [0.9, 2.0, 0.9]),
        against(gen, bath, c(bath), "west", 0.42, "toilet", [0.55, 0.75, 0.7]),
        against(gen, bath, c(bath), "west", 0.82, "sink", [0.7, 0.9, 0.55]),
        // The damp corner — behind the tub, at the far end from the door, which
        // is where the air is stillest and where the black mould actually grows.
        // Modelled with the contaminant field standing in for moisture.
        inCorner(gen, bath, "north", "end", "damp", [0.5, 0.5, 0.5], { category: "hvac", mount: "floor" }),
        // ONE extract vent, already fitted and running, and the participant's to
        // move: this task is "where does it go", not "should there be one".
        against(gen, bath, c(bath), "south", 0.5, "return", VENT_SIZE, {
          category: "hvac", mount: "wall", y: ventMountY(H), flow: 0.05, on: true,
        }),
      ];
    },
    { windows: false },
  );
  // ONE window, and NOT fixed — a window can be dragged to any wall of its own
  // room (moveOpeningToPoint), which is exactly the choice this task is about.
  // Starts shut, and starts on the RIGHT-HAND wall a metre from the extract:
  // the pair as-built is the bad arrangement, so simply opening the window is
  // not the answer. Left where it was — diagonally opposite the vent — merely
  // opening it dried the room in 32 minutes and the placement question never
  // came up.
  addWindow(plan, "bathroom", "east", 0.2, false);
  for (const d of plan.doors) d.fixed = true;
  return plan;
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
    // WHY THE PARTICIPANT MAY MOVE WINDOWS. "You rent this place" cannot justify
    // repositioning glazing, so the task is set at the moment when that really is
    // still an open choice: the home is built and the walls and doors are fixed
    // by the structure, but the glazing has not been fitted yet. That is how a
    // real build runs — the structural plan is frozen long before the window
    // schedule is — and it is also the moment a buyer is actually asked where
    // they want the windows.
    // No number in the brief. "It's 2 °C outside" is a reading, and a reading is
    // the one thing this tool is supposed to be explaining to someone who does
    // not think in degrees; it also invites arithmetic against the comfort band.
    // The weather is a fact of the task, said the way a person would say it.
    brief:
      "It's very cold outside and you've just moved into this newly built home. The " +
      "heater and the fan were delivered and left by the kitchen, inside the " +
      "front door. Glass is where a home leaks its heat, and right now the cold " +
      "is pouring off the windows. Get both rooms warm enough to live in.",
    youCanChange:
      "Move the heater and the fan anywhere, aim the fan, and open or close the doors and windows. " +
      "Both run on medium. The walls, doors and windows are already built.",
    tools: { movable: ["heater", "fan"], aimable: ["fan"], addable: [], walls: false, openings: true, editOpeningSet: false, resize: false, lockPower: true },
    // Bands, not floors. Living rooms sit in the ASHRAE 55 winter comfort zone
    // (~20–24 °C); a bedroom is conventionally kept cooler, so it takes the WHO
    // healthy-home minimum of 18 °C as its floor and shares the 24 °C ceiling.
    // Measured across 30 heater placements/powers, exactly three configurations
    // satisfy both — all of them medium power with the heat delivered toward
    // the doorway. Every high-power setting overshoots and now fails, which is
    // the point: cranking it is not a solution.
    // Thresholds stay out of the label. A participant who reads "18–24 °C" starts
    // optimising toward a number instead of judging whether the home looks warm,
    // and the number is what the tool is supposed to be explaining to them.
    // The bands are still enforced — they are just not the interface.
    // THE WINDOW STRIP IS WHAT MAKES THE PLACEMENT MATTER. On room means alone a
    // heater parked on the far wall by the TV passed both boxes, and so did
    // mid-room and beside-the-doorway — a room mean cannot see the cold pool
    // spilling off the glass, so almost any placement "solved" the task and the
    // one real-world answer (a heater under the window) was indistinguishable
    // from the rest. Measured at the glass, over a 4x3x4 sweep of fan position
    // and aim, best case for each heater spot:
    //     under the window     26.3        1 m off the window   18.1
    //     far wall by the TV   16.7        beside the doorway   16.2
    //     mid-room             16.1        as delivered         15.5
    // 19 °C therefore separates "the heater is at the glass" from everything
    // else with ~7 °C of headroom, and no fan trick closes the gap. It hangs off
    // the living-room line rather than adding a third one — see windowAtLeast.
    goals: [
      { label: "Bedroom is comfortable", metric: "temperature", roomId: "bedroom", atLeast: 18, atMost: 24 },
      {
        label: "Living + kitchen is comfortable",
        metric: "temperature",
        roomId: "living",
        atLeast: 20,
        atMost: 24,
        windowAtLeast: 19,
      },
    ],
    viz: { maxSeeds: 8 },
    // Measured on this layout at 2 °C outdoors (living / bedroom), with cold
    // glazing modelled. THREE levers, and medium power needs at least two of them.
    //
    // Heater placement (medium, fan aimed through the doorway):
    //   far-left corner       18.0 /  9.1   bedroom fails badly
    //   under the living window 18.1 / 14.6  still fails — see note below
    //   beside the doorway    18.5 / 17.3   close, but short
    // Window handling (heater at the doorway, medium, fan on):
    //   bedroom window as-built   17.3
    //   slid to the far end       18.0   PASS — cold zone away from the doorway
    //   bedroom window removed    19.5   PASS — no glazing, no loss
    // Power:
    //   HIGH at the doorway + fan  22.3 / 21.0  PASS without touching the glazing
    //
    // NOTE on "put the heater under the window", which is the real-world instinct
    // and a correct one — but for COMFORT, not for mean temperature. A radiator
    // under glazing cancels the cold downdraught you would feel sitting there; it
    // actually loses slightly more energy, and it does nothing for a room down the
    // hall. Here it measures worse (14.6 vs 17.3) because the heater ends up both
    // in the coldest part of the room and furthest from the doorway the warmth has
    // to travel through. Worth watching in the study: participants who reason this
    // way are right about buildings and wrong about this goal.
    success:
      "Both rooms inside their comfort bands, and the living-room line also " +
      "requires ≥ 19 °C in the strip of floor inside its window, at 2 °C " +
      "outdoors. Only the heater under that window clears the window condition " +
      "(26.3 °C there, against 16–17 °C from anywhere else), and it needs the " +
      "fan in the right-hand half of the living room to carry the warmth " +
      "through the doorway — with the fan left over by the kitchen the bedroom " +
      "lands at 17.4 °C and fails.",
    build: buildWinter,
  },
  summer: {
    id: "summer",
    title: "Studio · Hot night, kitchen smell · Rented",
    outdoorTemp: 31,
    brief:
      "It's hot, and the food waste in the kitchen bin has started to smell. " +
      "The bed and the kitchen share one room, and you have to sleep in there " +
      "tonight. The air conditioner is broken and the landlord can't come until " +
      "next week. Keep the smell away from the bed.",
    youCanChange:
      "Add a fan, then move it and aim it anywhere. Open or close either window. " +
      "The kitchen's extract vent runs all night and can't be switched off, and " +
      "the air conditioner doesn't work.",
    tools: { movable: ["fan"], aimable: ["fan"], addable: ["fan"], walls: false, openings: true, editOpeningSet: false, resize: false, lockPower: true },
    // TWO GOALS THAT PULL APART. A hot night wants air moving over the bed, and
    // the obvious way to get it — stand the fan in the middle and sweep — walks
    // the bin's smell across the pillow on the way. The pair can only be
    // satisfied by air that arrives at the bed from the window and leaves past
    // the kitchen into the extract, which is not the arrangement anyone reaches
    // for first.
    //
    // Both are measured over the BED's footprint, not the room: this is a
    // single open room, so a room mean cannot tell the sleeping end from the
    // cooking end and would call every layout identical.
    // ONE GOAL: keep the smell off the bed. The short-circuit is the whole
    // lesson, and it is what the numbers say. Doing nothing but opening a
    // window, smell over the bed:
    //     everything shut         0.303
    //     RIGHT-hand window       0.284   — 6% better, i.e. nothing
    //     BOTTOM window (the bed) 0.146   — 52% better
    // The right-hand window sits about 2 m from the kitchen extract, so the air
    // it lets in is pulled straight along the kitchen wall and back out of the
    // vent without ever crossing the room. The bottom window is the far end of
    // the same path, so its air has to traverse the whole studio — past the bed
    // first — before it reaches the extract. That is the difference between the
    // two, and it is why one of them does nothing.
    //
    // Threshold 0.15. Nothing you can do with the windows ALONE reaches it, so
    // the fan is genuinely required, and every wrong window choice is shut out.
    // Measured over the 54 spots a fan physically fits in (the editor forbids
    // standing one on the bed) × 8 aims:
    //     everything shut, no fan        0.307
    //     right-hand window only         0.300      the short circuit
    //     BOTH windows open              0.164      the right one adds nothing
    //     bottom window only, no fan     0.162
    //     right-hand window + fan        0.327      worse than doing nothing
    //     bottom window + fan near the bed, aimed at the extract   0.140
    //     bottom window + fan at that window, sweeping the bed     0.095
    // Opening both is not a way round it: the right-hand window sits ~2 m from
    // the extract, its air is pulled straight back out, and all it does is rob
    // the bottom window of the inflow that was crossing the room.
    //
    // WHY 0.15 AND NOT 0.12. At 0.12 the only placements that cleared it were
    // the fan standing in the open window; "fan beside the bed, pointed at the
    // extract" — the move a person actually reaches for, and the one this task
    // is meant to teach — measured 0.140 and FAILED. A threshold that rejects
    // the reasoning the task exists to reward is the wrong threshold, not the
    // wrong reasoning. 0.15 admits that family (0.140–0.146 near the bed) while
    // still rejecting every no-fan arrangement, the nearest of which is 0.162.
    // That is a 10% margin: thin, and the honest number.
    //
    // WHAT THE PHYSICS DOES NOT AGREE WITH — recorded so nobody re-derives it.
    // The intended answer was "aim the fan at the kitchen vent". The winning
    // placements are all the fan standing AT the bottom window pushing that air
    // across the bed (0.095); aiming at the vent from mid-room is much weaker
    // (0.142, barely better than the 0.162 of not having a fan). The reason is
    // this room's geometry: the window is BETWEEN the bed and the kitchen, so
    // air travelling window → vent never passes over the bed. Tried and rejected
    // — flow-dependent freshness (V0_FRESH 0.14), stronger upstream protection
    // (UPWIND 1.35 → 2.4), and moving the window left behind the bed, which
    // makes the bed so clean (0.066) that no fan is needed at all. Making "aim
    // at the vent" correct needs the bed to sit between the window and the
    // kitchen, which is a different room.
    goals: [
      { label: "The smell stays off the bed", metric: "smell", roomId: "studio", nearItem: "bed", atMost: 0.15 },
    ],
    // Denser than the default 14. This is ONE open room where the whole question
    // is which way the air crosses it, and the two-room homes' reasoning — that
    // a handful of lines through a doorway reads more clearly than a bundle —
    // does not apply: there is no doorway, and a sparse picture here just looks
    // like nothing is happening.
    viz: { maxSeeds: 26 },
    success:
      "Smell over the bed ≤ 0.15: the BOTTOM window open and a fan working with " +
      "it. Both levers are needed — the window alone reaches 0.162 and the fan " +
      "alone 0.307. Two families of placement clear it: the fan beside the bed " +
      "aimed at the kitchen extract (0.140), and the fan standing in the open " +
      "window sweeping across the bed (0.095), which is stronger. The right-hand " +
      "window is the trap: two metres from the extract, its air goes straight " +
      "back out, so it changes nothing alone (0.300) and makes things worse with " +
      "a fan (0.327). Opening BOTH is no shortcut (0.164) — the second window " +
      "only robs the first of the inflow that was crossing the room.",
    build: buildStudio,
  },
  humidity: {
    id: "humidity",
    title: "Bathroom · Humidity · Design",
    outdoorTemp: 24,
    brief:
      "You are designing a new home in a place with damp, humid summers and cold " +
      "winters — the kind of home where the bathroom corner goes black with mould " +
      "and the windows drip with condensation on a winter morning. You can still " +
      "decide where the window and the extract vent go, on any of the outside " +
      "walls. Get the damp corner behind the bath drying out.",
    youCanChange:
      "Move the extract vent and the window to any outside wall, and open or " +
      "close the window. The room and its fittings are already laid out.",
    tools: { movable: ["return"], aimable: [], addable: [], walls: false, openings: true, editOpeningSet: false, resize: false },
    // Only the two views this task is about. Temperature and noise are real
    // things the solver knows, and neither is being asked about here — four tabs
    // where two would do is four things to rule out before you can start.
    views: ["airflow", "contamination"],
    // ONE GOAL, MEASURED AS A TIME. "How long does it stay wet after a shower"
    // is the question a person actually asks about a bathroom; 0.27 on a
    // contaminant scale is not. Scored on the 90th percentile of the room, so a
    // genuinely stagnant corner fails while the single crevice behind the tub
    // that no arrangement can reach does not decide the task.
    //
    // Measured over 11 vent positions × 12 window positions (4 walls × 3):
    //     window SHUT (any vent)                    59 min
    //     as built — window open beside the vent    51 min   the short circuit
    //     openings on opposite sides of the room    31 min
    // Range with the window open is 31–53 min, and the slowest arrangements are
    // all the two openings clustered in the same corner: the air crosses a metre
    // of wall and leaves, and the rest of the room never moves. 29 of the 132
    // get under 35 minutes, all of them with the window and the extract on
    // opposite sides.
    //
    // The window STARTS beside the extract, so opening it is not the answer —
    // left diagonally opposite the vent where it used to be, merely opening it
    // dried the room in 32 minutes and the placement question never came up.
    goals: [
      { label: "The bathroom dries out after a shower", metric: "drying", roomId: "bathroom", atMost: 35 },
    ],
    success:
      "Everywhere in the bathroom dry within 35 minutes, measured on the slow " +
      "90% of the room. Reached by opening the window AND moving it away from " +
      "the extract, so the air has to cross the floor to get from one to the " +
      "other. Shut, the room takes about an hour; open but left beside the " +
      "extract, 51 minutes — the air short-circuits along one wall and the damp " +
      "corner never clears.",
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
    goals: [{ label: "The smell is off the bed", metric: "smell", roomId: "apt", atMost: 0.12 }],
    success:
      "Contaminant ≤ 0.12 in the bed zone with an open exterior path — reached by " +
      "opening the FAR window (cross-draught), not the near one (which short-" +
      "circuits with the vent).",
    build: buildSmell,
  },
};

export const SCENARIO_ORDER: ScenarioId[] = ["winter", "summer", "humidity", "smell"];

/** Streamline density outside a task (and for tasks that don't override it). */
export const VIZ_DEFAULT = { maxSeeds: 14 };

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
