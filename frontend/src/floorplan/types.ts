// Floor-plan data model.
//
// Coordinates: x = width axis, z = depth axis, y = up (metres). Rooms are
// axis-aligned rectangles given by a min corner (x, z) and size (w, d). The plan
// is generated in the positive quadrant; the renderer centres it.

export type Vec2 = [number, number]; // [x, z]
export type Vec3 = [number, number, number]; // [x, y, z]

export type RoomType = "living" | "bedroom" | "kitchen" | "bathroom";

export interface Rect {
  x: number;
  z: number;
  w: number;
  d: number;
}

export interface RoomDef {
  id: string;
  type: RoomType;
  name: string;
  rect: Rect;
  /** True when the user renamed this room — auto-naming won't override it. */
  renamed?: boolean;
}

export type ItemCategory = "furniture" | "hvac";
export type Mount = "floor" | "wall" | "ceiling";

/** A placed object: furniture or an HVAC component. Both are movable. */
export interface PlacedItem {
  id: string;
  category: ItemCategory;
  /** bed, desk, closet, table, sink, fridge, tv, couch, ac, fan, supply, heater. */
  type: string;
  roomId: string;
  position: Vec3; // centre
  size: Vec3;
  rotationY: number;
  mount: Mount;
  flow?: number;
  /** HVAC (ac/fan/heater): whether it's running. Undefined = on. */
  on?: boolean;
  /** HVAC power level 1 (low) · 2 (medium) · 3 (high). Undefined = 2. */
  power?: number;
  /** Fan only: oscillating (sweeps side to side) vs fixed direction. */
  oscillate?: boolean;
  /** AC & fan: vertical aim of the jet, in radians. 0 = horizontal (straight out
   *  along rotationY), positive tilts the jet UP, negative tilts it DOWN. Combined
   *  with rotationY this lets an AC be angled away from a bed, or a fan be aimed
   *  up/down/diagonally. Undefined = 0 (horizontal). */
  tilt?: number;
  /** Wall-mounted units only: the yaw the CASING is fixed at, i.e. the normal of
   *  the wall it is screwed to. Undefined = the casing follows rotationY.
   *
   *  A split AC does not swivel. It is bolted flat to the wall and aims by
   *  swinging the vanes across its mouth, so driving the whole box from
   *  rotationY drew it hanging off the wall at an angle the moment it was aimed
   *  anywhere but straight out — which is what an 8.6 degree default aim looked
   *  like in the studio task. Keeping the two apart lets the casing stay flush
   *  while `rotationY` goes on meaning what the solver needs it to mean: the
   *  direction the air actually leaves in. */
  mountYaw?: number;
  movable: boolean;
}

export type OpeningKind = "door" | "window";

export interface Opening {
  id: string;
  kind: OpeningKind;
  a: Vec2;
  b: Vec2;
  width: number;
  sill: number;
  height: number;
  rooms: [string, string | "outside"];
  /** Whether the door/window is open (lets air through) or closed. */
  open: boolean;
  /** Structural: set by the build and not the participant's to change. A fixed
   *  opening can still be opened and closed, but it cannot be dragged along its
   *  wall, relocated, or removed. Used to pin doors and any glazing a task has
   *  already decided, so only the opening the task is ABOUT stays editable. */
  fixed?: boolean;
  /** Cannot be opened or closed either — the state it was built in is the state
   *  it stays in. `fixed` pins WHERE an opening is; this pins WHETHER it is
   *  open. A bathroom door is the case: propping it open is not a ventilation
   *  design, and offering the toggle replaces the question with a shortcut. */
  locked?: boolean;
}

export type WallAxis = "x" | "z";

export interface WallSeg {
  id: string;
  axis: WallAxis;
  a: Vec2;
  b: Vec2;
  thickness: number;
  height: number;
  exterior: boolean;
  roomId: string;
  openings: Opening[];
}

/** Rasterised room labels for the simulator. */
export interface OccupancyGrid {
  cell: number;
  cols: number;
  rows: number;
  origin: Vec2;
  labels: (string | null)[];
}

