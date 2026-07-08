import { rasterize } from "./raster";
import type { FloorPlan, Opening, RoomDef, RoomType } from "./types";

// Room identity for USER-BUILT homes. The generated example home ships with
// named rooms, but a from-scratch home is one big "Home" region — so goals
// like "keep the bedroom cool" can't ground. Fix, in two passes:
//
//   recomputeRooms(plan)  – after any WALL change: flood-fill the floor with
//                           walls as barriers; every enclosed region becomes a
//                           room (bounding-rect approximation).
//   autoNameRooms(plan)   – after any ITEM change: a room is named by what's
//                           inside it (bed → Bedroom, fridge → Kitchen, …),
//                           which is how a non-expert thinks about rooms.
//
// User renames (renamed: true) always win over auto-naming.

const CELL = 0.25;
const MIN_AREA = 1.0; // m² — ignore slivers between walls

// furniture → room type, most specific first
const TYPE_HINTS: Array<{ types: string[]; room: RoomType }> = [
  { types: ["toilet", "bathtub"], room: "bathroom" },
  { types: ["kitchen_sink", "fridge"], room: "kitchen" },
  { types: ["bed", "crib"], room: "bedroom" },
  { types: ["couch", "tv"], room: "living" },
];
const TYPE_NAME: Record<RoomType, string> = {
  living: "Living Room",
  bedroom: "Bedroom",
  kitchen: "Kitchen",
  bathroom: "Bathroom",
};

interface Regions {
  cols: number;
  rows: number;
  label: Int32Array; // -1 wall/unassigned, else region index
  count: number;
  cellOf: (x: number, z: number) => number; // region index or -1
}

/** Flood-fill the floor grid using walls as barriers. */
function findRegions(plan: FloorPlan): Regions {
  const { bounds } = plan;
  const cols = Math.max(1, Math.round(bounds.w / CELL));
  const rows = Math.max(1, Math.round(bounds.d / CELL));
  const wall = new Uint8Array(cols * rows);

  for (const w of plan.walls) {
    const half = w.thickness / 2 + 0.02;
    if (w.axis === "x") {
      const z = w.a[1];
      const [x0, x1] = [Math.min(w.a[0], w.b[0]), Math.max(w.a[0], w.b[0])];
      const c0 = Math.max(0, Math.floor((x0 - bounds.x) / CELL));
      const c1 = Math.min(cols - 1, Math.ceil((x1 - bounds.x) / CELL) - 1);
      const r0 = Math.max(0, Math.floor((z - half - bounds.z) / CELL));
      const r1 = Math.min(rows - 1, Math.floor((z + half - bounds.z) / CELL));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) wall[r * cols + c] = 1;
    } else {
      const x = w.a[0];
      const [z0, z1] = [Math.min(w.a[1], w.b[1]), Math.max(w.a[1], w.b[1])];
      const r0 = Math.max(0, Math.floor((z0 - bounds.z) / CELL));
      const r1 = Math.min(rows - 1, Math.ceil((z1 - bounds.z) / CELL) - 1);
      const c0 = Math.max(0, Math.floor((x - half - bounds.x) / CELL));
      const c1 = Math.min(cols - 1, Math.floor((x + half - bounds.x) / CELL));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) wall[r * cols + c] = 1;
    }
  }

  const label = new Int32Array(cols * rows).fill(-1);
  let count = 0;
  const stack: number[] = [];
  for (let start = 0; start < cols * rows; start++) {
    if (wall[start] || label[start] !== -1) continue;
    const region = count++;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      if (wall[i] || label[i] !== -1) continue;
      label[i] = region;
      const c = i % cols;
      const r = (i / cols) | 0;
      if (c > 0) stack.push(i - 1);
      if (c < cols - 1) stack.push(i + 1);
      if (r > 0) stack.push(i - cols);
      if (r < rows - 1) stack.push(i + cols);
    }
  }

  const cellOf = (x: number, z: number) => {
    const c = Math.max(0, Math.min(cols - 1, Math.floor((x - bounds.x) / CELL)));
    const r = Math.max(0, Math.min(rows - 1, Math.floor((z - bounds.z) / CELL)));
    return label[r * cols + c];
  };
  return { cols, rows, label, count, cellOf };
}

/** Auto-name rooms from the furniture inside them (skips user-renamed rooms).
 *  Membership is judged by item position (smallest containing room rect), so
 *  it stays correct even when an item's roomId is stale after a drag. */
