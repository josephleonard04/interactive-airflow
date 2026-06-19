import type { FurnishProgram, PlacedItem, RoomDef, Vec3 } from "./types";

// Rule-based, minimalist furniture placement. Each recipe is parameterised by
// the room rectangle, and placement actively AVOIDS door openings so nothing
// blocks a doorway or the path between rooms. Conventions:
//   - beds / sofas / counters go against walls (back to the wall),
//   - the TV faces the sofa from the opposite wall,
//   - dining tables sit near the kitchen / room centre,
//   - bathrooms get toilet + sink + shower along walls.

export type Side = "north" | "south" | "east" | "west";
export type IdGen = (prefix: string) => string;

/** Door intervals per wall side, in along-wall metric coordinates
 *  (x for north/south, z for east/west). */
export type DoorsBySide = Record<Side, Array<[number, number]>>;

export interface RoomContext {
  doors: DoorsBySide;
}

const GAP = 0.07; // clearance from the wall surface
const DOOR_CLEARANCE = 0.35; // keep furniture this far from a door opening

function item(
  id: string,
  type: string,
  roomId: string,
  position: Vec3,
  size: Vec3,
  rotationY = 0,
): PlacedItem {
  return { id, category: "furniture", type, roomId, position, size, rotationY, mount: "floor", movable: true };
}

/** Wall along-range for a side: [start, end] in the along coordinate. */
function alongRange(room: RoomDef, side: Side): [number, number] {
  const { x, z, w, d } = room.rect;
  return side === "north" || side === "south" ? [x, x + w] : [z, z + d];
}

/** Choose a centre along the wall near `preferred` that fits `len` and avoids
 *  door intervals (expanded by clearance). Falls back to preferred. */
function freeCentre(
  room: RoomDef,
  side: Side,
  len: number,
  preferredFrac: number,
  doors: Array<[number, number]>,
): number {
  const [lo, hi] = alongRange(room, side);
  const margin = len / 2 + 0.05;
  const clamp = (c: number) => Math.min(hi - margin, Math.max(lo + margin, c));
  const blocked = (c: number) =>
    doors.some(([ds, de]) => c + len / 2 > ds - DOOR_CLEARANCE && c - len / 2 < de + DOOR_CLEARANCE);

  const preferred = clamp(lo + preferredFrac * (hi - lo));
  if (!blocked(preferred)) return preferred;

  // scan outwards from preferred for the nearest free centre
  for (let step = 0.1; step <= hi - lo; step += 0.1) {
    for (const c of [preferred + step, preferred - step]) {
      const cc = clamp(c);
      if (!blocked(cc)) return cc;
    }
  }
  return preferred;
}

function against(
  gen: IdGen,
  room: RoomDef,
  ctx: RoomContext,
  side: Side,
  preferredFrac: number,
  type: string,
  size: Vec3,
  opts: { wallMount?: boolean; y?: number } = {},
): PlacedItem {
  const { x, z, w, d } = room.rect;
  const [sx, sy, sz] = size;
  const lenAlong = side === "north" || side === "south" ? sx : sz;
  const along = freeCentre(room, side, lenAlong, preferredFrac, ctx.doors[side]);

  let cx = 0;
  let cz = 0;
  if (side === "west") {
    cx = x + sx / 2 + GAP;
    cz = along;
  } else if (side === "east") {
    cx = x + w - sx / 2 - GAP;
    cz = along;
  } else if (side === "south") {
    cz = z + sz / 2 + GAP;
    cx = along;
  } else {
    cz = z + d - sz / 2 - GAP;
    cx = along;
  }
  const y = opts.wallMount ? (opts.y ?? 1.1) : sy / 2;
  const it = item(gen(type), type, room.id, [cx, y, cz], size);
  if (opts.wallMount) it.mount = "wall";
  return it;
}

function centre(gen: IdGen, room: RoomDef, type: string, size: Vec3, fx = 0.5, fz = 0.5): PlacedItem {
  const { x, z, w, d } = room.rect;
  return item(gen(type), type, room.id, [x + fx * w, size[1] / 2, z + fz * d], size);
}

function furnishBedroom(gen: IdGen, room: RoomDef, ctx: RoomContext): PlacedItem[] {
  return [
    against(gen, room, ctx, "north", 0.32, "bed", [1.5, 0.5, 2.0]),
    against(gen, room, ctx, "north", 0.66, "nightstand", [0.45, 0.5, 0.4]),
    against(gen, room, ctx, "south", 0.75, "desk", [1.2, 0.75, 0.6]),
  ];
}

