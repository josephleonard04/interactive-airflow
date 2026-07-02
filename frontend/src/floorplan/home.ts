import {
  DOOR_WIDTH,
  WINDOW_WIDTH,
  boundsOf,
  buildWalls,
  carveOpening,
  makeOpening,
  sharedEdge,
} from "./geometry";
import { rasterize } from "./raster";
import { resolveOverlaps } from "./collision";
import type { FloorPlan, HomeSize, Opening, PlacedItem, RoomDef, Vec3, WallSeg } from "./types";

// A single, fixed home: living room, bedroom, kitchen, bathroom, with the
// entrance opening into the living room. Everything is parametric to the
// user-entered dimensions (length x, width z, height y, in metres). Objects are
// a minimal, curated set placed against walls while avoiding doorways.

export const MIN_LENGTH = 5;
export const MIN_WIDTH = 4;
export const MIN_HEIGHT = 2.3;

type Side = "north" | "south" | "east" | "west";
type IdGen = (p: string) => string;

function idGen(): IdGen {
  const c: Record<string, number> = {};
  return (p) => `${p}-${(c[p] = (c[p] ?? 0) + 1)}`;
}

function clampSize(s: HomeSize): HomeSize {
  return {
    length: Math.max(MIN_LENGTH, s.length),
    width: Math.max(MIN_WIDTH, s.width),
    height: Math.max(MIN_HEIGHT, s.height),
  };
}

function layout(L: number, W: number): RoomDef[] {
  const splitX = 0.6 * L;
  return [
    { id: "living", type: "living", name: "Living Room", rect: { x: 0, z: 0.45 * W, w: splitX, d: 0.55 * W } },
    { id: "bedroom", type: "bedroom", name: "Bedroom", rect: { x: 0, z: 0, w: splitX, d: 0.45 * W } },
    { id: "kitchen", type: "kitchen", name: "Kitchen", rect: { x: splitX, z: 0.5 * W, w: L - splitX, d: 0.5 * W } },
    { id: "bathroom", type: "bathroom", name: "Bathroom", rect: { x: splitX, z: 0, w: L - splitX, d: 0.5 * W } },
  ];
}

// ---- wall helpers ----

function wallLine(w: WallSeg): number {
  return w.axis === "z" ? w.a[0] : w.a[1];
}
function wallStart(w: WallSeg): number {
  return w.axis === "z" ? Math.min(w.a[1], w.b[1]) : Math.min(w.a[0], w.b[0]);
}
function wallEnd(w: WallSeg): number {
  return w.axis === "z" ? Math.max(w.a[1], w.b[1]) : Math.max(w.a[0], w.b[0]);
}
function wallLen(w: WallSeg): number {
  return wallEnd(w) - wallStart(w);
}

function openingAlong(o: Opening): [number, number] {
  const vertical = Math.abs(o.a[0] - o.b[0]) < 1e-3;
  return vertical
    ? [Math.min(o.a[1], o.b[1]), Math.max(o.a[1], o.b[1])]
    : [Math.min(o.a[0], o.b[0]), Math.max(o.a[0], o.b[0])];
}

function freeIntervals(w: WallSeg): Array<[number, number]> {
  const taken = w.openings.map(openingAlong).sort((p, q) => p[0] - q[0]);
  const out: Array<[number, number]> = [];
  let cursor = wallStart(w);
  for (const [s, e] of taken) {
    if (s > cursor) out.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < wallEnd(w)) out.push([cursor, wallEnd(w)]);
  return out;
}

function placeDoor(walls: WallSeg[], gen: IdGen, a: RoomDef, b: RoomDef, doors: Opening[]): void {
  const e = sharedEdge(a, b);
  if (!e) return;
  const mid = (e.start + e.end) / 2;
  const s = Math.max(e.start + 0.15, mid - DOOR_WIDTH / 2);
  const door = makeOpening(gen("door"), "door", e.axis, e.line, s, s + DOOR_WIDTH, [a.id, b.id]);
  carveOpening(walls, door);
  doors.push(door);
}

function placeEntrance(walls: WallSeg[], gen: IdGen, room: RoomDef, doors: Opening[]): void {
  const ext = walls
    .filter((w) => w.roomId === room.id && w.exterior && wallLen(w) >= DOOR_WIDTH + 0.5)
    .sort((p, q) => wallLen(q) - wallLen(p));
  const wall = ext[0];
  if (!wall) return;
  const mid = (wallStart(wall) + wallEnd(wall)) / 2;
  const s = mid - DOOR_WIDTH / 2;
  const door = makeOpening(gen("door"), "door", wall.axis, wallLine(wall), s, s + DOOR_WIDTH, [room.id, "outside"]);
  carveOpening(walls, door);
  doors.push(door);
}

