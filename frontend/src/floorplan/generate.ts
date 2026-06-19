import {
  DOOR_WIDTH,
  WINDOW_WIDTH,
  boundsOf,
  buildWalls,
  carveOpening,
  makeOpening,
  sharedEdge,
} from "./geometry";
import { furnishRoom, type DoorsBySide, type IdGen, type RoomContext, type Side } from "./furniture";
import { placeHvac } from "./hvac";
import { rasterize } from "./raster";
import { TEMPLATES } from "./templates";
import type { FloorPlan, HousingType, Opening, RoomDef, WallSeg } from "./types";

// Rooms that get windows on their exterior walls.
const WINDOWED = new Set(["living", "bedroom", "kitchen", "dining", "bathroom"]);

function makeIdGen(): IdGen {
  const counters: Record<string, number> = {};
  return (prefix: string) => {
    counters[prefix] = (counters[prefix] ?? 0) + 1;
    return `${prefix}-${counters[prefix]}`;
  };
}

function wallLength(w: WallSeg): number {
  return w.axis === "z" ? Math.abs(w.b[1] - w.a[1]) : Math.abs(w.b[0] - w.a[0]);
}

function wallRange(w: WallSeg): { start: number; end: number; line: number } {
  if (w.axis === "z") {
    return { start: Math.min(w.a[1], w.b[1]), end: Math.max(w.a[1], w.b[1]), line: w.a[0] };
  }
  return { start: Math.min(w.a[0], w.b[0]), end: Math.max(w.a[0], w.b[0]), line: w.a[1] };
}

function openingAlong(o: Opening): [number, number] {
  const vertical = Math.abs(o.a[0] - o.b[0]) < 1e-3; // constant x → along z
  return vertical
    ? [Math.min(o.a[1], o.b[1]), Math.max(o.a[1], o.b[1])]
    : [Math.min(o.a[0], o.b[0]), Math.max(o.a[0], o.b[0])];
}

/** Free intervals along a wall not already taken by an opening. */
function freeIntervals(w: WallSeg): Array<[number, number]> {
  const { start, end } = wallRange(w);
  const taken = w.openings.map(openingAlong).sort((p, q) => p[0] - q[0]);
  const free: Array<[number, number]> = [];
  let cursor = start;
  for (const [s, e] of taken) {
    if (s > cursor) free.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < end) free.push([cursor, end]);
  return free;
}

function placeDoors(
  rooms: RoomDef[],
  walls: WallSeg[],
  connections: { a: string; b: string | "outside"; at?: number }[],
  gen: IdGen,
): Opening[] {
  const doors: Opening[] = [];
  const byId = new Map(rooms.map((r) => [r.id, r]));

  for (const conn of connections) {
    const at = conn.at ?? 0.5;
    if (conn.b === "outside") {
      const room = byId.get(conn.a);
      if (!room) continue;
      const ext = walls
        .filter((w) => w.roomId === conn.a && w.exterior && wallLength(w) >= DOOR_WIDTH + 0.4)
        .sort((p, q) => wallLength(q) - wallLength(p));
      const wall = ext[0];
      if (!wall) continue;
      const { start, end, line } = wallRange(wall);
      const mid = start + (end - start) * at;
      const s = Math.max(start + 0.15, mid - DOOR_WIDTH / 2);
      const e = Math.min(end - 0.15, s + DOOR_WIDTH);
      const door = makeOpening(gen("door"), "door", wall.axis, line, s, e, [conn.a, "outside"]);
      carveOpening(walls, door);
      doors.push(door);
      continue;
    }

    const a = byId.get(conn.a);
    const b = byId.get(conn.b);
    if (!a || !b) continue;
    const edge = sharedEdge(a, b);
    if (!edge) continue;
    const mid = edge.start + (edge.end - edge.start) * at;
    const s = Math.max(edge.start + 0.15, mid - DOOR_WIDTH / 2);
    const e = Math.min(edge.end - 0.15, s + DOOR_WIDTH);
    const door = makeOpening(gen("door"), "door", edge.axis, edge.line, s, e, [conn.a, conn.b]);
    carveOpening(walls, door);
    doors.push(door);
  }
  return doors;
}

/** A window on every exterior wall (with room for one) of a windowed room. */
function placeWindows(rooms: RoomDef[], walls: WallSeg[], gen: IdGen): Opening[] {
  const windows: Opening[] = [];
  for (const room of rooms) {
    if (!WINDOWED.has(room.type) && room.program !== "studio") continue;
    const ext = walls.filter(
      (w) => w.roomId === room.id && w.exterior && wallLength(w) >= WINDOW_WIDTH + 0.6,
    );
    for (const wall of ext) {
      // widest free run on this wall
      let best: [number, number] | null = null;
      for (const iv of freeIntervals(wall)) {
        if (iv[1] - iv[0] >= WINDOW_WIDTH + 0.4 && (!best || iv[1] - iv[0] > best[1] - best[0])) best = iv;
      }
      if (!best) continue;
      const mid = (best[0] + best[1]) / 2;
      const { line } = wallRange(wall);
      const win = makeOpening(
        gen("window"),
        "window",
        wall.axis,
        line,
        mid - WINDOW_WIDTH / 2,
        mid + WINDOW_WIDTH / 2,
        [room.id, "outside"],
      );
      carveOpening(walls, win);
      windows.push(win);
    }
  }
  return windows;
}

/** Which side of `room` an opening sits on, plus its along-interval. */
function doorsForRoom(room: RoomDef, doors: Opening[]): DoorsBySide {
  const { x, z, w, d } = room.rect;
  const out: DoorsBySide = { north: [], south: [], east: [], west: [] };
  const eq = (a: number, b: number) => Math.abs(a - b) < 1e-3;
  for (const o of doors) {
    const vertical = eq(o.a[0], o.b[0]); // constant x
    const [s, e] = openingAlong(o);
    if (vertical) {
      const lineX = o.a[0];
      if (eq(lineX, x) && s >= z - 0.01 && e <= z + d + 0.01) out.west.push([s, e]);
      else if (eq(lineX, x + w) && s >= z - 0.01 && e <= z + d + 0.01) out.east.push([s, e]);
    } else {
      const lineZ = o.a[1];
      if (eq(lineZ, z) && s >= x - 0.01 && e <= x + w + 0.01) out.south.push([s, e]);
      else if (eq(lineZ, z + d) && s >= x - 0.01 && e <= x + w + 0.01) out.north.push([s, e]);
    }
  }
  return out;
}

export function generateFloorPlan(housingType: HousingType): FloorPlan {
  const template = TEMPLATES[housingType];
  const gen = makeIdGen();
  const rooms = template.rooms.map((r) => ({ ...r, rect: { ...r.rect } }));
  const bounds = boundsOf(rooms);

  const walls = buildWalls(rooms, template.wallHeight);
  const doors = placeDoors(rooms, walls, template.connections, gen);
  const windows = placeWindows(rooms, walls, gen);

  // furniture is placed AFTER doors so it can avoid blocking doorways.
  const furniture = rooms.flatMap((room) => {
    const ctx: RoomContext = { doors: doorsForRoom(room, doors) };
    return furnishRoom(gen, room, ctx);
  });
  const hvac = placeHvac(gen, rooms, template.wallHeight, { fans: template.fans });

  const grid = rasterize(rooms, bounds);

  return {
    housingType,
    name: template.name,
    bounds,
    wallHeight: template.wallHeight,
    rooms,
    walls,
    doors,
    windows,
    items: [...furniture, ...hvac],
    grid,
  };
}

export type { Side };
