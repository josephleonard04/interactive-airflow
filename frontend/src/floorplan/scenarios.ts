    // TWO GOALS THAT PULL APART, which is the design rule for all four tasks.
    //
    // WHAT THE FULL SWEEP SAYS, and it is not what the task was first written to
    // claim. 265 layouts at REPORT_FIDELITY: 25 AC aim/tilt combinations with no
    // fan, then 240 fan placements (5x6 grid across BOTH rooms x 4 headings x
    // sweep on/off) with the AC left as found.
    //
    //   AC alone, all 25 aims and tilts   bed 0.107-0.119   worst room 25.78-26.07
    //   as found (fan idle in the corner) bed 0.112         worst room 25.33
    //   coolest of all 240 (fan at 4.5)   bed 0.470         worst room 24.74
    //   best with the bed calm            bed 0.148         worst room 24.88
    //
    // THE BED IS ALREADY CALM AND THE AC CANNOT CHANGE THAT. Four metres down
    // the room from the unit, the bed sits at 0.107-0.119 m/s whichever way the
    // louvre points — a 0.012 m/s spread, against a 0.20 line. The task was
    // originally written as "the last tenant left it aimed at your pillow"; the
    // solver does not agree and never did, so the text no longer says it. What
    // the AC cannot do either is reach the living room: its best across all 25
    // settings is 25.78 °C against a 25.2 bar.
    //
    // So the fan is the whole task, and the draught is something the FAN
    // creates. Both goals are live: 11 of 240 placements clear both, and the
    // four coolest layouts in the sweep all fail the bed — they are the fan
    // standing deep in the bedroom at x 4.5 blowing back toward the doorway,
    // which is the shortest path for the cold and runs straight over the
    // sleeper. The answer keeps the fan at x 2.0-3.2, on the doorway's side of
    // the room, so its throw reaches the door without crossing the bed.
    //
    // With the fan placed well, all 25 AC aim/tilt combinations pass (spread:
    // bed 0.148-0.180, worst room 24.84-25.00). The louvre is a trim.
import { DOOR_WIDTH, WINDOW_WIDTH, boundsOf, buildWalls, carveOpening, makeOpening } from "./geometry";
import {
  against,
  doorsForRoom,
  idGen,
  inCorner,
  placeDoor,
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
//   summer    Kitchen smell · RENTED           — a studio where the bed and the
//             kitchen share one room and the bin has started to smell. Choose
//             which window to open and aim a fan; the window beside the extract
//             short-circuits, the far one sweeps the smell out.
//   humidity  Humidity / drying · DESIGN       — a bathroom; place a window and an
//             extract vent so the damp corner behind the tub dries (modelled as a
//             moisture source that has to be vented out).
//   smell     AC blowing on you · RENTED       — a second studio, in a heatwave.
//             The AC is bolted to the right-hand wall aimed down the bed. You
//             cannot move it; you re-aim it and place a fan so the whole studio
//             cools without the jet landing on the pillow.
//             (The id is historical; this slot used to hold a second smell task.)
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
  /** May the placement search MOVE a window, not just open and shut it? Only
   *  worth setting where the glazing's position is part of the question the
   *  task asks — see FindOptions.moveOpenings. */
  movableOpenings?: boolean;
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
  /** Temperature goals only: grade the room by its WARMEST part rather than its
   *  mean or one measuring spot. "Keep everywhere cool" is a coverage claim, and
   *  neither a mean nor a single zone can express it — a mean is satisfied by
   *  cooling one end hard, and a zone just picks a different end to ignore. */
  everywhere?: boolean;
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
  /** Read to the participant verbatim — comfort goal only, no physics.
   *
   *  Legacy single-paragraph form. Tasks that have been split into the four
   *  labelled parts below (`situation` / `goal` / can / cannot) leave this as
   *  the fallback for anything still reading a one-paragraph brief. */
  brief: string;
  /** WHAT IS HAPPENING — the room, the weather, the problem. No instruction in
   *  it, and no physics: it is the situation a person would describe to a
   *  friend. */
  situation?: string;
  /** WHAT DONE LOOKS LIKE, in the participant's own terms. Deliberately not a
   *  threshold and not a checkable line — see the note on `goals`. */
  goal?: string;
  /** What the participant may change, in plain words, shown in the panel. */
  youCanChange: string;
  /** What is fixed, said explicitly. Left implicit, participants spend the task
   *  hunting for controls that were never there — and "I couldn't find how to
   *  move the window" is a finding about our UI, not about their reasoning. */
  youCannotChange?: string;
  tools: ScenarioTools;
  /** The task's success conditions — SCORED, NEVER SHOWN.
   *
   *  These used to drive a live tick-list. Prof. Igarashi's objection (2026-08-03)
   *  is that a visible tick-box turns the task into collecting the tick: the
   *  participant optimises toward the box instead of toward a home they would
   *  actually want to live in, and stops the moment it goes green rather than
   *  when they are satisfied. So the boxes are gone from the screen; the goals
   *  stay, evaluated silently, logged with a timestamp each time the verdict
   *  changes, and scored once more against the plan as submitted. The
   *  participant decides when they are done. Omitted = nothing to score. */
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
  // THE FRONT DOOR IS NOT A VENTILATION CONTROL. Every task here is set in a
  // real home on a real day, and nobody airs a flat by propping the entrance
  // open onto a corridor or a street — but it was a togglable opening like any
  // other, so it sat there as the biggest hole in the envelope and the cheapest
  // way to satisfy any of the four tasks. Shut and locked in all of them; the
  // windows are the openings each task is actually about.
  for (const d of doors) {
    if (!d.rooms.includes("outside")) d.open = true;
    else { d.open = false; d.locked = true; }
  }
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
 *  one per room). `side` is which wall of the room; `frac` is 0..1 along it.
 *  `width` defaults to the standard casement — pass a bigger number for glazing
 *  that is part of the room's character rather than a hole in a wall. */
