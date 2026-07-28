import type { ScenarioGoal } from "../floorplan/scenarios";
import type { FloorPlan, Rect } from "../floorplan/types";
import { REPORT_FIDELITY, buildSim3D, geodesicFields, roomMeans, zoneSpeed } from "../sim/sim3d";

// Score a task's tick-boxes against the current home.
//
// Uses the SAME grid solve and the same geodesic transport the Temp and
// air-quality views draw, at REPORT_FIDELITY — so a ticked box and the picture
// on screen can never disagree. (An earlier verdict path read the device's raw
// source strength instead, which meant a room could be reported "cool" purely
// because the AC was set to high.)

export interface GoalStatus {
  label: string;
  met: boolean;
  /** Short measured value, e.g. "19.5 °C". Empty when it couldn't be read. */
  detail: string;
}

/** Footprint of an item, rotation-aware, as a floor rect to measure over. */
function itemZone(plan: FloorPlan, type: string): Rect | null {
  const it = plan.items.find((i) => i.type === type);
  if (!it) return null;
  const swapped = Math.abs(Math.round(it.rotationY / (Math.PI / 2))) % 2 === 1;
  const w = swapped ? it.size[2] : it.size[0];
  const d = swapped ? it.size[0] : it.size[2];
  return { x: it.position[0] - w / 2, z: it.position[2] - d / 2, w, d };
}

export function checkGoals(goals: ScenarioGoal[], plan: FloorPlan, outdoorTemp: number): GoalStatus[] {
  const needsTemp = goals.some((g) => g.metric === "temperature");
  const needsSmell = goals.some((g) => g.metric === "smell");
  if (!goals.length) return [];

  // One solve serves every goal — a two-goal task must not pay for two.
  const built = buildSim3D(plan, {
    targetCells: REPORT_FIDELITY.targetCells,
    iterations: REPORT_FIDELITY.iterations,
    openingDriveDT: Math.abs(outdoorTemp - 21),
  });
  for (let s = 0; s < REPORT_FIDELITY.steps; s++) built.sim.step(0.05);
  const fields = geodesicFields(built);
  const temps = needsTemp ? roomMeans(built, fields.temp) : null;
  const smells = needsSmell ? roomMeans(built, fields.smell) : null;

  return goals.map((g) => {
    if (g.metric === "draft") {
      const zone = g.nearItem ? itemZone(plan, g.nearItem) : plan.rooms.find((r) => r.id === g.roomId)?.rect ?? null;
      const speed = zone ? zoneSpeed(built, zone) : null;
      if (speed === null) return { label: g.label, met: false, detail: "" };
      const ok = (g.atLeast === undefined || speed >= g.atLeast) && (g.atMost === undefined || speed <= g.atMost);
      // m/s means nothing to a non-expert — say what it would feel like.
      return { label: g.label, met: ok, detail: ok ? "calm" : "you'd feel it" };
    }

    const raw = g.metric === "temperature" ? temps?.get(g.roomId) : smells?.get(g.roomId);
    if (raw === undefined || raw === null) return { label: g.label, met: false, detail: "" };

    if (g.metric === "temperature") {
      // Judge the value the participant can SEE, not the raw float. Comparing
      // 17.96 against an 18 °C floor while the readout says "18.0 °C" produces
      // a box that looks stuck for no visible reason.
      const c = Number((outdoorTemp + raw).toFixed(1));
      const met = (g.atLeast === undefined || c >= g.atLeast) && (g.atMost === undefined || c <= g.atMost);
      return { label: g.label, met, detail: `${c.toFixed(1)} °C` };
    }
    const met = (g.atLeast === undefined || raw >= g.atLeast) && (g.atMost === undefined || raw <= g.atMost);
    // A 0..1 concentration means nothing to a non-expert, so show it as a plain
    // word rather than a number the participant would have to learn to read.
    return { label: g.label, met, detail: met ? "clear" : "still there" };
  });
}
