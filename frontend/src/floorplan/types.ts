// Floor-plan data model.
//
// Coordinates: x = width axis, z = depth axis, y = up (metres). Rooms are
// axis-aligned rectangles given by a min corner (x, z) and size (w, d). Plans
// are authored in the positive quadrant; the renderer centres them.
//
// A generated FloorPlan carries everything the simulator and the editor need:
// room labels, wall/door/window geometry, placed furniture + HVAC, and a
// rasterised room-label grid so the solver knows which cells belong to which
// room.

export type Vec2 = [number, number]; // [x, z]
export type Vec3 = [number, number, number]; // [x, y, z]

export type HousingType =
  | "studio"
  | "one_bedroom"
  | "two_bedroom"
  | "small_family_house"
  | "shared_student";

export type RoomType =
  | "living"
  | "bedroom"
  | "kitchen"
  | "dining"
  | "bathroom"
  | "laundry"
  | "hallway"
  | "entryway";

/** Which furnishing recipe a room uses. Defaults from RoomType, but a template
 *  can override (e.g. a studio's single room runs the composite "studio"). */
export type FurnishProgram =
  | "studio"
  | "bedroom"
  | "living"
  | "kitchen"
  | "kitchen_dining"
  | "dining"
  | "bathroom"
  | "laundry"
  | "none";

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
  /** Override the furnishing recipe; defaults based on `type`. */
  program?: FurnishProgram;
}

/** A connection between two rooms (or a room and the outside, for the entry). */
export interface ConnectionSpec {
  a: string;
  b: string | "outside";
  /** Where along the shared edge to centre the door, 0..1 (default 0.5). */
  at?: number;
}

export type ItemCategory = "furniture" | "hvac";
export type Mount = "floor" | "wall" | "ceiling";

/** A placed object: furniture or an HVAC component. Both are movable so the
 *  mouse gizmo and the programmatic API can reposition them. */
export interface PlacedItem {
  id: string;
  category: ItemCategory;
  /** Specific kind: bed, desk, sofa, tv, counter, fridge, dining_table,
   *  coffee_table, nightstand, toilet, sink, shower, washer, dryer,
   *  ac, supply, return, fan. */
  type: string;
  roomId: string;
  position: Vec3; // centre
  size: Vec3;
  rotationY: number;
  mount: Mount;
  /** Volumetric flow (m^3/s) for supply/return/ac; undefined for solids. */
  flow?: number;
  movable: boolean;
}

export type OpeningKind = "door" | "window";

export interface Opening {
  id: string;
  kind: OpeningKind;
  /** Endpoints of the opening along the floor (metres). */
  a: Vec2;
  b: Vec2;
  width: number;
  sill: number; // bottom height (0 for doors)
  height: number; // opening height
  /** Rooms the opening connects (b may be "outside"). */
  rooms: [string, string | "outside"];
}

export type WallAxis = "x" | "z"; // wall runs along x (horizontal) or z (vertical)

export interface WallSeg {
  id: string;
  axis: WallAxis;
  /** Endpoints along the floor; for axis "x", z is constant; for "z", x is constant. */
  a: Vec2;
  b: Vec2;
  thickness: number;
  height: number;
  exterior: boolean;
  /** The room this wall segment belongs to (interior walls are emitted per room). */
  roomId: string;
  /** Openings carved into this wall (doors + windows on this line). */
  openings: Opening[];
}

/** Rasterised room labels for the simulator: labels[row * cols + col] is the
 *  roomId occupying that cell, or null for outside / wall. */
export interface OccupancyGrid {
  cell: number;
  cols: number;
  rows: number;
  origin: Vec2; // world coord of cell (0,0) min corner
  labels: (string | null)[];
}

export interface FloorPlan {
  housingType: HousingType;
  name: string;
  bounds: Rect;
  wallHeight: number;
  rooms: RoomDef[];
  walls: WallSeg[];
  doors: Opening[];
  windows: Opening[];
  items: PlacedItem[];
  grid: OccupancyGrid;
}
