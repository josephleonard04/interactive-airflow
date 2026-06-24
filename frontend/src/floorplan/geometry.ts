import type {
  Opening,
  Rect,
  RoomDef,
  Vec2,
  Vec3,
  WallAxis,
  WallSeg,
} from "./types";

export const WALL_THICKNESS = 0.1;
/** Placement grid (metres): furniture and wall endpoints snap to this. */
export const GRID = 0.25;
export const DOOR_WIDTH = 0.9;
export const DOOR_HEIGHT = 2.05;
export const WINDOW_WIDTH = 1.2;
export const WINDOW_HEIGHT = 1.2;
export const WINDOW_SILL = 0.9;

const EPS = 1e-3;
const approx = (a: number, b: number) => Math.abs(a - b) < EPS;

export function rectContains(r: Rect, x: number, z: number): boolean {
  return x >= r.x - EPS && x <= r.x + r.w + EPS && z >= r.z - EPS && z <= r.z + r.d + EPS;
}

/** Is the point strictly inside any room interior (used for exterior detection)? */
export function pointInAnyRoom(rooms: RoomDef[], x: number, z: number): boolean {
  return rooms.some(
    (r) =>
      x > r.rect.x + EPS &&
      x < r.rect.x + r.rect.w - EPS &&
      z > r.rect.z + EPS &&
      z < r.rect.z + r.rect.d - EPS,
  );
}

export function boundsOf(rooms: RoomDef[]): Rect {
  const minX = Math.min(...rooms.map((r) => r.rect.x));
  const minZ = Math.min(...rooms.map((r) => r.rect.z));
  const maxX = Math.max(...rooms.map((r) => r.rect.x + r.rect.w));
  const maxZ = Math.max(...rooms.map((r) => r.rect.z + r.rect.d));
  return { x: minX, z: minZ, w: maxX - minX, d: maxZ - minZ };
}

/** Build the four wall segments around every room, with exterior flags. Interior
 *  partitions are emitted once per room, so a shared wall has two coincident
 *  segments (one per neighbour) — harmless for rendering and BC. */
export function buildWalls(rooms: RoomDef[], height: number): WallSeg[] {
  const walls: WallSeg[] = [];
  const e = 0.05;
  let n = 0;

  const push = (
    roomId: string,
    axis: WallAxis,
    a: Vec2,
    b: Vec2,
    outwardSample: Vec2,
  ) => {
    const exterior = !pointInAnyRoom(rooms, outwardSample[0], outwardSample[1]);
    walls.push({
      id: `wall-${n++}`,
      axis,
      a,
      b,
      thickness: WALL_THICKNESS,
      height,
      exterior,
      roomId,
      openings: [],
    });
  };

  for (const room of rooms) {
    const { x, z, w, d } = room.rect;
    // west (x = x), outward -x
    push(room.id, "z", [x, z], [x, z + d], [x - e, z + d / 2]);
    // east (x = x+w), outward +x
    push(room.id, "z", [x + w, z], [x + w, z + d], [x + w + e, z + d / 2]);
    // south (z = z), outward -z
    push(room.id, "x", [x, z], [x + w, z], [x + w / 2, z - e]);
    // north (z = z+d), outward +z
    push(room.id, "x", [x, z + d], [x + w, z + d], [x + w / 2, z + d + e]);
  }
  return walls;
}

export interface SharedEdge {
  axis: WallAxis;
  line: number; // constant coord (x for axis "z", z for axis "x")
  start: number; // overlap interval along the wall
  end: number;
}

/** The shared boundary between two adjacent rooms, if any. */
export function sharedEdge(a: RoomDef, b: RoomDef): SharedEdge | null {
  const A = a.rect;
  const B = b.rect;
  // vertical shared wall (constant x): rooms side by side
  if (approx(A.x + A.w, B.x) || approx(B.x + B.w, A.x)) {
    const line = approx(A.x + A.w, B.x) ? A.x + A.w : A.x;
    const start = Math.max(A.z, B.z);
    const end = Math.min(A.z + A.d, B.z + B.d);
    if (end - start > DOOR_WIDTH * 0.5) return { axis: "z", line, start, end };
  }
  // horizontal shared wall (constant z): rooms stacked
  if (approx(A.z + A.d, B.z) || approx(B.z + B.d, A.z)) {
    const line = approx(A.z + A.d, B.z) ? A.z + A.d : A.z;
    const start = Math.max(A.x, B.x);
    const end = Math.min(A.x + A.w, B.x + B.w);
    if (end - start > DOOR_WIDTH * 0.5) return { axis: "x", line, start, end };
  }
  return null;
}