function addWindow(
  plan: FloorPlan,
  roomId: string,
  side: "north" | "south" | "east" | "west",
  frac: number,
  open: boolean,
  width = WINDOW_WIDTH,
): void {
  const r = plan.rooms.find((x) => x.id === roomId);
  if (!r) return;
  const { x, z, w, d } = r.rect;
  const [axis, line, lo, hi] =
    side === "north" ? (["x", z + d, x, x + w] as const)
    : side === "south" ? (["x", z, x, x + w] as const)
    : side === "east" ? (["z", x + w, z, z + d] as const)
    : (["z", x, z, z + d] as const);
  const mid = lo + frac * (hi - lo);
  const s = clampf(mid - width / 2, lo + 0.2, hi - 0.2 - width);
  const o = makeOpening(`window-x-${roomId}-${side}`, "window", axis, line, s, s + width, [roomId, "outside"]);
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
  opts: { category?: PlacedItem["category"]; mount?: PlacedItem["mount"]; y?: number; flow?: number; on?: boolean; mountYaw?: number } = {},
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
    ...(opts.mountYaw !== undefined ? { mountYaw: opts.mountYaw } : {}),
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
  // at the same time.
  for (const o of [...plan.doors, ...plan.windows]) o.fixed = true;
  // AND THE WINDOWS STAY SHUT. It is 2 °C outside. Opening a window is not a
  // heating strategy, it is the opposite of one, and leaving the toggle live
  // meant both the participant and the placement search could spend the task on
  // a move nobody would make in February — the search actually proposed opening
  // both of them. The interior door stays free: that one moves heat between the
  // two rooms, which is the question this task is asking.
  for (const w of plan.windows) w.locked = true;
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
        // The fan, standing beside the closet in the corner behind the bed —
        // where a floor fan actually lives when it is not in use, and about as
        // far from both the bin and the windows as this room allows.
        //
        // It used to be absent, added from the palette. That made the first move
        // of the task "find the right thing in a menu", which is a test of our
        // UI and not of their reasoning, and it let a participant start the task
        // with no fan at all and never realise one was available. Standing it in
        // the room states the levers plainly: here is a fan, here are two
        // windows, the vent runs itself.
        spot(gen, studio, "fan", [0.45, 1.3, 0.45], 4.95, 4.42, 0, {
          category: "hvac", mount: "floor", flow: 0, on: true,
        }),
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
  // 4.2 WIDE x 3.6 DEEP — the long wall runs across the screen.
  //
  // It used to be 3.6 x 4.2, i.e. taller than it was wide in the top view, so
  // the plan read as a corridor stood on end and the "top wall" the wet run
  // lives along was the SHORT one. A bathroom is normally entered down its
  // length; laying the long side horizontally puts the whole wet run — shower,
  // steam, bath — across the top of the view where it can be seen at a glance,
  // and leaves the short walls for the door and the glazing.
  const rooms = [room("bathroom", "bathroom", "Bathroom", 0, 0, 4.2, 3.6, true)];
  const plan = assemble(
    "Bathroom",
    rooms,
    (walls, gen, doors) => {
      // Door on the WEST (left) wall, toward the lower end — away from the
      // shower in the top-left corner, so the doorway does not open into it.
      const { x, z, d } = rooms[0].rect;
      const cz = z + d * 0.72;
      const ent = makeOpening(gen("door"), "door", "z", x, cz - DOOR_WIDTH / 2, cz + DOOR_WIDTH / 2, ["bathroom", "outside"]);
      carveOpening(walls, ent);
      doors.push(ent);
    },
    (gen, rs) => {
      const [bath] = rs;
      const W = bath.rect.w;
      const D = bath.rect.d;
      // THE WET RUN IS THE TOP WALL, END TO END: shower head in the top-left
      // corner, bath lying horizontally across the top-right, steam rising
      // between them. One wet wall and one dry wall reads at a glance and puts
      // the moisture as far from the door as the room allows, so how the air
      // gets to it is a real question rather than a formality.
      return [
        // Bath: 1.8 long, lying ALONG the top wall (no quarter-turn) now that
        // the room's long side runs that way.
        spot(gen, bath, "bathtub", [1.8, 0.6, 0.85], W - 1.0, 0.48, 0),
        // Shower in the top-left corner. Just a riser and a head — see the
        // model: the glass cubicle is gone, so this is an open wet area.
        spot(gen, bath, "shower", [0.9, 2.0, 0.9], 0.55, 0.5, 0),
        // The DRY run is the bottom wall, right-hand end: toilet in the corner,
        // basin immediately beside it.
        spot(gen, bath, "toilet", [0.55, 0.75, 0.7], W - 0.35, D - 0.4, Math.PI),
        spot(gen, bath, "sink", [0.7, 0.9, 0.55], W - 1.05, D - 0.33, Math.PI),
        // The steam, between the shower and the bath and hard against the top
        // wall — where hot water actually puts it.
        spot(gen, bath, "damp", [0.72, 0.72, 0.72], 1.72, 0.45, 0, { category: "hvac" }),
        // ONE extract, high on the RIGHT-HAND wall just above the window: the
        // bad pair the task poses, a few centimetres apart, so the air comes in
        // and goes straight back out without crossing the floor.
        spot(gen, bath, "return", VENT_SIZE, W - 0.09, 1.15, -Math.PI / 2, {
          category: "hvac", mount: "wall", y: ventMountY(H), flow: 0.05, on: true,
        }),
      ];
    },
    { windows: false },
  );
  // ONE window, and NOT fixed — a window can be dragged to any wall of its own
  // room (moveOpeningToPoint), which is exactly the choice this task is about.
  //
  // On the RIGHT-HAND wall, in the clear band between the bath above it and the
  // toilet below. It must miss the shower head (top-left) and the doorway (left
  // wall, lower) — this is the only stretch of wall that does both.
  //
  // It starts SHUT and a few centimetres from the extract, so the pair as-built
  // short-circuits and merely opening it is not the answer.
  addWindow(plan, "bathroom", "east", 0.55, false);
  // The door is not a ventilation strategy here. You do not leave the bathroom
  // door open to dry it out, and letting the participant do so replaces the
  // question with a shortcut nobody would actually take.
  for (const dr of plan.doors) {
    dr.fixed = true;
    dr.locked = true;
  }
  // THE WINDOW MUST NOT AIR THE ROOM OUT ON ITS OWN. This task is about where
  // the EXTRACT goes; at full strength, simply opening the window swamped that
  // — the difference between a good vent position and a bad one shrank to a few
  // minutes, and the participant could pass without ever thinking about the
  // grille. Turned down, the window still supplies the make-up air that makes
  // the extract work at all, but it no longer answers the question by itself.
  plan.windowReach = 0.85;
  // AND THE EXTRACT REACHES FURTHER — in this task only. It is the one thing
  // the participant moves, so the picture has to show it working: put it in the
  // right place and the floor around it goes dry, because the air there really
  // is on its way out of the room. Left where it is built, a few centimetres
  // from the window, the short-circuit term still swamps this and its corner
  // stays damp — which is the lesson.
  plan.ventSpread = 0.2;
  // …and with everything shut it still clears its own patch rather than the
  // room reading uniformly wet, which looks like a fan that is off. The room as
  // a whole still never dries — see sealedHalo.
  plan.sealedHalo = true;
  return plan;
}