export function autoNameRooms(plan: FloorPlan): FloorPlan {
  const byRoom = new Map<string, string[]>(); // roomId -> item types inside
  for (const it of plan.items) {
    const containing = plan.rooms
      .filter((r) => it.position[0] >= r.rect.x && it.position[0] <= r.rect.x + r.rect.w && it.position[2] >= r.rect.z && it.position[2] <= r.rect.z + r.rect.d)
      .sort((a, b) => a.rect.w * a.rect.d - b.rect.w * b.rect.d)[0];
    if (!containing) continue;
    const arr = byRoom.get(containing.id) ?? [];
    arr.push(it.type);
    byRoom.set(containing.id, arr);
  }
  const used = new Map<string, number>();
  const rooms = plan.rooms.map((room) => {
    if (room.renamed) {
      used.set(room.name, (used.get(room.name) ?? 0) + 1);
      return room;
    }
    const inside = (byRoom.get(room.id) ?? []).map((t) => ({ type: t }));
    // score each room type by how many of its signature items are present;
    // ties go to the more specific type (earlier in TYPE_HINTS)
    let type: RoomType | null = null;
    let best = 0;
    for (const hint of TYPE_HINTS) {
      const score = inside.filter((it) => hint.types.includes(it.type)).length;
      if (score > best) { best = score; type = hint.room; }
    }
    if (!type) {
      used.set(room.name, (used.get(room.name) ?? 0) + 1);
      return room; // nothing recognizable — keep current name
    }
    const base = TYPE_NAME[type];
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    const name = n > 1 ? `${base} ${n}` : base;
    if (room.type === type && room.name === name) return room;
    return { ...room, type, name };
  });
  return { ...plan, rooms };
}

/**
 * Re-derive rooms from the current walls (call after any wall change).
 * Preserves ids/names of rooms whose centre still lands in a region, keeps
 * user renames, reassigns item roomIds, and relinks door/window room pairs.
 */
export function recomputeRooms(plan: FloorPlan): FloorPlan {
  const { bounds } = plan;
  const reg = findRegions(plan);

  // bounding rect + area per region
  const boxes = new Map<number, { c0: number; c1: number; r0: number; r1: number; n: number }>();
  for (let r = 0; r < reg.rows; r++)
    for (let c = 0; c < reg.cols; c++) {
      const g = reg.label[r * reg.cols + c];
      if (g < 0) continue;
      const b = boxes.get(g) ?? { c0: c, c1: c, r0: r, r1: r, n: 0 };
      b.c0 = Math.min(b.c0, c); b.c1 = Math.max(b.c1, c);
      b.r0 = Math.min(b.r0, r); b.r1 = Math.max(b.r1, r);
      b.n++;
      boxes.set(g, b);
    }

  // previous room whose centre lands in each region → keep id/name/type
  const prevByRegion = new Map<number, RoomDef>();
  for (const room of plan.rooms) {
    const g = reg.cellOf(room.rect.x + room.rect.w / 2, room.rect.z + room.rect.d / 2);
    if (g >= 0 && !prevByRegion.has(g)) prevByRegion.set(g, room);
  }

  let fresh = 0;
  const regionRoomId = new Map<number, string>();
  const rooms: RoomDef[] = [];
  for (const [g, b] of [...boxes.entries()].sort((p, q) => q[1].n - p[1].n)) {
    if (b.n * CELL * CELL < MIN_AREA) continue;
    const rect = {
      x: bounds.x + b.c0 * CELL,
      z: bounds.z + b.r0 * CELL,
      w: (b.c1 - b.c0 + 1) * CELL,
      d: (b.r1 - b.r0 + 1) * CELL,
    };
    const prev = prevByRegion.get(g);
    const id = prev?.id ?? `room-det-${++fresh}-${Date.now() % 100000}`;
    rooms.push({
      id,
      type: prev?.type ?? "living",
      name: prev?.name ?? `Room ${rooms.length + 1}`,
      rect,
      renamed: prev?.renamed,
    });
    regionRoomId.set(g, id);
  }
  if (rooms.length === 0) return plan; // degenerate — keep as-is

  const roomIdAt = (x: number, z: number): string => {
    const g = reg.cellOf(x, z);
    return (g >= 0 && regionRoomId.get(g)) || rooms[0].id;
  };

  // items follow their centre; openings re-probe both sides of their wall
  const items = plan.items.map((it) => ({ ...it, roomId: roomIdAt(it.position[0], it.position[2]) }));
  const relink = (o: Opening): Opening => {
    const vertical = Math.abs(o.a[0] - o.b[0]) < 1e-3;
    const mx = vertical ? o.a[0] : (o.a[0] + o.b[0]) / 2;
    const mz = vertical ? (o.a[1] + o.b[1]) / 2 : o.a[1];
    const probe = (sign: number): string | "outside" => {
      const px = vertical ? mx + sign * 0.3 : mx;
      const pz = vertical ? mz : mz + sign * 0.3;
      if (px < bounds.x || px > bounds.x + bounds.w || pz < bounds.z || pz > bounds.z + bounds.d) return "outside";
      const g = reg.cellOf(px, pz);
      const id = g >= 0 ? regionRoomId.get(g) : undefined;
      return id ?? "outside";
    };
    const a = probe(1);
    const b = probe(-1);
    const here = a !== "outside" ? a : b !== "outside" ? b : "outside";
    const other = here === a ? b : a;
    return { ...o, rooms: [here === "outside" ? rooms[0].id : here, other] };
  };
  const doors = plan.doors.map(relink);
  const windows = plan.windows.map(relink);
  const byId = new Map([...doors, ...windows].map((o) => [o.id, o]));
  const walls = plan.walls.map((w) => ({ ...w, openings: w.openings.map((o) => byId.get(o.id) ?? o) }));

  const next: FloorPlan = { ...plan, rooms, items, doors, windows, walls, grid: rasterize(rooms, bounds) };
  return autoNameRooms(next);
}