/** One window per room, centred on the widest free run of its longest exterior wall. */
function placeWindows(walls: WallSeg[], gen: IdGen, rooms: RoomDef[]): Opening[] {
  const windows: Opening[] = [];
  for (const room of rooms) {
    const ext = walls.filter((w) => w.roomId === room.id && w.exterior && wallLen(w) >= WINDOW_WIDTH + 0.6);
    let best: { wall: WallSeg; iv: [number, number] } | null = null;
    for (const wall of ext) {
      for (const iv of freeIntervals(wall)) {
        if (iv[1] - iv[0] >= WINDOW_WIDTH + 0.4 && (!best || iv[1] - iv[0] > best.iv[1] - best.iv[0]))
          best = { wall, iv };
      }
    }
    if (!best) continue;
    const mid = (best.iv[0] + best.iv[1]) / 2;
    const win = makeOpening(
      gen("window"),
      "window",
      best.wall.axis,
      wallLine(best.wall),
      mid - WINDOW_WIDTH / 2,
      mid + WINDOW_WIDTH / 2,
      [room.id, "outside"],
    );
    carveOpening(walls, win);
    windows.push(win);
  }
  return windows;
}

// ---- door-aware object placement ----

type DoorsBySide = Record<Side, Array<[number, number]>>;

function doorsForRoom(room: RoomDef, openings: Opening[]): DoorsBySide {
  const { x, z, w, d } = room.rect;
  const out: DoorsBySide = { north: [], south: [], east: [], west: [] };
  const eq = (a: number, b: number) => Math.abs(a - b) < 1e-3;
  for (const o of openings) {
    const vertical = eq(o.a[0], o.b[0]);
    const [s, e] = openingAlong(o);
    if (vertical) {
      if (eq(o.a[0], x)) out.west.push([s, e]);
      else if (eq(o.a[0], x + w)) out.east.push([s, e]);
    } else {
      if (eq(o.a[1], z)) out.south.push([s, e]);
      else if (eq(o.a[1], z + d)) out.north.push([s, e]);
    }
  }
  return out;
}

/** Choose a centre near `frac` along the wall that fits `len` and clears doors. */
function freeCentre(lo: number, hi: number, len: number, frac: number, doors: Array<[number, number]>): number {
  const margin = len / 2 + 0.05;
  const clamp = (c: number) => Math.min(hi - margin, Math.max(lo + margin, c));
  const blocked = (c: number) =>
    doors.some(([ds, de]) => c + len / 2 > ds - 0.35 && c - len / 2 < de + 0.35);
  const want = clamp(lo + frac * (hi - lo));
  if (!blocked(want)) return want;
  for (let step = 0.1; step <= hi - lo; step += 0.1) {
    for (const c of [want + step, want - step]) {
      const cc = clamp(c);
      if (!blocked(cc)) return cc;
    }
  }
  return want;
}

const ROT: Record<Side, number> = { south: 0, north: Math.PI, west: Math.PI / 2, east: -Math.PI / 2 };

interface PlaceOpts {
  category?: "furniture" | "hvac";
  mount?: "floor" | "wall" | "ceiling";
  y?: number;
  flow?: number;
}

/** Place an item against a wall (back to the wall, facing into the room),
 *  size = [width-along-wall, height, depth-into-room]. */
function against(
  gen: IdGen,
  room: RoomDef,
  ctx: DoorsBySide,
  side: Side,
  frac: number,
  type: string,
  size: Vec3,
  opts: PlaceOpts = {},
): PlacedItem {
  const { x, z, w, d } = room.rect;
  const [sw, sh, sd] = size;
  const gap = 0.06;
  let cx = 0;
  let cz = 0;
  if (side === "south") {
    cz = z + sd / 2 + gap;
    cx = freeCentre(x, x + w, sw, frac, ctx.south);
  } else if (side === "north") {
    cz = z + d - sd / 2 - gap;
    cx = freeCentre(x, x + w, sw, frac, ctx.north);
  } else if (side === "west") {
    cx = x + sd / 2 + gap;
    cz = freeCentre(z, z + d, sw, frac, ctx.west);
  } else {
    cx = x + w - sd / 2 - gap;
    cz = freeCentre(z, z + d, sw, frac, ctx.east);
  }
  const mount = opts.mount ?? "floor";
  const y = mount === "floor" ? sh / 2 : opts.y ?? 1.1;
  return {
    id: gen(type),
    category: opts.category ?? "furniture",
    type,
    roomId: room.id,
    position: [cx, y, cz],
    size,
    rotationY: ROT[side],
    mount,
    flow: opts.flow,
    movable: true,
  };
}

function centre(gen: IdGen, room: RoomDef, type: string, size: Vec3, opts: PlaceOpts = {}): PlacedItem {
  const { x, z, w, d } = room.rect;
  const mount = opts.mount ?? "floor";
  const y = mount === "ceiling" ? opts.y ?? 0 : size[1] / 2;
  return {
    id: gen(type),
    category: opts.category ?? "furniture",
    type,
    roomId: room.id,
    position: [x + w / 2, y, z + d / 2],
    size,
    rotationY: 0,
    mount,
    flow: opts.flow,
    movable: true,
  };
}