// ---------------------------------------------------------------- ac studio

/**
 * AC · RENTED. A single-bedroom apartment on a hot night. The air conditioner is the
 * only one in the place, it is in the BEDROOM, and whoever lived here last left
 * it pointing down the bed at the pillow.
 *
 * It was a studio until the living room was added, and the old front door
 * became the door between the two rooms — which is the whole point of the
 * change. A studio asks "spread the cold across one room"; this asks "spread it
 * across one room AND through a doorway into another", which is the same shape
 * as the winter home's question about heat and is a much better test of whether
 * somebody understands what a fan is for.
 *
 * The tension: the AC pools cold at the top of the bedroom and the bed is at the
 * bottom of it, so the aim that reaches the far end of the flat and the aim that
 * lands on the sleeper are close together — and the fan placements that carry
 * cold through the doorway best are the ones standing where the bed can feel
 * them. The fan is the lever; the louvre is a trim.
 */
function buildAcFlat(): FloorPlan {
  // 6.4 wide x 8.0 deep overall, split evenly: 4.0 m of living room across the
  // top, 4.0 m of bedroom below it.
  //
  // The living room started at 3.2 against the bedroom's 4.8, which is how the
  // split fell out of keeping the studio's footprint intact — and it looked
  // wrong, because it IS wrong: a single-bedroom apartment's living room is the bigger
  // room, not a strip at the end. Evening them up costs the bedroom 0.8 m it
  // was not using (the gap between the desk at the top and the bed at the
  // bottom) and gives the living room enough floor to be somewhere you sit.
  const rooms = [
    room("living", "living", "Living room", 0, 0, 6.4, 4.0, true),
    room("bedroom", "bedroom", "Bedroom", 0, 4.0, 6.4, 4.0, true),
  ];
  const plan = assemble(
    "Single-bedroom apartment",
    rooms,
    (walls, gen, doors) => {
      // The front door is now on the LIVING room's outer wall, and the door that
      // used to be the front door is the one between the two rooms.
      // The doorway sits well left of centre, which puts it at the opposite end
      // of the shared wall from the air conditioner. That distance IS the task:
      // it is how far the cold has to travel back across the bedroom before it
      // can reach the living room at all.
      placeDoor(walls, gen, rooms[0], rooms[1], doors, 0.3);
      entranceOnTop(walls, gen, "living", rooms[0].rect, doors, 0.28);
    },
    (gen, rs, openings) => {
      const c = (r: RoomDef) => doorsForRoom(r, openings);
      const [living, bedroom] = rs;
      return [
        // LIVING ROOM: couch facing the television, and a low table. The TV and
        // the table came out of the bedroom when it stopped being a studio —
        // they are what makes a living room a living room, and the bedroom was
        // carrying five pieces of furniture as it was.
        against(gen, living, c(living), "west", 0.5, "tv", [1.4, 0.8, 0.1], { mount: "wall", y: 1.55 }),
        centreItem(gen, living, "couch", [1.8, 0.8, 0.85], -Math.PI / 2),
        // The coffee table goes BETWEEN the couch and the television, turned a
        // quarter so its long side runs across the sightline — which is where
        // one goes and how one sits, rather than off to the side of the room.
        spot(gen, living, "table", [1.1, 0.45, 0.7], 1.5, 2.0, Math.PI / 2),

        // BEDROOM, as it was drawn — every position is the studio's own, shifted
        // down by the living room's depth. The bed and the closet are measured
        // from the OUTER wall, which has not moved, so they are untouched.
        //
        // THE BED, in the bottom-right corner with the headboard against the
        // right-hand wall. Turned rather than reshaped: the model puts the
        // headboard and pillows at its local -z, and yaw = -pi/2 maps that to
        // +x, so the pillows end up hard against the right wall.
        spot(gen, bedroom, "bed", [1.5, 0.5, 2.0], 5.34, 7.19, -Math.PI / 2),
        inCorner(gen, bedroom, "north", "start", "closet", [1.0, 2.0, 0.6]),
        inCorner(gen, bedroom, "south", "end", "desk", [1.2, 0.75, 0.6]),
        // THE AIR CONDITIONER, high on the bedroom's top wall above the desk —
        // which is now the wall it shares with the living room, and the doorway
        // is at the far end of that same wall. RUNNING, and aimed straight out
        // into the bedroom, which from x 5.74 runs the length of the room and
        // lands on the bed. `mountYaw` pins the casing to the wall so re-aiming
        // swings the vanes instead of turning the whole unit off the plaster.
        spot(gen, bedroom, "ac", [0.85, 0.32, 0.22], 5.74, 4.17, 0, {
          category: "hvac", mount: "wall", y: H - 0.5, flow: 0.5, on: true, mountYaw: 0,
        }),
        // The fan, standing in the bedroom's top-left corner out of the way —
        // where one lives when nobody is using it, and next to the doorway it
        // will probably need to be pointed through.
        spot(gen, bedroom, "fan", [0.45, 1.3, 0.45], 0.62, 4.62, 0, {
          category: "hvac", mount: "floor", flow: 0, on: true,
        }),
      ];
    },
    { windows: false },
  );
  // The bedroom's big window across its outer wall, and one in the living room.
  // Both SHUT: it is 31 °C outside and the AC is running, so opening either is
  // not a move anyone makes and this task does not offer it as one.
  addWindow(plan, "bedroom", "north", 0.42, false, 2.8);
  addWindow(plan, "living", "east", 0.5, false);
  for (const o of [...plan.doors, ...plan.windows]) { o.fixed = true; }
  // Every window locked; the INTERIOR door stays free, because that one is the
  // route between the cold and the far room and is the question this task asks.
  for (const w of plan.windows) w.locked = true;
  for (const d of plan.doors) if (d.rooms.includes("outside")) d.locked = true;
  return plan;
}

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
    situation:
      "It's very cold outside and you've just moved into this newly built home. The " +
      "heater and the fan were delivered and left by the kitchen, inside the front " +
      "door. Glass is where a home leaks its heat, and right now the cold is pouring " +
      "off the windows.",
    // No number, no tick-box, and an explicit "you decide when you're done" —
    // without that last sentence the absence of a checklist reads as a missing
    // feature rather than as permission to stop when the home feels right.
    goal:
      "Make both rooms — the bedroom and the living + kitchen — warm enough to live in. " +
      "Keep changing things until you are happy with the result, then press Submit. " +
      "There is no score to collect and no right number to hit: you decide when it is good enough.",
    youCanChange:
      "Move the heater and the fan anywhere in the home, aim the fan, and open or close " +
      "the door between the two rooms. Run the simulation as many times as you like.",
    youCannotChange:
      "The walls, doors and windows are already built — you cannot move them, add new " +
      "ones or take any away. The windows stay shut: it is far too cold out to open one, " +
      "and this task is about where the heat goes rather than how much of it you throw " +
      "away. The heater and the fan both run on medium and cannot be turned up. The " +
      "weather outside is fixed.",
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
    // Two views, because two is what the task needs: where the air goes, and how
    // warm it is. A smell tab and a noise tab on a task about a cold bedroom are
    // two more things to open, rule out and forget about.
    views: ["airflow", "temperature"],
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
    situation:
      "It's a hot night, and the food waste in the kitchen bin has started to smell. " +
      "The bed and the kitchen share one room, and you have to sleep in there tonight. " +
      "The air conditioner is broken and the landlord can't come until next week. " +
      "There is a fan standing by the closet, and two windows you can open.",
    goal:
      "Keep the smell away from the bed while you sleep. Keep changing things until you are " +
      "happy with the result, then press Submit.",
    youCanChange:
      "Move the fan anywhere in the room and aim it whichever way you like, and open or close " +
      "either window. Run the simulation as many times as you like.",
    youCannotChange:
      "You are renting, so nothing about the studio itself moves: the windows, the door and the " +
      "kitchen stay where they are. The kitchen's extract vent runs all night and cannot be " +
      "switched off, the air conditioner is broken, the fan runs on medium and cannot be turned " +
      "up, and the bin has to stay where it is. The weather outside is fixed.",
    // The fan now stands in the room, so the palette is empty — see buildStudio.
    tools: { movable: ["fan"], aimable: ["fan"], addable: [], walls: false, openings: true, editOpeningSet: false, resize: false, lockPower: true },
    // Two views, and only two: where the air goes, and where the smell is. A
    // temperature tab on a task whose AC is broken is a lever that isn't there.
    views: ["airflow", "contamination"],
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
      // 0.20 → 0.17, re-measured after the opening discounts moved from being a
      // head start at the opening to a cost per metre travelled (see sim3d,
      // openingReach). That change was made so an open window greens its own
      // doorstep whatever else is open — and it also separated this task's
      // answer from its near misses far more cleanly than the old model did.
      //
      // Swept 432 fan placements and aims (9 x 7 spots x 8 headings), best per
      // window choice. Re-measured after the short circuit was tightened so it
      // LOOKS like a short circuit (see sim3d): an extract only cleans air that
      // flowed through the room to reach it, so a grille fed by a window two
      // metres away sweeps those two metres and nothing else.
      //     everything shut, best fan           0.303
      //     RIGHT window only, best fan         0.289   <- the trap
      //     BOTH windows, no fan                0.340
      //     BOTH windows, best fan              0.229   <- two is worse than one
      //     bed-side window only, no fan        0.258
      //     bed-side window only, best fan      0.132   <- the answer
      //
      // Opening the second window costs you twice over: it halves the make-up
      // air the bed-side window draws in, and what it draws in itself is eaten
      // by an extract two metres away. Both windows open is barely better than
      // no fan at all (0.229 against 0.258) and 73% worse than the same fan
      // with that window shut. Shutting it is worth more than any fan move.
      //
      // WHAT THE PICTURE SHOWS, which is the point of the change: with both
      // windows open the extract's corner and the right-hand window both stay
      // deep violet (0.708 and 0.432 over a 0.9 m strip) while the bed-side
      // window greens (0.220). The air coming in beside the grille goes
      // straight back out of it; only the far window's air crosses the room.
      // Before, that corner read pale - i.e. working - right where the lesson
      // is that it is not.
      //
      // WHERE THE FAN GOES IS THE WHOLE ANSWER: all 8 placements under 0.17
      // stand it at or beside the bed-side window (x 2.6-3.2, z 4.5), and every
      // heading from that spot clears the bar - 0.132 along the near wall,
      // 0.153 aimed diagonally at the kitchen extract.
      //
      // 0.17 sits in the 0.161 -> 0.229 gap: 29% clear of the answer and 26%
      // clear of the nearest non-solution. Widest this task has had.
      { label: "The smell stays off the bed", metric: "smell", roomId: "studio", nearItem: "bed", atMost: 0.17 },
    ],
    // Denser than the default 14. This is ONE open room where the whole question
    // is which way the air crosses it, and the two-room homes' reasoning — that
    // a handful of lines through a doorway reads more clearly than a bundle —
    // does not apply: there is no doorway, and a sparse picture here just looks
    // like nothing is happening.
    viz: { maxSeeds: 26 },
    success:
      "Smell over the bed ≤ 0.17: the BOTTOM (bed-side) window open, the " +
      "right-hand one SHUT, and the fan standing in that window's inflow — any " +
      "heading, including straight at the kitchen extract. Best measured 0.132; " +
      "aimed at the extract, 0.153. Both levers are needed: the window alone " +
      "reaches 0.258 and the fan alone 0.303. The right-hand window is the trap " +
      "— two metres from the extract, the air it lets in is pulled back out " +
      "before it crosses the room, so its corner and the grille's both stay " +
      "violet on screen (0.289 with the best fan). Opening BOTH is the near " +
      "miss at 0.229: barely better than no fan, and the fix is to shut the " +
      "second window rather than to move the fan again.",
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
    // Split into the same four labelled parts as the winter and summer tasks:
    // the situation, what done looks like, and the two lists of what does and
    // does not move. Same reasoning as those two — a single paragraph buries
    // the levers, and leaving "what is fixed" implicit sends the participant
    // hunting for controls that were never there.
    situation:
      "You are designing a new home somewhere with damp, humid summers and cold winters — " +
      "the kind of place where a bathroom corner goes black with mould and the windows " +
      "run with condensation on a winter morning. The bathroom is laid out: a bath and a " +
      "shower down one side, the toilet and basin down the other. The extract fan is " +
      "already fitted and runs all the time, and it and the window are pencilled in beside " +
      "each other — neither is built yet, so both are still yours to place.",
    // No number, no tick-box, and the same explicit "you decide when you're
    // done" the other tasks carry — without it the absence of a checklist reads
    // as a missing feature rather than as permission to stop.
    goal:
      "Get the bathroom drying out properly after a shower, so the damp corner behind the " +
      "bath does not stay wet. Keep changing things until you are happy with the result, " +
      "then press Submit. There is no score to collect and no right number to hit: you " +
      "decide when it is good enough.",
    youCanChange:
      "Move the extract vent and the window to any outside wall, and open or close the " +
      "window. Run the simulation as many times as you like.",
    youCannotChange:
      "The room and its fittings are already laid out — the bath, the shower, the toilet " +
      "and the basin stay where they are. The door stays shut: you do not dry a bathroom " +
      "out by leaving the door open. The extract runs at one speed and cannot be turned up " +
      "or switched off. The weather outside is fixed.",
    // lockPower: the extract has one speed and runs all night. An on/off switch
    // and a Low/Med/High row invite "turn it up" as a substitute for thinking
    // about where it goes, which is the only thing this task is about.
    tools: { movable: ["return"], aimable: [], addable: [], walls: false, openings: true, editOpeningSet: false, movableOpenings: true, resize: false, lockPower: true },
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
      // 98 -> 66 min, and the widest margin this task has had. Re-measured on
      // the room as it now is -- 4.2 x 3.6 with the long wall across the view,
      // the wet run along the top, the door on the left and the glazing on the
      // right -- and, for the first time, with the hot water modelled as heat
      // (sim3d WET_T). That last one changes the physics, not just the picture:
      // warm air comes off the shower and the bath, rises, and rolls back down
      // the cool glazing, so the room has a convective turnover the extract can
      // work with or against.
      //
      // Extract swept over 10 positions, window open:
      //     as delivered (right wall, by the window)  113 min  <- the problem
      //     bottom-right corner                       104 min
      //     right wall, upper                          90 min
      //     top-right corner                           77 min
      //     ------------------------------------------------ the cliff
      //     bottom mid                                 56 min
      //     top mid                                    41 min
      //     left wall, lower                           40 min
      //     bottom-left corner                         38 min
      //     left wall, upper                           31 min
      //     top-left corner                            31 min  <- the answer
      //
      // The split is not a slope, it is a cliff between the half of the room
      // the window is in and the half it is not: 77 against 56 with nothing
      // between. Put the extract on the far side and the air has to cross the
      // whole floor, over the steam, to get from one to the other. 66 sits mid-
      // gap -- 53% clear of the answer, 14% clear of the nearest miss.
      //
      // Shut, the room never dries: an extract with no make-up air cannot turn
      // it over. It is not inert, though — it still clears the patch of air
      // directly in front of the grille (0.25 against 0.86 in the far corner),
      // because a fan drawn as doing nothing looks switched off. See sealedHalo.
      //
      // THE SEARCH MOVES THE WINDOW TOO. It is half the question here — the
      // grille and the glazing short-circuit when they are close — so a search
      // that could only toggle it was answering something else. Joint sweep, 8
      // vent spots x 13 legal window spots, window open:
      //     vent as delivered, window anywhere      113-141 min   nothing works
      //     vent top-left, window bottom-right       24 min       the best pair
      //     57 of 104 combinations under 66 min
      // The vent still dominates: every arrangement that leaves it on the
      // window's own wall is 113 min or worse, whatever the glazing does.
      { label: "The bathroom dries out after a shower", metric: "drying", roomId: "bathroom", atMost: 66 },
    ],
    success:
      "Everywhere in the bathroom dry within 66 minutes, measured on the slow " +
      "90% of the room. Two things have to happen and neither is enough alone. " +
      "The window must be OPEN — shut, the extract has no make-up air, moves " +
      "nothing, and all ten vent positions read 180 minutes. And the extract " +
      "must cross to the LEFT half of the room, away from the glazing: 31 min " +
      "in the top-left corner beside the shower, 38 in the bottom-left, against " +
      "113 min where it is built a few centimetres above the window. There the " +
      "two short-circuit — the air comes in, goes straight back out, and the " +
      "steam between the shower and the bath never clears. The split is a cliff, " +
      "not a slope: everything on the window’s side of the room is 77 minutes " +
      "or worse, everything on the far side is 56 or better. The floor around a " +
      "well-placed grille goes visibly dry; around a short-circuited one it does " +
      "not, which is the picture the task turns on.",
    build: buildBathroom,
  },
  smell: {
    // The id is historical: this slot used to hold a second kitchen-smell task,
    // which duplicated the studio's. Renaming it would break every session log
    // already recorded against it, so the id stays and the content is what it
    // says on the card.
    id: "smell",
    title: "Single-bedroom apartment · Cool both rooms · Rented",
    outdoorTemp: 31,
    brief:
      "It is 31 °C outside and the apartment has one air conditioner, in the bedroom. The bedroom " +
      "is coping; the living room is not, and the cold does not find its way through the doorway " +
      "on its own. There is a fan in the corner — but you are sleeping in that bedroom tonight.",
    situation:
      "It is a hot night — 31 °C outside — and you are renting a single-bedroom apartment. The only " +
      "air conditioner is in the bedroom, bolted high on the wall it shares with the living room, " +
      "and it is running. It is keeping its own end of the bedroom cool, but the far corners are " +
      "still warm and the living room is warmer still — the cold does not find its way through the " +
      "doorway on its own. There is a fan standing in the bedroom corner by the door. You are " +
      "sleeping in that bedroom tonight.",
    goal:
      "Cool the whole apartment — the living room as well as the bedroom — without ending up with " +
      "air blowing hard over the bed while you sleep. Keep changing things until you are happy " +
      "with the result, then press Submit.",
    youCanChange:
      "Move the fan anywhere in the apartment and point it whichever way you like, and set whether " +
      "it sweeps. Re-aim the air conditioner too: turn it left or right and tilt it up or down. " +
      "Open or close the bedroom door. Run the simulation as many times as you like.",
    youCannotChange:
      "You are renting, so nothing about the apartment itself moves: the air conditioner stays " +
      "bolted where it is and you can only change the angle it blows at, and the windows, the " +
      "front door and the furniture stay put. The AC and the fan both run at a fixed speed and " +
      "cannot be turned up. The windows stay shut — it is 31 °C outside. The weather is fixed.",
    tools: {
      movable: ["fan"],
      aimable: ["ac", "fan"],
      addable: [],
      walls: false,
      // The bedroom door only — every window and the front door are locked in
      // the build. That door is the route between the cold and the far room,
      // which is the question this task asks.
      openings: true,
      editOpeningSet: false,
      resize: false,
      lockPower: true,
    },
    views: ["airflow", "temperature"],
    // TWO GOALS THAT PULL APART, which is the design rule for all four tasks.
    //
    // The task in one line: do not sleep in a blast, and do not leave half the
    // flat hot. Those fight because the fan is the only thing that carries the
    // AC's cold out of the corner it pools in and through the doorway, and the
    // placements that carry it best are the ones that put it over the bed.
    //
    // WHY THE LIVING ROOM IS GRADED TOGETHER WITH THE BEDROOM AND NOT BESIDE
    // IT. Graded separately the living room is nearly free: it has a quarter of
    // the bedroom's glazing (a 1.2 m casement against a 2.8 m window) so it
    // sits about 0.9 °C cooler before anybody touches anything, and its own
    // line would tick itself. One line over BOTH rooms, scored on whichever is
    // doing worst, is what "cool the whole flat" actually means — and it keeps
    // the tick-list at two boxes.
    //
    // WHAT THE AC'S POSITION COSTS THE TASK, recorded because it was measured
    // four times over. The unit is on the bedroom's top wall and the bed is
    // 3.8 m down the room from it; at that range the jet has spread out, so the
    // bed reads 0.100-0.107 m/s across every aim, and the AC's jet speed is
    // already clamped at the model's maximum (flow 0.5, 1.0, 1.8 and 3.0 give
    // byte-identical numbers). An air conditioner four metres away cannot blow
    // on you. Aiming it is a trim; the FAN is the lever.
    //
    // MEASURED at REPORT_FIDELITY, 125 layouts (fan on a 5x6 grid across BOTH
    // rooms x 4 headings, plus the no-fan case at five AC aims). Re-measured
    // after the rooms were evened up to 4.0 m each:
    //
    //   as found (fan parked in the corner)   bed 0.112   worst room 25.33
    //   best AC aim, NO FAN                   bed 0.112   worst room 25.78
    //   coolest of all 125                    bed 0.470   worst room 24.74
    //   best with the bed calm                bed 0.148   worst room 24.88
    //
    // The bed starts calm and the flat starts hot, so the task opens with one
    // box ticked and the obvious way to tick the second — stand the fan where
    // it shifts the most air — unticks it: the coolest layout in the sweep and
    // three of the next four all fail the bed. The answer stands the fan just
    // inside the bedroom door, pointing down the room: close enough to the unit
    // to pick up what it is producing, far enough across the room that the bed
    // does not feel it, and lined up so the return leg goes back out through
    // the doorway.
    goals: [
      // 0.20 m/s over the whole bed, not the pillow: air you can feel on your
      // legs still wakes you. This is a STRONG-draught line rather than a
      // stillness one — the app's own no-noticeable figure is 0.28 and the flat
      // never goes below 0.100 with anything running, so demanding stillness
      // would be demanding something the task cannot deliver. What it rules out
      // is the blast: the failing layouts run to 1.66 m/s.
      { label: "No strong draught on the bed while you sleep", metric: "draft", roomId: "bedroom", nearItem: "bed", atMost: 0.2 },
      // 25.2 °C in the warmest part of EITHER room — roomId "*" means every
      // room, graded on the one doing worst. Not a mean, which is satisfied by
      // cooling one end hard, and not a single measuring spot, which just picks
      // a different end to ignore. See warmestPart.
      //
      // 25.2 sits in the 24.88 -> 25.78 gap: it admits the fan-assisted family
      // (five placements clear it) and rejects doing nothing by 0.6 °C at every
      // AC aim tried.
      { label: "Both rooms cool down, not just one end", metric: "temperature", roomId: "*", everywhere: true, atMost: 25.2 },
    ],
    viz: { maxSeeds: 22 },
    success:
      "Bed ≤ 0.20 m/s AND the warmest corner of EITHER room ≤ 25.2 °C. THE FAN IS THE ANSWER, and " +
      "the AC is not: across all 25 of its aim-and-tilt settings the unit alone leaves the worst " +
      "room at 25.78 °C, and it moves the bed by 0.012 m/s — the bed is calm before anybody " +
      "starts. Stand the fan just inside the bedroom door around (3.2, 4.7) pointing down the " +
      "room, away from the shared wall: 24.88 °C in the worst room with 0.148 m/s at the bed. " +
      "Sweep on or off both work — the same spot sweeping gives 24.92 and 0.135. Ten other " +
      "placements clear both lines, all of them at x 2.0-3.2, i.e. on the doorway’s side of the " +
      "room. The trap is standing the fan deep in the bedroom at x 4.5 and blowing back toward " +
      "the doorway: that is the shortest path for the cold and gives the four coolest layouts in " +
      "the whole sweep (down to 24.73 °C), but it runs straight over the sleeper at 0.31-0.55 " +
      "m/s. With the fan right, every AC setting passes, so re-aiming the louvre is a trim.",
    build: buildAcFlat,
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
