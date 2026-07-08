import type { FloorPlan, Rect } from "../floorplan/types";
import { computeRoomLevels } from "../sim/roomLevels";
import { parseGoal, type Objective } from "./objectives";

// Evaluate an intent objective against the simulation's steady-state result:
// does the room actually end up cool / warm / smell-free? This closes the
// intent→physics loop — a plain-language goal becomes a checkable physical
// outcome on the current home.

export interface Evaluation {
  objective: Objective;
  value: number | null; // the scalar level in the region (°C-ish for temp, 0..1 for smell)
  satisfied: boolean | null; // null = couldn't resolve the room
  summary: string;
}

const COOL_T = -1.5; // below-ambient counts as "cool"
const WARM_T = 1.5;
const SMELL_OK = 0.12;

function fmtTemp(v: number): string {
  if (v > 0.2) return `+${v.toFixed(1)}° warmer`;
  if (v < -0.2) return `${v.toFixed(1)}° cooler`;
  return "about normal";
}

export function evaluateObjective(obj: Objective, plan: FloorPlan): Evaluation {
  if (!obj.regionId) {
    return {
      objective: obj,
      value: null,
      satisfied: null,
      summary: "I couldn't tell which room you mean — name it, or sketch the area on the mini-map.",
    };
  }
  const roomName = obj.regionName ?? "that room";

  if (obj.scalar === "temperature") {
    const levels = computeRoomLevels(plan, "temperature", null);
    const v = levels.get(obj.regionId) ?? 0;
    const want = obj.direction === "low" ? "cool" : "warm";
    const satisfied = obj.direction === "low" ? v <= COOL_T : v >= WARM_T;
    const hint = obj.direction === "low"
      ? "Add an AC there (or open a door to a cooler room)."
      : "Add a heater there (or open a door to a warmer room).";
    return {
      objective: obj,
      value: v,
      satisfied,
      summary: satisfied
        ? `✓ ${roomName} is ${want} (${fmtTemp(v)}).`
        : `✗ ${roomName} is ${fmtTemp(v)}, not ${want} enough. ${hint}`,
    };
  }

  // contaminant / smell
  const levels = computeRoomLevels(plan, "contamination", obj.sourceId ?? null);
  const v = levels.get(obj.regionId) ?? 0;
  const satisfied = v <= SMELL_OK;
  const src = obj.sourceName ? ` from the ${obj.sourceName}` : "";
  return {
    objective: obj,
    value: v,
    satisfied,
    summary: satisfied
      ? `✓ Little to no smell${src} reaches ${roomName}.`
      : `✗ Smell${src} reaches ${roomName} (${Math.round(v * 100)}%). Close the door between them.`,
  };
}

/** Parse a plain-language goal and evaluate every objective it contains.
 *  `sketch` grounds deictic goals ("this area") to a user-drawn region. */
export function evaluateGoal(text: string, plan: FloorPlan, sketch?: Rect | null): Evaluation[] {
  return parseGoal(text, plan, sketch).map((o) => evaluateObjective(o, plan));
}