function placeObjects(gen: IdGen, rooms: RoomDef[], openings: Opening[], H: number): PlacedItem[] {
  const byId = (id: string) => rooms.find((r) => r.id === id)!;
  // furniture avoids BOTH doors and windows so it never blocks an opening
  const ctx = (id: string) => doorsForRoom(byId(id), openings);
  const items: PlacedItem[] = [];

  // Bedroom: bed, desk, closet, and a standing floor fan in a corner.
  {
    const room = byId("bedroom");
    const c = ctx("bedroom");
    items.push(against(gen, room, c, "west", 0.45, "bed", [1.5, 0.5, 2.0]));
    items.push(against(gen, room, c, "south", 0.72, "desk", [1.2, 0.75, 0.6]));
    items.push(against(gen, room, c, "east", 0.3, "closet", [1.0, 2.0, 0.6]));
    items.push(against(gen, room, c, "south", 0.16, "fan", [0.45, 1.3, 0.45], { category: "hvac", mount: "floor", flow: 0 }));
  }

  // Living: couch (south) facing TV (north) across the room; table in the
  // middle; AC on the east wall; heater + supply vent. Placement avoids the
  // entrance and the window (which take the longer walls).
  {
    const room = byId("living");
    const c = ctx("living");
    items.push(against(gen, room, c, "south", 0.22, "couch", [1.8, 0.8, 0.85]));
    items.push(against(gen, room, c, "north", 0.22, "tv", [1.4, 0.8, 0.1], { mount: "wall", y: 1.0 }));
    items.push(centre(gen, room, "table", [1.1, 0.45, 0.7]));
    items.push(against(gen, room, c, "east", 0.3, "ac", [0.85, 0.32, 0.22], { category: "hvac", mount: "wall", y: H - 0.5, flow: 0.25 }));
    items.push(against(gen, room, c, "north", 0.8, "heater", [0.8, 0.5, 0.18], { category: "hvac", mount: "floor", flow: 0 }));
    items.push(centre(gen, room, "supply", [0.5, 0.14, 0.5], { category: "hvac", mount: "ceiling", y: H - 0.09, flow: 0.12 }));
  }

  // Kitchen: fridge + sink along the exterior (north) wall.
  {
    const room = byId("kitchen");
    const c = ctx("kitchen");
    items.push(against(gen, room, c, "north", 0.82, "fridge", [0.7, 1.8, 0.7]));
    items.push(against(gen, room, c, "north", 0.35, "sink", [0.7, 0.9, 0.55]));
  }

  // Bathroom: bathtub, toilet, sink.
  {
    const room = byId("bathroom");
    const c = ctx("bathroom");
    items.push(against(gen, room, c, "east", 0.5, "bathtub", [1.6, 0.6, 0.75]));
    items.push(against(gen, room, c, "west", 0.25, "toilet", [0.55, 0.75, 0.7]));
    items.push(against(gen, room, c, "west", 0.72, "sink", [0.7, 0.9, 0.55]));
  }

  return items;
}

export function generateHome(rawSize: HomeSize): FloorPlan {
  const size = clampSize(rawSize);
  const { length: L, width: W, height: H } = size;
  const gen = idGen();
  const rooms = layout(L, W);
  const bounds = boundsOf(rooms);

  const walls = buildWalls(rooms, H);
  const byId = (id: string) => rooms.find((r) => r.id === id)!;
  const doors: Opening[] = [];
  placeDoor(walls, gen, byId("living"), byId("bedroom"), doors);
  placeDoor(walls, gen, byId("living"), byId("kitchen"), doors);
  placeDoor(walls, gen, byId("kitchen"), byId("bathroom"), doors);
  placeEntrance(walls, gen, byId("living"), doors);

  const windows = placeWindows(walls, gen, rooms);
  const items = resolveOverlaps(placeObjects(gen, rooms, [...doors, ...windows], H), rooms);
  const grid = rasterize(rooms, bounds);

  return { name: "My Home", size, bounds, wallHeight: H, rooms, walls, doors, windows, items, grid };
}

/** "Start from scratch": just the outer walls + an entrance. One open room so
 *  placement/confinement works; the user adds interior walls and furniture. */
export function generateEmpty(rawSize: HomeSize): FloorPlan {
  const size = clampSize(rawSize);
  const { length: L, width: W, height: H } = size;
  const gen = idGen();
  const room: RoomDef = { id: "home", type: "living", name: "Home", rect: { x: 0, z: 0, w: L, d: W } };
  const rooms = [room];
  const bounds = boundsOf(rooms);
  const walls = buildWalls(rooms, H);
  const doors: Opening[] = [];
  placeEntrance(walls, gen, room, doors);
  const grid = rasterize(rooms, bounds);
  return { name: "My Home", size, bounds, wallHeight: H, rooms, walls, doors, windows: [], items: [], grid };
}
