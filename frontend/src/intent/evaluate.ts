import type { FloorPlan, Rect } from "../floorplan/types";
import { computeRoomLevels } from "../sim/roomLevels";
import { REPORT_FIDELITY, buildSim3D, geodesicFields, roomMeans } from "../sim/sim3d";
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

// Comfort targets in ABSOLUTE °C. The verdict used to be phrased against
// computeRoomLevels, which returns the device's raw ±10×power source strength —
// so a room "was cool (−16.0°)" because the AC was on high, regardless of what
// the room actually reached. Worse, that is a different model from the one the
// Temp view draws, so the verdict could claim success over a view showing 30 °C.
// Both now read the same grid solve, in real degrees.
const COOL_TARGET_C = 26; // at or below this counts as "cool"
const WARM_TARGET_C = 21; // at or above this counts as "warm"
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

/** Per-room air temperature in absolute °C, from the same grid solve and the
 *  same geodesic transport the Temp view renders. */
export function roomTemperaturesC(plan: FloorPlan, outdoorTemp: number): Map<string, number> {
  const built = buildSim3D(plan, {
    targetCells: REPORT_FIDELITY.targetCells,
    iterations: REPORT_FIDELITY.iterations,
  });
  for (let s = 0; s < REPORT_FIDELITY.steps; s++) built.sim.step(0.05);
  const deltas = roomMeans(built, geodesicFields(built).temp);
  const out = new Map<string, number>();
  for (const [id, d] of deltas) out.set(id, outdoorTemp + d);
  return out;
}

/** "25.4 °C (4.6 °C below the 30 °C outside)" — always with units, and always
 *  relative to the outdoor baseline the user set, because that is what makes a
 *  number mean anything here. */
function fmtTempC(absC: number, outdoorTemp: number): string {
  const d = absC - outdoorTemp;
  const rel =
    Math.abs(d) < 0.3
      ? "same as outside"
      : `${Math.abs(d).toFixed(1)} °C ${d < 0 ? "below" : "above"} the ${outdoorTemp.toFixed(0)} °C outside`;
  return `${absC.toFixed(1)} °C (${rel})`;
}

export interface EvalContext {
  outdoorTemp: number;
  /** Precomputed per-room °C, so a compound goal solves the field once. */
  roomTempsC?: Map<string, number>;
}

export function evaluateObjective(obj: Objective, plan: FloorPlan, ctx: EvalContext): Evaluation {
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
    const temps = ctx.roomTempsC ?? roomTemperaturesC(plan, ctx.outdoorTemp);
    const v = temps.get(obj.regionId);
    if (v === undefined) {
      return { objective: obj, value: null, satisfied: null, summary: `I couldn't measure the air in ${roomName}.` };
    }
    const want = obj.direction === "low" ? "cool" : "warm";
    const target = obj.direction === "low" ? COOL_TARGET_C : WARM_TARGET_C;
    const satisfied = obj.direction === "low" ? v <= target : v >= target;
    const hint = obj.direction === "low"
      ? `Aim for ${COOL_TARGET_C} °C or below — add an AC there, raise its power, or open a door to a cooler room.`
      : `Aim for ${WARM_TARGET_C} °C or above — add a heater there, raise its power, or open a door to a warmer room.`;
    return {
      objective: obj,
      value: v,
      satisfied,
      summary: satisfied
        ? `✓ ${roomName} is ${want}: ${fmtTempC(v, ctx.outdoorTemp)}.`
        : `✗ ${roomName} is ${fmtTempC(v, ctx.outdoorTemp)} — not ${want} enough. ${hint}`,
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
export function evaluateGoal(
  text: string,
  plan: FloorPlan,
  opts: { sketch?: Rect | null; outdoorTemp: number },
): Evaluation[] {
  return evaluateObjectives(parseGoal(text, plan, opts.sketch ?? null), plan, opts);
}

/** Evaluate objectives that were already parsed (by keyword or by the LLM). */
export function evaluateObjectives(
  objs: Objective[],
  plan: FloorPlan,
  opts: { outdoorTemp: number },
): Evaluation[] {
  // A compound goal ("cool the living room and the bedroom") is several
  // objectives over the same field — solve it once and share.
  const ctx: EvalContext = { outdoorTemp: opts.outdoorTemp };
  if (objs.some((o) => o.scalar === "temperature")) ctx.roomTempsC = roomTemperaturesC(plan, opts.outdoorTemp);
  return objs.map((o) => evaluateObjective(o, plan, ctx));
}

/** Keyword parser first; only if it matches nothing, ask the backend's LLM.
 *  Phrases the seed vocabulary already knows never incur a call, so the common
 *  path stays instant and offline. */
export async function resolveObjectives(
  text: string,
  plan: FloorPlan,
  sketch?: Rect | null,
): Promise<{ objectives: Objective[]; usedLLM: boolean }> {
  const keyword = parseGoal(text, plan, sketch ?? null);
  if (keyword.length) return { objectives: keyword, usedLLM: false };
  const { parseGoalWithLLM } = await import("./llmGoal");
  return { objectives: await parseGoalWithLLM(text, plan, sketch ?? null), usedLLM: true };
}
