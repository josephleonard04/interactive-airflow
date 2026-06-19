import type { PlacedItem, RoomDef, Vec3 } from "./types";
import type { IdGen } from "./furniture";

// HVAC placement rules:
//   - a ceiling supply vent in every conditioned room (living/bedroom/kitchen/dining),
//   - central return vents in the hallway (or living room) and an exhaust in bathrooms,
//   - one wall-mounted AC unit in the main living space,
//   - optional ceiling fans in bedrooms and the living room.

const CONDITIONED = new Set(["living", "bedroom", "kitchen", "dining"]);

function hvac(
  id: string,
  type: string,
  roomId: string,
  position: Vec3,
  size: Vec3,
  mount: PlacedItem["mount"],
  flow: number,
): PlacedItem {
  return { id, category: "hvac", type, roomId, position, size, rotationY: 0, mount, flow, movable: true };
}

function ceilingCentre(room: RoomDef, wallHeight: number, y = wallHeight - 0.09): Vec3 {
  const { x, z, w, d } = room.rect;
  return [x + w / 2, y, z + d / 2];
}

export function placeHvac(
  gen: IdGen,
  rooms: RoomDef[],
  wallHeight: number,
  opts: { fans?: boolean } = {},
): PlacedItem[] {
  const items: PlacedItem[] = [];

  for (const room of rooms) {
    if (CONDITIONED.has(room.type) || room.program === "studio") {
      const c = ceilingCentre(room, wallHeight);
      items.push(hvac(gen("supply"), "supply", room.id, c, [0.5, 0.14, 0.5], "ceiling", 0.12));
    }
    if (room.type === "bathroom") {
      const c = ceilingCentre(room, wallHeight);
      items.push(hvac(gen("return"), "return", room.id, c, [0.35, 0.14, 0.35], "ceiling", 0.08));
    }
  }

  // central return: prefer a hallway, else the living room / studio main room.
  const hallway = rooms.find((r) => r.type === "hallway");
  const living =
    rooms.find((r) => r.program === "studio") ?? rooms.find((r) => r.type === "living");
  const returnHost = hallway ?? living;
  if (returnHost) {
    const c = ceilingCentre(returnHost, wallHeight);
    items.push(hvac(gen("return"), "return", returnHost.id, c, [0.6, 0.14, 0.6], "ceiling", 0.2));
  }

  // wall-mounted AC unit high on a wall of the main living space.
  if (living) {
    const { x, z, w, d } = living.rect;
    items.push(
      hvac(
        gen("ac"),
        "ac",
        living.id,
        [x + w / 2, wallHeight - 0.55, z + d - 0.2],
        [0.85, 0.32, 0.22],
        "wall",
        0.25,
      ),
    );
  }

  // optional ceiling fans
  if (opts.fans) {
    for (const room of rooms) {
      if (room.type === "bedroom" || room.type === "living" || room.program === "studio") {
        items.push(
          hvac(
            gen("fan"),
            "fan",
            room.id,
            ceilingCentre(room, wallHeight, wallHeight - 0.25),
            [0.9, 0.16, 0.9],
            "ceiling",
            0,
          ),
        );
      }
    }
  }

  return items;
}
