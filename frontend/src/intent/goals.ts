import type { ScenarioGoal } from "../floorplan/scenarios";
import { dampColor } from "../viz/smell";
import type { FloorPlan, Rect } from "../floorplan/types";
import { REPORT_FIDELITY, buildSim3D, geodesicFields, roomMeans, slowestDry, warmestPart, zoneMean, zoneSpeed } from "../sim/sim3d";

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
  if (g.metric === "drying") {
    // The two ends are times, because the goal is a time.
    return {
      before: { color: drySwatch(999), word: "still wet hours later" },
      after: { color: drySwatch(g.atMost ?? 30), word: `dry in under ${Math.round(g.atMost ?? 30)} min` },
      onTempScale: false,
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

/** Footprint of an item, rotation-aware, as a floor rect to measure over.
 *  Exported because the outcome measures read the same zones — "the smell at
 *  the bed" has to mean the identical patch of floor in both files. */
export function itemZone(plan: FloorPlan, type: string): Rect | null {
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

/** Swatch colour for a drying time: dry sand through to a wet blue-grey. Same
 *  ramp the bathroom mini-map uses, so the picture and the map agree. */
export function drySwatch(minutes: number): string {
  // Same two ends as the 3D humidity view (viz/smell DAMP_STOPS): amber for dry,
  // navy for streaming. It used to fade from near-white to a blue-grey, which on
  // a pale panel made "dry" and "nothing here" the same colour — and put the
  // mini-map on a different scale from the floor it is a map of.
  const t = Math.min(1, Math.max(0, (minutes - 10) / 110)); // 10 min dry → 120 min soaked
  const c = dampColor(t);
  return `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;
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

/** A drying-time map of one room, as a coarse grid the panel can draw as a
 *  little plan. Minutes per cell, row-major from the room's (x, z) origin, and
 *  null where the cell is furniture or outside the room.
 *
 *  A pair of colour swatches cannot say "this corner is the slow one" — and
 *  WHERE the slow patch is happens to be the entire lesson here. A picture of
 *  the room says it without a word, which also keeps the no-numbers rule: the
 *  participant sees a dark patch behind the bath, not "0.27". */
export interface DryMap {
  cols: number;
  rows: number;
  /** Room aspect, so the caller can draw it the right shape. */
  w: number;
  d: number;
  minutes: Array<number | null>;
  /** Everything standing in the room, in room-relative 0..1 coordinates, so the
   *  map can draw and NAME it. A heat map of an empty rectangle is unreadable —
   *  you cannot tell which dark patch is "behind the bath" without the bath. */
  items: Array<{ label: string; x: number; z: number; w: number; d: number }>;
  /** Openings on the room's walls, same coordinates: which one is the window
   *  and where the air is actually getting in. */
  openings: Array<{ kind: "door" | "window"; open: boolean; x: number; z: number; w: number; d: number }>;
  /** The extract, if there is one. */
  vent: { x: number; z: number } | null;
}

/** Short names for the plan. Long ones do not fit in a 190 px map. */
const MAP_LABEL: Record<string, string> = {
  bathtub: "bath",
  kitchen_sink: "sink",
  return: "extract",
  supply: "inlet",
  damp: "steam",
  smell: "smell",
  ac: "AC",
};

export function dryingMap(plan: FloorPlan, outdoorTemp: number, roomId: string, cols = 12): DryMap | null {
  const rect = plan.rooms.find((r) => r.id === roomId)?.rect;
  if (!rect) return null;
  const rows = Math.max(4, Math.round((cols * rect.d) / rect.w));
  const built = buildSim3D(plan, {
    targetCells: REPORT_FIDELITY.targetCells,
    iterations: REPORT_FIDELITY.iterations,
    openingDriveDT: Math.abs(outdoorTemp - 21),
  });
  for (let s = 0; s < REPORT_FIDELITY.steps; s++) built.sim.step(0.05);
  const { dry } = geodesicFields(built);
  const minutes: Array<number | null> = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = rect.x + ((c + 0.5) / cols) * rect.w;
      const z = rect.z + ((r + 0.5) / rows) * rect.d;
      // Average the standing-height air over this patch of floor.
      let sum = 0;
      let n = 0;
      for (const y of [0.4, 1.0, 1.6]) {
        const [i, j, k] = built.worldToCell(x, y, z);
        const cell = built.sim.cIdx(i, j, k);
        if (built.sim.solid[cell] || !built.inside[cell]) continue;
        sum += dry[cell];
        n++;
      }
      minutes.push(n ? sum / n : null);
    }
  }

  const rel = (x: number, z: number) => ({ x: (x - rect.x) / rect.w, z: (z - rect.z) / rect.d });
  const items = plan.items
    .filter((it) => it.roomId === roomId && it.type !== "return")
    .map((it) => {
      const swapped = Math.abs(Math.round(it.rotationY / (Math.PI / 2))) % 2 === 1;
      const iw = swapped ? it.size[2] : it.size[0];
      const id = swapped ? it.size[0] : it.size[2];
      const p = rel(it.position[0] - iw / 2, it.position[2] - id / 2);
      return { label: MAP_LABEL[it.type] ?? it.type.replace(/_/g, " "), x: p.x, z: p.z, w: iw / rect.w, d: id / rect.d };
    });
  const openings = [...plan.doors, ...plan.windows]
    .filter((o) => o.rooms.includes(roomId))
    .map((o) => {
      const x0 = Math.min(o.a[0], o.b[0]);
      const z0 = Math.min(o.a[1], o.b[1]);
      const p = rel(x0, z0);
      return {
        kind: o.kind,
        open: o.open,
        x: p.x,
        z: p.z,
        w: Math.abs(o.b[0] - o.a[0]) / rect.w,
        d: Math.abs(o.b[1] - o.a[1]) / rect.d,
      };
    });
  const ventItem = plan.items.find((it) => it.type === "return" && it.roomId === roomId);
  const vent = ventItem ? rel(ventItem.position[0], ventItem.position[2]) : null;

  return { cols, rows, w: rect.w, d: rect.d, minutes, items, openings, vent };
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
    // "How long does it stay wet?" — the question a person actually asks about
    // a bathroom, answered in minutes rather than on a 0–1 scale nobody has an
    // intuition for. Scored on the SLOWEST corner, since that is the one that
    // goes black.
    if (g.metric === "drying") {
      const rect = plan.rooms.find((r) => r.id === g.roomId)?.rect;
      if (!rect) return { label: g.label, met: false, detail: "", word: "" };
      const mins = slowestDry(built, fields.dry, rect);
      const met = (g.atLeast === undefined || mins >= g.atLeast) && (g.atMost === undefined || mins <= g.atMost);
      return {
        label: g.label,
        met,
        detail: mins >= 999 ? "never" : mins >= 90 ? `${(mins / 60).toFixed(1)} h` : `${Math.round(mins)} min`,
        word: met ? "dries quickly" : mins >= 120 ? "still wet hours later" : "slow to dry",
        color: drySwatch(mins),
      };
    }

    if (g.metric === "draft") {
      const zone = g.nearItem ? itemZone(plan, g.nearItem) : plan.rooms.find((r) => r.id === g.roomId)?.rect ?? null;
      const speed = zone ? zoneSpeed(built, zone) : null;
      if (speed === null) return { label: g.label, met: false, detail: "", word: "" };
      const ok = (g.atLeast === undefined || speed >= g.atLeast) && (g.atMost === undefined || speed <= g.atMost);
      // m/s means nothing to a non-expert — say what it would feel like.
      return { label: g.label, met: ok, detail: speed.toFixed(2), word: ok ? "calm" : "you'd feel it" };
    }

    // TEMPERATURE OVER A ZONE, for the same reason smell has one below: in a
    // single open room a mean cannot tell one end from the other. The summer
    // task turns on exactly that distinction — an air conditioner aimed into a
    // corner drops the room mean perfectly well while the far side of the studio
    // stays hot, and a room-mean goal would call that a success.
    // "COOL EVERYWHERE", graded on the part of the room doing worst. See
    // warmestPart: a mean is satisfied by cooling one end hard, and a single
    // measuring spot only chooses a different end to ignore.
    if (g.metric === "temperature" && g.everywhere) {
      // roomId "*" means EVERY room, graded on whichever is doing worst — which
      // is what "cool the whole flat" asks and what two separate goals cannot
      // say. Grading the rooms separately made the smaller one nearly free: the
      // living room has a quarter of the bedroom's glazing, so it sits half a
      // degree cooler before anybody does anything.
      const rects =
        g.roomId === "*"
          ? plan.rooms.map((r) => ({ name: r.name, rect: r.rect }))
          : plan.rooms.filter((r) => r.id === g.roomId).map((r) => ({ name: r.name, rect: r.rect }));
      if (!rects.length) return { label: g.label, met: false, detail: "", word: "" };
      let worstName = rects[0].name;
      let worst = -Infinity;
      for (const r of rects) {
        const v = warmestPart(built, fields.temp, r.rect);
        if (v > worst) { worst = v; worstName = r.name; }
      }
      const c = Number((outdoorTemp + worst).toFixed(1));
      if (g.roomId === "*") {
        const met2 = (g.atLeast === undefined || c >= g.atLeast) && (g.atMost === undefined || c <= g.atMost);
        const w2 = warmthWord(c, g);
        return { label: g.label, met: met2, detail: `${c.toFixed(1)} °C — warmest corner is in the ${worstName}`, word: w2, color: tempSwatch(w2) };
      }
      const met = (g.atLeast === undefined || c >= g.atLeast) && (g.atMost === undefined || c <= g.atMost);
      const word = warmthWord(c, g);
      return { label: g.label, met, detail: `${c.toFixed(1)} °C in the warmest part`, word, color: tempSwatch(word) };
    }

    if (g.metric === "temperature" && g.nearItem) {
      const zone = itemZone(plan, g.nearItem);
      const d = zone ? zoneMean(built, fields.temp, zone) : null;
      if (d === null) return { label: g.label, met: false, detail: "", word: "" };
      const c = outdoorTemp + d;
      const shown = Number(c.toFixed(1));
      const met = (g.atLeast === undefined || shown >= g.atLeast) && (g.atMost === undefined || shown <= g.atMost);
      const word = warmthWord(shown, g);
      return { label: g.label, met, detail: `${shown.toFixed(1)} °C`, word, color: tempSwatch(word) };
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
