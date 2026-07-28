import type { ScenarioGoal } from "../floorplan/scenarios";
import type { FloorPlan } from "../floorplan/types";
import { REPORT_FIDELITY, buildSim3D, geodesicFields, roomMeans } from "../sim/sim3d";

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

export function checkGoals(goals: ScenarioGoal[], plan: FloorPlan, outdoorTemp: number): GoalStatus[] {
  const needsTemp = goals.some((g) => g.metric === "temperature");
  const needsSmell = goals.some((g) => g.metric === "smell");
  if (!needsTemp && !needsSmell) return [];

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
    const raw = g.metric === "temperature" ? temps?.get(g.roomId) : smells?.get(g.roomId);
    if (raw === undefined || raw === null) return { label: g.label, met: false, detail: "" };

    if (g.metric === "temperature") {
      const c = outdoorTemp + raw; // the field is a delta from outdoor
      const met = (g.atLeast === undefined || c >= g.atLeast) && (g.atMost === undefined || c <= g.atMost);
      return { label: g.label, met, detail: `${c.toFixed(1)} °C` };
    }
    const met = (g.atLeast === undefined || raw >= g.atLeast) && (g.atMost === undefined || raw <= g.atMost);
    // A 0..1 concentration means nothing to a non-expert, so show it as a plain
    // word rather than a number the participant would have to learn to read.
    return { label: g.label, met, detail: met ? "clear" : "still there" };
  });
}
