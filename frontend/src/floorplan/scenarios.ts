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
  metric: "temperature" | "smell" | "draft";
  /** Room it is measured in. Ignored when `nearItem` is set. */
  roomId: string;
  /** Measure over the footprint of this item type instead of the whole room —
   *  a draught is felt where you lie, not averaged over the floor. */
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
    // WHY THE PARTICIPANT MAY MOVE WINDOWS. "You rent this place" cannot justify
    // repositioning glazing, so the task is set at the moment when that really is
    // still an open choice: the home is built and the walls and doors are fixed
    // by the structure, but the glazing has not been fitted yet. That is how a
    // real build runs — the structural plan is frozen long before the window
    // schedule is — and it is also the moment a buyer is actually asked where
    // they want the windows.
    brief:
      "It's 2 °C outside and you've just moved into this newly built home. The " +
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
    title: "Studio · Temperature (summer) · Rented",
    outdoorTemp: 33,
    brief:
      "It's a hot afternoon. The air conditioner is fixed to the wall and blows " +
      "straight onto the bed, so it's a cold draught all night. Cool the whole " +
      "room evenly and keep the air over the bed calm.",
    youCanChange: "Aim the air conditioner (you can't move it), and add, move and aim a fan.",
    tools: { movable: ["fan"], aimable: ["ac"], addable: ["fan"], walls: false, openings: true, resize: false },
    // Cooling has the mirror problem: "26 °C or below" is satisfied by an
    // over-chilled 18 °C room. 23–26 °C is the ASHRAE 55 summer zone. The
    // second goal is the one that makes this task hard — the two pull against
    // each other, since the cheapest way to hit the temperature is to point
    // the air straight at the bed.
    goals: [
      { label: "Studio is comfortable", metric: "temperature", roomId: "studio", atLeast: 23, atMost: 26 },
      { label: "Air over the bed is calm", metric: "draft", roomId: "studio", nearItem: "bed", atMost: 0.25 },
    ],
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
    goals: [{ label: "The damp corner is drying out", metric: "smell", roomId: "bathroom", atMost: 0.12 }],
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
