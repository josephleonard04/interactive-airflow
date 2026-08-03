import type { FloorPlan, PlacedItem, Rect, Vec3 } from "../floorplan/types";
import { findFreeSpot, type SearchAxis } from "../floorplan/collision";

// Heuristic "solver" for the most effective device layout given a goal. Rather
// than an expensive sim-in-the-loop search, we use airflow domain rules to pick
// an effective location + facing for each relevant device:
//   - AC     -> high on the target room's back wall, blowing across the room
//   - Vent   -> ceiling centre of the target room (supplies fresh air down)
//   - Heater -> against a side wall on the floor, facing in
//   - Fan    -> room centre, oscillating to sweep the whole room
// Doors are opened so the effect reaches connected rooms. The result is shown
// in the Accept/Modify/Cancel review, so the user can always reject it.

export type OptimizeGoal = "cool" | "warm" | "ventilate" | "circulate" | "balanced";

/** Which device types this goal actively places/uses. */
export const GOAL_DEVICES: Record<OptimizeGoal, string[]> = {
  cool: ["ac", "fan"],
  warm: ["heater", "fan"],
  // AN EXTRACT IS A VENTILATION DEVICE. `return` was missing here, so on the
  // bathroom task — where the extract is the ONLY thing the participant may
  // move — the intersection of "devices this goal touches" and "devices this
  // task allows" was empty. The search dutifully ran, moved nothing, and
  // reported "Move the vent" on every card. That is the whole of why asking for
  // solutions did nothing there.
  ventilate: ["return", "supply", "fan"],
  circulate: ["fan", "supply", "return"],
  balanced: ["ac", "fan", "supply"],
};

export const DEVICE_LABEL: Record<string, string> = { ac: "AC", fan: "Fan", heater: "Heater", supply: "Vent" };

/** Device types a suggested solution may never move to a DIFFERENT room — it may
 *  only reposition them inside the room they are already in.
 *
 *  The heater. Asked to warm the bedroom, the search's cheapest answer is to
 *  carry the heater in there and stand it next to the bed, which is true, dull,
 *  and not the problem: these tasks are about getting heat from where it is
 *  produced to where it is wanted, through a doorway, and a suggestion that
 *  relocates the source deletes the task instead of solving it. It is also not
 *  how people live with a single heater in a living room. The fan is
 *  deliberately NOT on this list — moving air between rooms is exactly its job.
 *
 *  This binds the SEARCH only. Dragging the heater wherever you like by hand is
 *  still allowed; the participant is free to discover that for themselves. */
export const ROOM_BOUND_DEVICES = ["heater"];

export function largestRoom(plan: FloorPlan) {
  return plan.rooms.reduce((b, r) => (r.rect.w * r.rect.d > b.rect.w * b.rect.d ? r : b), plan.rooms[0]);
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** The most effective spot + facing for a device in a room (index spreads
 *  multiple devices of the same type along the room). */
export function deviceSpot(room: Rect, type: string, index: number, wallHeight: number): { position: Vec3; rotationY: number } {
  const cx = room.x + room.w / 2;
  const cz = room.z + room.d / 2;
  const spread = index * 0.8;
  const cxo = clamp(cx + spread, room.x + 0.4, room.x + room.w - 0.4);
  const czo = clamp(cz + spread, room.z + 0.4, room.z + room.d - 0.4);
  if (type === "ac") {
    // back (max-z) wall, mounted high, facing into the room (-z)
    return { position: [cxo, clamp(1.9, 0.6, wallHeight - 0.4), room.z + room.d - 0.14], rotationY: Math.PI };
  }
  if (type === "supply") {
    return { position: [cxo, wallHeight - 0.1, czo], rotationY: 0 };
  }
  if (type === "heater") {
    // west (min-x) wall on the floor, facing +x into the room
    return { position: [room.x + 0.2, 0.25, czo], rotationY: Math.PI / 2 };
  }
  // fan: centre of the room, on the floor (oscillates, so facing is nominal)
  return { position: [cxo, 0.65, czo], rotationY: 0 };
}

/** Which axis a device slides along to dodge collisions (walls slide 1D). */
function searchAxis(type: string): SearchAxis {
  if (type === "ac") return "x"; // back wall → slide horizontally
  if (type === "heater") return "z"; // side wall → slide along it
  return "area"; // fan (floor) / vent (ceiling) → search the room
}

export interface Relocation {
  items: PlacedItem[];
  changes: string[];
  targetName: string;
}

/**
 * Move the goal-relevant, switched-on devices to their most effective spots in
 * the target room (default: the largest room). Returns updated items + a
 * human-readable list of relocations.
 */
export function relocateForGoal(plan: FloorPlan, goal: OptimizeGoal, roomId: string | null): Relocation {
  const target = (roomId ? plan.rooms.find((r) => r.id === roomId) : null) ?? largestRoom(plan);
  // Rooms in placement priority: the target first, then the rest by size, so
  // multiple devices of a type spread across DIFFERENT rooms instead of piling
  // into one spot. (A targeted goal keeps the first of each type in the target.)
  const roomOrder = [target, ...plan.rooms.filter((r) => r.id !== target.id).sort((a, b) => b.rect.w * b.rect.d - a.rect.w * a.rect.d)];
  const wanted = GOAL_DEVICES[goal];
  const counts: Record<string, number> = {};
  const changes: string[] = [];
  const openings = [...plan.doors, ...plan.windows];

  // Mutable working copy so each placement avoids the already-placed objects
  // (no two objects share a space — furniture and earlier devices are obstacles).
  const items: PlacedItem[] = plan.items.map((it) => ({ ...it }));
  const toPlace = items.filter((it) => wanted.includes(it.type) && it.on !== false);

  for (const it of toPlace) {
    const index = counts[it.type] ?? 0;
    counts[it.type] = index + 1;
    const others = items.filter((o) => o.id !== it.id);
    // First device of a type serves the target room; extras cover other rooms.
    const preferred = roomOrder[Math.min(index, roomOrder.length - 1)];
    let placed = false;
    for (const room of [preferred, ...roomOrder.filter((r) => r.id !== preferred.id)]) {
      const spot = deviceSpot(room.rect, it.type, 0, plan.wallHeight);
      const pos = findFreeSpot(
        room.rect,
        { size: it.size, rotationY: spot.rotationY, mount: it.mount },
        others,
        spot.position,
        searchAxis(it.type),
        0.04,
        openings,
      );
      if (!pos) continue; // room is full — try the next room, never overlap
      const moved =
        Math.abs(pos[0] - it.position[0]) > 0.05 ||
        Math.abs(pos[2] - it.position[2]) > 0.05 ||
        Math.abs(spot.rotationY - it.rotationY) > 0.05;
      if (moved) {
        it.position = [pos[0], spot.position[1], pos[2]];
        it.rotationY = spot.rotationY;
        it.roomId = room.id;
        changes.push(`Moved ${DEVICE_LABEL[it.type] ?? it.type} to ${room.name}`);
      }
      placed = true;
      break;
    }
    if (!placed) changes.push(`${DEVICE_LABEL[it.type] ?? it.type}: no free spot — left in place`);
  }

  return { items, changes, targetName: target.name };
}
