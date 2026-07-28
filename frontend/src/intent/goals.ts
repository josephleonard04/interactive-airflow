import type { ScenarioGoal } from "../floorplan/scenarios";
import type { FloorPlan, Rect } from "../floorplan/types";
import { REPORT_FIDELITY, buildSim3D, geodesicFields, roomMeans, zoneMean, zoneSpeed } from "../sim/sim3d";

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

/** The strip of floor just inside a room's exterior window — where the cold
 *  air spilling off the glass collects. */
function windowZone(plan: FloorPlan, roomId: string): Rect | null {
  const room = plan.rooms.find((r) => r.id === roomId);
  const win = plan.windows.find((w) => w.rooms.includes(roomId) && w.rooms.includes("outside"));
  if (!room || !win) return null;
  const DEPTH = 0.9; // how far the cold pool reaches into the room
  const vertical = Math.abs(win.a[0] - win.b[0]) < 1e-3;
  const { x, z, w, d } = room.rect;
  if (vertical) {
    const line = win.a[0];
    const z0 = Math.min(win.a[1], win.b[1]);
    const z1 = Math.max(win.a[1], win.b[1]);
    // extend inward, away from whichever side the wall is on
    const inward = Math.abs(line - x) < Math.abs(line - (x + w)) ? 1 : -1;
    return { x: inward > 0 ? line : line - DEPTH, z: z0, w: DEPTH, d: z1 - z0 };
  }
  const line = win.a[1];
  const x0 = Math.min(win.a[0], win.b[0]);
  const x1 = Math.max(win.a[0], win.b[0]);
  const inward = Math.abs(line - z) < Math.abs(line - (z + d)) ? 1 : -1;
  return { x: x0, z: inward > 0 ? line : line - DEPTH, w: x1 - x0, d: DEPTH };
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

    // Temperature measured in a sub-zone rather than over the whole room.
    if (g.metric === "temperature" && g.nearWindowOf) {
      const zone = windowZone(plan, g.nearWindowOf);
      const delta = zone ? zoneMean(built, fields.temp, zone) : null;
      if (delta === null) return { label: g.label, met: false, detail: "" };
      const c = Number((outdoorTemp + delta).toFixed(1));
      const met = (g.atLeast === undefined || c >= g.atLeast) && (g.atMost === undefined || c <= g.atMost);
      return { label: g.label, met, detail: `${c.toFixed(1)} °C` };
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
