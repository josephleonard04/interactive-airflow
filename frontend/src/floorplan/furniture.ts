import type { FurnishProgram, PlacedItem, RoomDef, Vec3 } from "./types";

// Rule-based furniture placement. Each recipe is parameterised by the room's
// rectangle, so the same rules produce sensible layouts for differently sized
// rooms. Conventions:
//   - beds / sofas / counters go against walls (back to the wall),
//   - desks go against a wall (ideally under a window — exterior walls),
//   - the TV faces the sofa from the opposite wall,
//   - dining tables sit near the kitchen / room centre,
//   - bathrooms get toilet + sink + shower along walls.
//
// Sizes are authored already-oriented for the chosen wall: against west/east
// walls the long dimension runs along z; against north/south it runs along x.

export type Side = "north" | "south" | "east" | "west";
export type IdGen = (prefix: string) => string;

const GAP = 0.07; // clearance from the wall surface

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

/** Place an item against a wall of the room. `along` is 0..1 across the wall. */
function against(
  gen: IdGen,
  room: RoomDef,
  side: Side,
  along: number,
  type: string,
  size: Vec3,
  opts: { wallMount?: boolean; y?: number } = {},
): PlacedItem {
  const { x, z, w, d } = room.rect;
  const [sx, sy, sz] = size;
  let cx = 0;
  let cz = 0;
  if (side === "west") {
    cx = x + sx / 2 + GAP;
    cz = z + along * d;
  } else if (side === "east") {
    cx = x + w - sx / 2 - GAP;
    cz = z + along * d;
  } else if (side === "south") {
    cz = z + sz / 2 + GAP;
    cx = x + along * w;
  } else {
    cz = z + d - sz / 2 - GAP;
    cx = x + along * w;
  }
  const y = opts.wallMount ? (opts.y ?? 1.1) : sy / 2;
  const it = item(gen(type), type, room.id, [cx, y, cz], size);
  if (opts.wallMount) it.mount = "wall";
  return it;
}

/** Place an item near the room centre, optionally offset by fractions of size. */
function centre(
  gen: IdGen,
  room: RoomDef,
  type: string,
  size: Vec3,
  fx = 0.5,
  fz = 0.5,
): PlacedItem {
  const { x, z, w, d } = room.rect;
  return item(gen(type), type, room.id, [x + fx * w, size[1] / 2, z + fz * d], size);
}

function furnishBedroom(gen: IdGen, room: RoomDef): PlacedItem[] {
  return [
    against(gen, room, "north", 0.32, "bed", [1.5, 0.5, 2.0]),
    against(gen, room, "north", 0.62, "nightstand", [0.45, 0.5, 0.4]),
    against(gen, room, "south", 0.78, "desk", [1.2, 0.75, 0.6]),
  ];
}

function furnishLiving(gen: IdGen, room: RoomDef): PlacedItem[] {
  return [
    against(gen, room, "south", 0.5, "sofa", [2.0, 0.8, 0.9]),
    against(gen, room, "north", 0.5, "tv", [1.4, 0.8, 0.1], { wallMount: true, y: 1.0 }),
    centre(gen, room, "coffee_table", [1.0, 0.4, 0.5], 0.5, 0.62),
  ];
}

function furnishKitchen(gen: IdGen, room: RoomDef, withDining: boolean): PlacedItem[] {
  const { d } = room.rect;
  const items: PlacedItem[] = [
    against(gen, room, "west", 0.45, "counter", [0.6, 0.9, Math.min(d * 0.6, 2.4)]),
    against(gen, room, "west", 0.85, "fridge", [0.7, 1.8, 0.7]),
  ];
  if (withDining) items.push(centre(gen, room, "dining_table", [1.4, 0.75, 0.8], 0.66, 0.5));
  return items;
}

function furnishDining(gen: IdGen, room: RoomDef): PlacedItem[] {
  return [centre(gen, room, "dining_table", [1.6, 0.75, 0.9], 0.5, 0.5)];
}

function furnishBathroom(gen: IdGen, room: RoomDef): PlacedItem[] {
  return [
    against(gen, room, "west", 0.22, "toilet", [0.5, 0.6, 0.7]),
    against(gen, room, "west", 0.6, "sink", [0.6, 0.85, 0.45]),
    against(gen, room, "east", 0.8, "shower", [0.9, 2.0, 0.9]),
  ];
}

function furnishLaundry(gen: IdGen, room: RoomDef): PlacedItem[] {
  return [
    against(gen, room, "north", 0.35, "washer", [0.6, 0.85, 0.6]),
    against(gen, room, "north", 0.62, "dryer", [0.6, 0.85, 0.6]),
  ];
}

/** Open-plan studio: bed + desk + kitchen + sofa/TV + dining in one room. */
function furnishStudio(gen: IdGen, room: RoomDef): PlacedItem[] {
  return [
    against(gen, room, "north", 0.2, "bed", [1.5, 0.5, 2.0]),
    against(gen, room, "north", 0.42, "nightstand", [0.45, 0.5, 0.4]),
    against(gen, room, "west", 0.25, "desk", [0.6, 0.75, 1.2]),
    against(gen, room, "south", 0.3, "counter", [1.8, 0.9, 0.6]),
    against(gen, room, "south", 0.62, "fridge", [0.7, 1.8, 0.7]),
    against(gen, room, "east", 0.7, "sofa", [0.9, 0.8, 2.0]),
    against(gen, room, "west", 0.72, "tv", [0.1, 0.8, 1.4], { wallMount: true, y: 1.0 }),
    centre(gen, room, "dining_table", [1.2, 0.75, 0.8], 0.46, 0.32),
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

export function furnishRoom(gen: IdGen, room: RoomDef): PlacedItem[] {
  switch (programFor(room)) {
    case "studio":
      return furnishStudio(gen, room);
    case "bedroom":
      return furnishBedroom(gen, room);
    case "living":
      return furnishLiving(gen, room);
    case "kitchen":
      return furnishKitchen(gen, room, false);
    case "kitchen_dining":
      return furnishKitchen(gen, room, true);
    case "dining":
      return furnishDining(gen, room);
    case "bathroom":
      return furnishBathroom(gen, room);
    case "laundry":
      return furnishLaundry(gen, room);
    default:
      return [];
  }
}