/** House dimensions in metres (length = x, width = z, height = y). */
export interface HomeSize {
  length: number;
  width: number;
  height: number;
}

/** Start mode: a furnished example layout, or an empty shell to design. */
export type StartMode = "example" | "blank";

export interface FloorPlan {
  /** How far the air from an open window carries, as a multiplier on the
   *  default (1 = unchanged, below 1 = it runs out of push sooner).
   *
   *  Per-task, because the tasks are not asking the same question. In the
   *  bathroom the point is to place an EXTRACT, and a window that airs the
   *  whole room out by itself answers the question before it is asked — merely
   *  opening it swamped the difference between a good vent position and a bad
   *  one. Lowering it there restores the extract as the thing that decides the
   *  outcome. It does not touch the studio, where the window IS the answer.
   *
   *  It lives on the plan rather than in the sim options because the plan is
   *  what every caller of buildSim3D already holds — otherwise a dozen call
   *  sites would each have to learn which task they were solving. */
  windowReach?: number;
  /** How far an extract vent's influence carries, as a multiplier on the cost
   *  of travelling away from it (1 = unchanged, below 1 = it reaches further).
   *
   *  Per-task for the same reason windowReach is. In the bathroom the extract
   *  is the ONE thing the participant moves, so the picture has to show it
   *  working: the floor near a well-placed grille should read dry, because the
   *  air there really is on its way out of the room. No other task wants that —
   *  the studio's whole lesson is that a short-circuited grille cleans nothing —
   *  so it is opt-in and 1 everywhere else. */
  ventSpread?: number;
  /** Does a SEALED room still get a dry patch in front of the extract?
   *
   *  With nothing open there is no make-up air and the fan cannot turn the room
   *  over — every task keeps that. What this adds is that the grille still
   *  clears the air immediately in front of it, drawn from whatever leaks in
   *  around the door, instead of the whole room reading uniformly wet as though
   *  the fan were switched off.
   *
   *  Opt-in, because the studio's grille sits directly over the bin: a halo
   *  there scrubs the smelliest spot in the room clean and deletes that task's
   *  entire lesson. Only the bathroom, where the extract is the one thing the
   *  participant moves, wants it. */
  sealedHalo?: boolean;
  /** Multiplies the AC's jet speed, for tasks where the throw itself is the
   *  question. Default 1.
   *
   *  Per-task for the same reason windowReach and ventSpread are. In the
   *  single-bedroom apartment the whole point is that the unit blows on the
   *  person in the bed, and the model's jet is clamped at 1.5 — four metres
   *  down the room it arrives at 0.11 m/s, indistinguishable from still air,
   *  so no aim the participant chose could be felt and the task had no first
   *  lever. Raising the clamp globally would change every other scenario's
   *  air conditioner; this changes one plan's. */
  acThrow?: number;
  /** How far the AC's cold carries before it fades, as a multiplier on the
   *  temperature field's decay length (1 = unchanged, below 1 = it stays local
   *  to the unit). Default 1.
   *
   *  Per-task for the same reason acThrow is, and it is the apartment that
   *  needs it. The air conditioner is bolted in the BEDROOM, and the task is
   *  that its cold is dumped on the sleeper instead of reaching the living
   *  room. At the shared decay length the cold filled both rooms almost
   *  equally — 20.9 and 19.8, a gap of one degree — so the room the unit is not
   *  in was already as cool as the room it is in, and the participant had
   *  nothing to fix and no way to see they had fixed it.
   *
   *  Lowering it keeps the cold near the unit, which is what a cold jet
   *  actually does: it is denser than the room air, so it falls and pools
   *  rather than mixing through the house the way a heater's plume does.
   *  Aiming the unit through the doorway is then what carries it next door,
   *  which is the lever the task is about.
   *
   *  Only the cold half. The heater's warmth is untouched, so the winter home
   *  is unaffected — see TAU in sim3d.ts. */
  coldReach?: number;
  name: string;
  size: HomeSize;
  bounds: Rect;
  wallHeight: number;
  rooms: RoomDef[];
  walls: WallSeg[];
  doors: Opening[];
  windows: Opening[];
  items: PlacedItem[];
  grid: OccupancyGrid;
}
