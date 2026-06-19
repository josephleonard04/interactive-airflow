import {
  DOOR_WIDTH,
  WINDOW_WIDTH,
  boundsOf,
  buildWalls,
  carveOpening,
  makeOpening,
  sharedEdge,
} from "./geometry";
import { furnishRoom, type IdGen } from "./furniture";
import { placeHvac } from "./hvac";
import { rasterize } from "./raster";
import { TEMPLATES } from "./templates";
import type { FloorPlan, HousingType, Opening, RoomDef, WallSeg } from "./types";

const HABITABLE = new Set(["living", "bedroom", "kitchen", "dining"]);

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

/** Free intervals along a wall not already taken by an opening. */
function freeIntervals(w: WallSeg): Array<[number, number]> {
  const { start, end } = wallRange(w);
  const taken = w.openings
    .map((o) => {
      const s = w.axis === "z" ? Math.min(o.a[1], o.b[1]) : Math.min(o.a[0], o.b[0]);
      const e = w.axis === "z" ? Math.max(o.a[1], o.b[1]) : Math.max(o.a[0], o.b[0]);
      return [s, e] as [number, number];
    })
    .sort((p, q) => p[0] - q[0]);
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

function placeWindows(rooms: RoomDef[], walls: WallSeg[], gen: IdGen): Opening[] {
  const windows: Opening[] = [];
  for (const room of rooms) {
    const isHabitable = HABITABLE.has(room.type) || room.program === "studio";
    if (!isHabitable) continue;

    const ext = walls
      .filter((w) => w.roomId === room.id && w.exterior && wallLength(w) >= WINDOW_WIDTH + 0.6)
      .sort((p, q) => wallLength(q) - wallLength(p));
    if (ext.length === 0) continue;

    // pick the exterior wall with the longest free run.
    let best: { wall: WallSeg; interval: [number, number]; len: number } | null = null;
    for (const w of ext) {
      for (const iv of freeIntervals(w)) {
        const len = iv[1] - iv[0];
        if (len >= WINDOW_WIDTH + 0.4 && (!best || len > best.len)) best = { wall: w, interval: iv, len };
      }
    }
    if (!best) continue;

    const { wall, interval } = best;
    const mid = (interval[0] + interval[1]) / 2;
    const s = mid - WINDOW_WIDTH / 2;
    const e = mid + WINDOW_WIDTH / 2;
    const { line } = wallRange(wall);
    const win = makeOpening(gen("window"), "window", wall.axis, line, s, e, [room.id, "outside"]);
    carveOpening(walls, win);
    windows.push(win);
  }
  return windows;
}

export function generateFloorPlan(housingType: HousingType): FloorPlan {
  const template = TEMPLATES[housingType];
  const gen = makeIdGen();
  const rooms = template.rooms.map((r) => ({ ...r, rect: { ...r.rect } }));
  const bounds = boundsOf(rooms);

  const walls = buildWalls(rooms, template.wallHeight);
  const doors = placeDoors(rooms, walls, template.connections, gen);
  const windows = placeWindows(rooms, walls, gen);

  const furniture = rooms.flatMap((room) => furnishRoom(gen, room));
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
