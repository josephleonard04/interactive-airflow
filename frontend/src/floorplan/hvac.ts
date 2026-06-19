import type { PlacedItem, RoomDef, Vec3 } from "./types";
import type { IdGen } from "./furniture";

// Minimal, sensible HVAC:
//   - one ceiling supply diffuser per conditioned room (living/bedroom/kitchen/dining),
//   - ONE central return grille in the hallway (or the main living space) — return
//     air is collected centrally, not scattered into every room,
//   - one wall-mounted AC unit in the main living space,
//   - a ceiling exhaust fan in each bathroom,
//   - optional ceiling fans in bedrooms + living room.

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

  // supply diffuser in each conditioned room
  for (const room of rooms) {
    if (CONDITIONED.has(room.type) || room.program === "studio") {
      items.push(
        hvac(gen("supply"), "supply", room.id, ceilingCentre(room, wallHeight), [0.5, 0.14, 0.5], "ceiling", 0.12),
      );
    }
    // bathroom exhaust fan
    if (room.type === "bathroom") {
      items.push(
        hvac(gen("fan"), "fan", room.id, ceilingCentre(room, wallHeight, wallHeight - 0.12), [0.3, 0.12, 0.3], "ceiling", 0.05),
      );
    }
  }

  // a single central return
  const hallway = rooms.find((r) => r.type === "hallway");
  const living =
    rooms.find((r) => r.program === "studio") ?? rooms.find((r) => r.type === "living");
  const returnHost = hallway ?? living;
  if (returnHost) {
    items.push(
      hvac(gen("return"), "return", returnHost.id, ceilingCentre(returnHost, wallHeight), [0.7, 0.14, 0.7], "ceiling", 0.2),
    );
  }

  // wall-mounted AC unit (mini-split) in the main living space
  if (living) {
    const { x, z, w, d } = living.rect;
    items.push(
      hvac(gen("ac"), "ac", living.id, [x + w / 2, wallHeight - 0.55, z + d - 0.2], [0.85, 0.32, 0.22], "wall", 0.25),
    );
  }

  // optional ceiling fans
  if (opts.fans) {
    for (const room of rooms) {
      if (room.type === "bedroom" || room.type === "living" || room.program === "studio") {
        items.push(
          hvac(gen("fan"), "fan", room.id, ceilingCentre(room, wallHeight, wallHeight - 0.25), [0.9, 0.16, 0.9], "ceiling", 0),
        );
      }
    }
  }

  return items;
}
