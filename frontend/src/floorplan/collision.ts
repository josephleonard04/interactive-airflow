import type { PlacedItem, Rect, RoomDef, Vec3 } from "./types";

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

/** Does a footprint at `pos` overlap any same-level item in `others`? */
export function collides(
  pos: Vec3,
  size: Vec3,
  rot: number,
  mount: string,
  others: PlacedItem[],
  margin = 0.02,
): boolean {
  const a = boxOf(pos, size, rot);
  for (const o of others) {
    if (o.mount !== mount) continue;
    if (overlap(a, boxOf(o.position, o.size, o.rotationY), margin)) return true;
  }
  return false;
}

export type SearchAxis = "area" | "x" | "z";

/**
 * Find the nearest free spot to `prefer` inside `room` where the item's
 * footprint clears every same-level object in `others`. `axis` restricts the
 * search: "x"/"z" keep the item on its wall line (varying one axis); "area"
 * scans the whole room. Falls back to a wall-clamped `prefer` if nothing fits.
 */
export function findFreeSpot(
  room: Rect,
  item: { size: Vec3; rotationY: number; mount: string },
  others: PlacedItem[],
  prefer: Vec3,
  axis: SearchAxis = "area",
  margin = 0.04,
): Vec3 {
  const [hx, hz] = footHalf(item.size, item.rotationY);
  const minX = room.x + hx + 0.06;
  const maxX = room.x + room.w - hx - 0.06;
  const minZ = room.z + hz + 0.06;
  const maxZ = room.z + room.d - hz - 0.06;
  const clampX = (x: number) => Math.max(minX, Math.min(maxX, x));
  const clampZ = (z: number) => Math.max(minZ, Math.min(maxZ, z));

  const cands: Vec3[] = [];
  const step = 0.25;
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
    if (!collides(c, item.size, item.rotationY, item.mount, others, margin)) return c;
  }
  return [clampX(prefer[0]), prefer[1], clampZ(prefer[2])];
}

/**
 * Push apart any overlapping floor items in a generated/edited plan: each item
 * that overlaps an already-kept one is nudged to the nearest free spot in its
 * room. Fixes furniture generated on top of each other (e.g. desk vs closet).
 */
export function resolveOverlaps(items: PlacedItem[], rooms: RoomDef[]): PlacedItem[] {
  const kept: PlacedItem[] = [];
  const out: PlacedItem[] = [];
  for (const it of items) {
    if (it.mount !== "floor" || !collides(it.position, it.size, it.rotationY, it.mount, kept)) {
      kept.push(it);
      out.push(it);
      continue;
    }
    const room = rooms.find((r) => r.id === it.roomId);
    if (!room) {
      kept.push(it);
      out.push(it);
      continue;
    }
    const pos = findFreeSpot(room.rect, it, kept, it.position, "area");
    const moved = { ...it, position: pos };
    kept.push(moved);
    out.push(moved);
  }
  return out;
}
