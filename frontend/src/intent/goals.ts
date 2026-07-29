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
  /** Short measured value, e.g. "19.5 °C". Empty when it couldn't be read.
   *  Kept for logs and the researcher's view — NOT rendered in the checklist,
   *  where a number invites optimising toward the number. */
  detail: string;
  /** Plain word for what the room is like: "warm enough", "too cold", "calm".
   *  What a person would say, rather than a reading. */
  word: string;
  /** The room's temperature as a CSS colour on the same scale the Temp view
   *  uses, so the checklist can SHOW the state instead of stating it. */
  color?: string;
}

/** The two ends of a goal, as a picture: what the home is like at the start,
 *  and what "done" looks like. Shown BEFORE anything is simulated — a tick-box
 *  alone says whether you are finished, not what finished looks like, and the
 *  participant needs the target in front of them while they are working, not
 *  after. Derived from the goal's own band and the day's weather, so it can
 *  never drift from what the checklist scores.
 *
 *  It shows STATES, not moves. "Cold → comfortable" is the goal; "put the
 *  heater under the window" is the answer, and the study exists to watch the
 *  participant find that themselves. */
export interface GoalPicture {
  before: { color: string; word: string };
  after: { color: string; word: string };
  /** True when the two swatches sit on the Temp view's °C ramp, so the caller
   *  can draw that ramp underneath them for context. */
  onTempScale: boolean;
}

export function goalPicture(g: ScenarioGoal, outdoorTemp: number): GoalPicture {
  if (g.metric === "temperature") {
    // The home starts at the outdoor temperature and is carried from there, so
    // that is honestly where "before" sits — cold in winter, hot in summer.
    const start = warmthWord(outdoorTemp, g);
    return {
      before: { color: tempSwatch(start), word: start },
      after: { color: tempSwatch("comfortable"), word: "comfortable" },
      onTempScale: true,
    };
  }
  if (g.metric === "smell") {
    // Same violet ramp the contamination view draws.
    return {
      before: { color: "#8a3fd0", word: "it reaches here" },
      after: { color: "#efe7fb", word: "clear" },
      onTempScale: false,
    };
  }
  return {
    before: { color: "#2f7ff0", word: "you'd feel it" },
    after: { color: "#dfe8f2", word: "calm" },
    onTempScale: false,
  };
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
 *  air spilling off the glass collects. Exported because the solution search
 *  scores the same strip: if the checklist marks a layout down for a cold pool
 *  at the glass, the search must not be recommending that layout. */
export function windowZone(plan: FloorPlan, roomId: string): Rect | null {
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

/** Swatch colour for a temperature state in the task picture.
 *
 *  Deliberately NOT the Temp view's ramp. The ramp is an absolute scale, so a
 *  cold room came out near-black and a comfortable one came out cream or, worse,
 *  mid-blue — a "comfortable" goal painted in the colour of a cool room. These
 *  two swatches are not a reading, they are the two ends of a story: cold is a
 *  light blue, comfortable is a light red. Light enough for dark ink either way. */
function tempSwatch(word: string): string {
  if (word === "too warm") return "#f3b1a4";
  if (word === "comfortable") return "#f9d8d3";
  return "#cfe3f7";
}

/** The little cold→warm bar under the picture, in the picture's own colours.
 *  Drawing it on the Temp view's absolute ramp put a near-black-to-crimson strip
 *  under two pale swatches that no longer sat anywhere on it. */
export const SWATCH_SCALE_CSS = `linear-gradient(90deg, ${tempSwatch("cold")}, ${tempSwatch(
  "comfortable",
)}, ${tempSwatch("too warm")})`;

/** What a person would say about the room, without quoting the threshold. */
function warmthWord(c: number, g: ScenarioGoal): string {
  if (g.atLeast !== undefined && c < g.atLeast) return c < g.atLeast - 4 ? "cold" : "not quite warm enough";
  if (g.atMost !== undefined && c > g.atMost) return "too warm";
  return "comfortable";
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
      if (speed === null) return { label: g.label, met: false, detail: "", word: "" };
      const ok = (g.atLeast === undefined || speed >= g.atLeast) && (g.atMost === undefined || speed <= g.atMost);
      // m/s means nothing to a non-expert — say what it would feel like.
      return { label: g.label, met: ok, detail: speed.toFixed(2), word: ok ? "calm" : "you'd feel it" };
    }

    // A smell goal can be measured over one object's footprint rather than the
    // whole room — "the smell stays off the BED". In a studio the bed and the
    // bin are in the same room, so a room mean cannot tell the sleeping end
    // from the cooking end and would score every layout the same.
    if (g.metric === "smell" && g.nearItem) {
      const zone = itemZone(plan, g.nearItem);
      const v = zone ? zoneMean(built, fields.smell, zone) : null;
      if (v === null) return { label: g.label, met: false, detail: "", word: "" };
      const met = (g.atLeast === undefined || v >= g.atLeast) && (g.atMost === undefined || v <= g.atMost);
      return { label: g.label, met, detail: v.toFixed(3), word: met ? "clear" : "still there" };
    }

    const raw = g.metric === "temperature" ? temps?.get(g.roomId) : smells?.get(g.roomId);
    if (raw === undefined || raw === null) return { label: g.label, met: false, detail: "", word: "" };

    if (g.metric === "temperature") {
      // Judge the value the participant can SEE, not the raw float. Comparing
      // 17.96 against an 18 °C floor while the readout says "18.0 °C" produces
      // a box that looks stuck for no visible reason.
      const c = Number((outdoorTemp + raw).toFixed(1));
      let met = (g.atLeast === undefined || c >= g.atLeast) && (g.atMost === undefined || c <= g.atMost);
      // …and, when the goal asks for it, the cold pool at the glazing too.
      let glass: number | null = null;
      if (g.windowAtLeast !== undefined) {
        const zone = windowZone(plan, g.roomId);
        const delta = zone ? zoneMean(built, fields.temp, zone) : null;
        if (delta !== null) {
          glass = Number((outdoorTemp + delta).toFixed(1));
          if (glass < g.windowAtLeast) met = false;
        }
      }
      const detail = glass === null ? `${c.toFixed(1)} °C` : `${c.toFixed(1)} °C (${glass.toFixed(1)} °C at the glass)`;
      // The word and the colour describe whichever part is FAILING, so "view"
      // shows the cold pool rather than a comfortable room mean hiding it. Only
      // when it fails, though: a glass reading that passes must not be able to
      // caption a satisfied row "not quite warm enough".
      const shown = glass !== null && g.windowAtLeast !== undefined && glass < g.windowAtLeast ? glass : c;
      const word = warmthWord(shown, g);
      return { label: g.label, met, detail, word, color: tempSwatch(word) };
    }
    const met = (g.atLeast === undefined || raw >= g.atLeast) && (g.atMost === undefined || raw <= g.atMost);
    // A 0..1 concentration means nothing to a non-expert, so show it as a plain
    // word rather than a number the participant would have to learn to read.
    return { label: g.label, met, detail: raw.toFixed(3), word: met ? "clear" : "still there" };
  });
}
