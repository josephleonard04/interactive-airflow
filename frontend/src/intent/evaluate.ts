import type { FloorPlan, Rect } from "../floorplan/types";
import { computeRoomLevels } from "../sim/roomLevels";
import { buildSim3D } from "../sim/sim3d";
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
const DRAFT_OK = 0.28; // mean air speed (m/s) below this = no noticeable draft
const BREEZY = 0.35; // above this = clearly moving air

/** Mean air speed over a region (an object footprint, a sketch, or a room),
 *  measured on a coarse converged solve of the CURRENT plan. Heights limited
 *  to the occupied band (~0.2–1.8 m) where people feel a draft. */
function meanAirSpeed(plan: FloorPlan, rect: Rect): number | null {
  const built = buildSim3D(plan, { targetCells: 4200, iterations: 8 });
  for (let s = 0; s < 22; s++) built.sim.step(0.05);
  const { sim, nx, ny, nz, cellCenter } = built;
  let sum = 0;
  let n = 0;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = sim.cIdx(i, j, k);
        if (sim.solid[c]) continue;
        const [x, y, z] = cellCenter(i, j, k);
        if (y < 0.2 || y > 1.8) continue;
        if (x < rect.x || x > rect.x + rect.w || z < rect.z || z > rect.z + rect.d) continue;
        const [u, v, w] = sim.velocityAt(i, j, k);
        sum += Math.hypot(u, v, w);
        n++;
      }
  return n > 0 ? sum / n : null;
}

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

  if (obj.scalar === "draft") {
    // region: object footprint / sketch rect, else the whole room
    const room = plan.rooms.find((r) => r.id === obj.regionId);
    const rect = obj.regionRect ?? room?.rect ?? null;
    if (!rect) {
      return { objective: obj, value: null, satisfied: null, summary: "I couldn't tell where to check for a draft — name a spot (e.g. the bed) or sketch it." };
    }
    const v = meanAirSpeed(plan, rect);
    if (v === null) {
      return { objective: obj, value: null, satisfied: null, summary: `I couldn't measure the air over ${roomName}.` };
    }
    const satisfied = obj.direction === "low" ? v <= DRAFT_OK : v >= BREEZY;
    const speedTxt = `${v.toFixed(2)} m/s`;
    return {
      objective: obj,
      value: v,
      satisfied,
      summary:
        obj.direction === "low"
          ? satisfied
            ? `✓ Air over ${roomName} is calm (${speedTxt}) — no noticeable draft.`
            : `✗ Air is blowing over ${roomName} (${speedTxt}). Turn the fan away/off or move the AC so its jet misses it.`
          : satisfied
            ? `✓ There's a clear breeze over ${roomName} (${speedTxt}).`
            : `✗ Not much air movement over ${roomName} (${speedTxt}). Point a fan there or raise its power.`,
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