/** Make an opening (door/window) on a wall line spanning [s, e]. */
export function makeOpening(
  id: string,
  kind: Opening["kind"],
  axis: WallAxis,
  line: number,
  s: number,
  e: number,
  rooms: [string, string | "outside"],
): Opening {
  const a: Vec2 = axis === "z" ? [line, s] : [s, line];
  const b: Vec2 = axis === "z" ? [line, e] : [e, line];
  return {
    id,
    kind,
    a,
    b,
    width: Math.abs(e - s),
    sill: kind === "door" ? 0 : WINDOW_SILL,
    height: kind === "door" ? DOOR_HEIGHT : WINDOW_HEIGHT,
    rooms,
    open: false,
  };
}

/** Interval covered by an opening along its wall's primary axis. */
export function openingSpan(o: Opening): { axis: WallAxis; line: number; s: number; e: number } {
  if (approx(o.a[0], o.b[0])) {
    // constant x → axis "z"
    return { axis: "z", line: o.a[0], s: Math.min(o.a[1], o.b[1]), e: Math.max(o.a[1], o.b[1]) };
  }
  return { axis: "x", line: o.a[1], s: Math.min(o.a[0], o.b[0]), e: Math.max(o.a[0], o.b[0]) };
}

/** Carve an opening into every wall lying on its line and covering its span. */
export function carveOpening(walls: WallSeg[], o: Opening): void {
  const span = openingSpan(o);
  for (const w of walls) {
    if (w.axis !== span.axis) continue;
    const wLine = w.axis === "z" ? w.a[0] : w.a[1];
    if (!approx(wLine, span.line)) continue;
    const wStart = w.axis === "z" ? Math.min(w.a[1], w.b[1]) : Math.min(w.a[0], w.b[0]);
    const wEnd = w.axis === "z" ? Math.max(w.a[1], w.b[1]) : Math.max(w.a[0], w.b[0]);
    if (span.s >= wStart - EPS && span.e <= wEnd + EPS) {
      w.openings.push(o);
    }
  }
}

// ---- rendering helpers ----

export interface WallPiece {
  center: Vec3;
  size: Vec3;
}

/** Decompose a wall into solid boxes around its openings, for rendering. Doors
 *  keep a header (lintel) above them; windows keep a sill below and a header
 *  above. The glass / door panel itself is drawn separately (OpeningLeaf), so no
 *  void is left above a door. Works in plan (un-centred) coordinates. */
export function wallPieces(w: WallSeg): WallPiece[] {
  const line = w.axis === "z" ? w.a[0] : w.a[1];
  const start = w.axis === "z" ? Math.min(w.a[1], w.b[1]) : Math.min(w.a[0], w.b[0]);
  const end = w.axis === "z" ? Math.max(w.a[1], w.b[1]) : Math.max(w.a[0], w.b[0]);
  const t = w.thickness;
  const h = w.height;

  const box = (s: number, e: number, y0: number, y1: number): WallPiece => {
    const along = (s + e) / 2;
    const len = e - s;
    const yc = (y0 + y1) / 2;
    const yh = y1 - y0;
    const center: Vec3 = w.axis === "z" ? [line, yc, along] : [along, yc, line];
    const size: Vec3 = w.axis === "z" ? [t, yh, len] : [len, yh, t];
    return { center, size };
  };

  const openings = [...w.openings].sort((o1, o2) => openingSpan(o1).s - openingSpan(o2).s);
  const pieces: WallPiece[] = [];
  let cursor = start;

  for (const o of openings) {
    const sp = openingSpan(o);
    const s = Math.max(sp.s, start);
    const e = Math.min(sp.e, end);
    if (s > cursor + EPS) pieces.push(box(cursor, s, 0, h)); // solid run before opening
    const top = o.sill + o.height;
    if (o.sill > EPS) pieces.push(box(s, e, 0, o.sill)); // sill below (windows)
    if (top < h - EPS) pieces.push(box(s, e, top, h)); // header above (doors + windows)
    cursor = Math.max(cursor, e);
  }
  if (cursor < end - EPS) pieces.push(box(cursor, end, 0, h));
  return pieces;
}

export function roomCenter(r: Rect): Vec2 {
  return [r.x + r.w / 2, r.z + r.d / 2];
}
