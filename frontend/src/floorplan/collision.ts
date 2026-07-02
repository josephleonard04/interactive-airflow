import type { FloorPlan, Opening, PlacedItem, Rect, RoomDef, Vec3 } from "./types";

// Object collision: two objects may not occupy the same space. We treat each
// item as its rotation-aware x-z footprint. Only items at the SAME mount level
// physically collide (a floor lamp and a wall AC can share x-z because they are
// at different heights), which matches reality.

/** Rotation-aware half-extents [hx, hz] (a 90°/270° yaw swaps width/depth). */
export function footHalf(size: Vec3, rotationY: number): [number, number] {
  const swapped = Math.abs(Math.round(rotationY / (Math.PI / 2))) % 2 === 1;
  return swapped ? [size[2] / 2, size[0] / 2] : [size[0] / 2, size[2] / 2];
}

interface Box { x0: number; x1: number; z0: number; z1: number }

function boxOf(pos: Vec3, size: Vec3, rot: number): Box {
  const [hx, hz] = footHalf(size, rot);
  return { x0: pos[0] - hx, x1: pos[0] + hx, z0: pos[2] - hz, z1: pos[2] + hz };
}

function overlap(a: Box, b: Box, margin: number): boolean {
  return a.x1 > b.x0 + margin && a.x0 < b.x1 - margin && a.z1 > b.z0 + margin && a.z0 < b.z1 - margin;
}

/**
 * Keep-clear boxes for doors & windows: the opening span thickened across the
 * wall plus clearance in front on both sides, so no object blocks a doorway or
 * sits in front of a window.
 */
export function openingClearBoxes(openings: Opening[], clear = 0.4): Box[] {
  const out: Box[] = [];
  for (const o of openings) {
    const vertical = Math.abs(o.a[0] - o.b[0]) < 1e-3; // constant x → spans z
    if (vertical) {
      const x = o.a[0];
      const [z0, z1] = [Math.min(o.a[1], o.b[1]), Math.max(o.a[1], o.b[1])];
      out.push({ x0: x - clear, x1: x + clear, z0: z0 - 0.05, z1: z1 + 0.05 });
    } else {
      const z = o.a[1];
      const [x0, x1] = [Math.min(o.a[0], o.b[0]), Math.max(o.a[0], o.b[0])];
      out.push({ x0: x0 - 0.05, x1: x1 + 0.05, z0: z - clear, z1: z + clear });
    }
  }
  return out;
}

export function allOpenings(plan: Pick<FloorPlan, "doors" | "windows">): Opening[] {
  return [...plan.doors, ...plan.windows];
}

/** Does a footprint at `pos` overlap any same-level item in `others`? */
export function collides(
  pos: Vec3,
  size: Vec3,
  rot: number,
  mount: string,
  others: PlacedItem[],
  margin = 0.02,
  keepClear: Box[] = [],
): boolean {
  const a = boxOf(pos, size, rot);
  for (const o of others) {
    if (o.mount !== mount) continue;
    if (overlap(a, boxOf(o.position, o.size, o.rotationY), margin)) return true;
  }
  // Openings block every mount level: floor items block doorways; wall items
  // must not sit on a window/door either.
  for (const b of keepClear) {
    if (overlap(a, b, 0)) return true;
  }
  return false;
}

export type SearchAxis = "area" | "x" | "z";

/**
 * Find the nearest free spot to `prefer` inside `room` where the item's
 * footprint clears every same-level object in `others` AND every door/window
 * clearance zone. `axis` restricts the search: "x"/"z" keep the item on its
 * wall line (varying one axis); "area" scans the whole room. Returns null if
 * nothing fits — it NEVER returns an overlapping position; callers must skip
 * the move (two objects may not share a space).
 */
export function findFreeSpot(
  room: Rect,
  item: { size: Vec3; rotationY: number; mount: string },
  others: PlacedItem[],
  prefer: Vec3,
  axis: SearchAxis = "area",
  margin = 0.04,
  openings: Opening[] = [],
  /** Wall-bound items (AC, heater) must NOT drift into the room interior. */
  allowAreaFallback = true,
): Vec3 | null {
  const [hx, hz] = footHalf(item.size, item.rotationY);
  const minX = room.x + hx + 0.06;
  const maxX = room.x + room.w - hx - 0.06;
  const minZ = room.z + hz + 0.06;
  const maxZ = room.z + room.d - hz - 0.06;
  if (minX > maxX || minZ > maxZ) return null; // item doesn't fit in the room at all
  const keepClear = openingClearBoxes(openings);

  const cands: Vec3[] = [];
  const step = 0.15;
  if (axis === "x") {
    for (let x = minX; x <= maxX; x += step) cands.push([x, prefer[1], prefer[2]]);
  } else if (axis === "z") {
    for (let z = minZ; z <= maxZ; z += step) cands.push([prefer[0], prefer[1], z]);
  } else {
    for (let x = minX; x <= maxX; x += step)
      for (let z = minZ; z <= maxZ; z += step) cands.push([x, prefer[1], z]);
  }
  // nearest to the preferred (ideal) location first, so items barely move
  cands.sort(
    (a, b) =>
      (a[0] - prefer[0]) ** 2 + (a[2] - prefer[2]) ** 2 - ((b[0] - prefer[0]) ** 2 + (b[2] - prefer[2]) ** 2),
  );
  for (const c of cands) {
    if (!collides(c, item.size, item.rotationY, item.mount, others, margin, keepClear)) return c;
  }
  // a line search that found nothing may widen to the whole room — but only
  // for free-standing items; wall-mounted devices stay on their wall line.
  if (axis !== "area" && allowAreaFallback) {
    return findFreeSpot(room, item, others, prefer, "area", margin, openings, false);
  }
  return null;
}

/**
 * Push apart any overlapping floor items in a generated/edited plan: each item
 * that overlaps an already-kept one is nudged to the nearest free spot in its
 * room. Fixes furniture generated on top of each other (e.g. desk vs closet).
 */
export function resolveOverlaps(items: PlacedItem[], rooms: RoomDef[], openings: Opening[] = []): PlacedItem[] {
  const keepClear = openingClearBoxes(openings);
  const kept: PlacedItem[] = [];
  const out: PlacedItem[] = [];
  for (const it of items) {
    if (it.mount !== "floor" || !collides(it.position, it.size, it.rotationY, it.mount, kept, 0.02, keepClear)) {
      kept.push(it);
      out.push(it);
      continue;
    }
    const room = rooms.find((r) => r.id === it.roomId);
    const pos = room ? findFreeSpot(room.rect, it, kept, it.position, "area", 0.04, openings) : null;
    const moved = pos ? { ...it, position: pos } : it;
    kept.push(moved);
    out.push(moved);
  }
  return out;
}