function furnishLiving(gen: IdGen, room: RoomDef, ctx: RoomContext): PlacedItem[] {
  return [
    against(gen, room, ctx, "south", 0.5, "sofa", [2.0, 0.8, 0.9]),
    against(gen, room, ctx, "north", 0.5, "tv", [1.4, 0.8, 0.1], { wallMount: true, y: 1.0 }),
    centre(gen, room, "coffee_table", [1.0, 0.4, 0.5], 0.5, 0.62),
  ];
}

function furnishKitchen(gen: IdGen, room: RoomDef, ctx: RoomContext, withDining: boolean): PlacedItem[] {
  const { d } = room.rect;
  const items: PlacedItem[] = [
    against(gen, room, ctx, "west", 0.45, "counter", [0.6, 0.9, Math.min(d * 0.6, 2.2)]),
    against(gen, room, ctx, "west", 0.85, "fridge", [0.7, 1.8, 0.7]),
  ];
  if (withDining) items.push(centre(gen, room, "dining_table", [1.4, 0.75, 0.8], 0.66, 0.5));
  return items;
}

function furnishDining(gen: IdGen, room: RoomDef): PlacedItem[] {
  return [centre(gen, room, "dining_table", [1.6, 0.75, 0.9], 0.5, 0.5)];
}

function furnishBathroom(gen: IdGen, room: RoomDef, ctx: RoomContext): PlacedItem[] {
  return [
    against(gen, room, ctx, "west", 0.22, "toilet", [0.5, 0.6, 0.7]),
    against(gen, room, ctx, "west", 0.62, "sink", [0.6, 0.85, 0.45]),
    against(gen, room, ctx, "east", 0.8, "shower", [0.9, 2.0, 0.9]),
  ];
}

function furnishLaundry(gen: IdGen, room: RoomDef, ctx: RoomContext): PlacedItem[] {
  return [
    against(gen, room, ctx, "north", 0.35, "washer", [0.6, 0.85, 0.6]),
    against(gen, room, ctx, "north", 0.62, "dryer", [0.6, 0.85, 0.6]),
  ];
}

/** Open-plan studio: minimal set — bed, desk, sofa+TV, kitchen. */
function furnishStudio(gen: IdGen, room: RoomDef, ctx: RoomContext): PlacedItem[] {
  return [
    against(gen, room, ctx, "north", 0.2, "bed", [1.5, 0.5, 2.0]),
    against(gen, room, ctx, "west", 0.28, "desk", [0.6, 0.75, 1.2]),
    against(gen, room, ctx, "south", 0.32, "counter", [1.8, 0.9, 0.6]),
    against(gen, room, ctx, "south", 0.66, "fridge", [0.7, 1.8, 0.7]),
    against(gen, room, ctx, "east", 0.7, "sofa", [0.9, 0.8, 2.0]),
    against(gen, room, ctx, "west", 0.72, "tv", [0.1, 0.8, 1.4], { wallMount: true, y: 1.0 }),
  ];
}

export function programFor(room: RoomDef): FurnishProgram {
  if (room.program) return room.program;
  switch (room.type) {
    case "living":
      return "living";
    case "bedroom":
      return "bedroom";
    case "kitchen":
      return "kitchen";
    case "dining":
      return "dining";
    case "bathroom":
      return "bathroom";
    case "laundry":
      return "laundry";
    default:
      return "none";
  }
}

export function furnishRoom(gen: IdGen, room: RoomDef, ctx: RoomContext): PlacedItem[] {
  switch (programFor(room)) {
    case "studio":
      return furnishStudio(gen, room, ctx);
    case "bedroom":
      return furnishBedroom(gen, room, ctx);
    case "living":
      return furnishLiving(gen, room, ctx);
    case "kitchen":
      return furnishKitchen(gen, room, ctx, false);
    case "kitchen_dining":
      return furnishKitchen(gen, room, ctx, true);
    case "dining":
      return furnishDining(gen, room);
    case "bathroom":
      return furnishBathroom(gen, room, ctx);
    case "laundry":
      return furnishLaundry(gen, room, ctx);
    default:
      return [];
  }
}
