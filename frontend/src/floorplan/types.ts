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
