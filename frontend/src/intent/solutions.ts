import { findFreeSpot } from "../floorplan/collision";
import type { FloorPlan, Opening, PlacedItem, Rect, Vec3 } from "../floorplan/types";
import { REPORT_FIDELITY, buildSim3D, coldestPart, geodesicFields, roomMeans, slowestDry, warmestPart, zoneMean, zoneSpeed } from "../sim/sim3d";
import { SMELL_FULL_SCALE } from "../viz/smell";
import { windowZone } from "./goals";
import { windowPlacements, windowSideName, withOpeningMoved } from "../floorplan/openings";
import { candidateSpots } from "./searchOptimize";
import { DEVICE_LABEL, GOAL_DEVICES, ROOM_BOUND_DEVICES, largestRoom, type OptimizeGoal } from "./optimize";
import type { FlowHint } from "./sketch";

// Find SEVERAL good configurations for a goal, not one.
//
// Three things were wrong with the single-answer search (see
// docs/optimizer-research.md §1):
//
//  1. It only ever searched device POSITIONS. Power level, whether a device is
//     on, and which doors and windows are open were fixed by a hardcoded lookup
//     table and never evaluated — even though the project's own docs say the
//     openings dominate the airflow. Zero of the ~22 evaluations were spent on
//     the variables that matter most.
//  2. It optimized the MEAN over the target. For "cool the living room and the
//     bedroom" the mean is happily satisfied by cooling one room hard and
//     ignoring the other, which is exactly what happened. We now optimize the
//     WORST target room (a max–min / egalitarian scalarization), so a solution
//     only scores well when EVERY room asked for is handled.
//  3. It returned one answer with no alternatives, so a user who disliked the
//     trade-off had nothing to compare against.
//
// Budget. Measured on the reference machine (9×7 m home), cost per evaluation
// is dominated by the pressure solve and scales steeply with the grid:
//     4200 cells / 22 steps  ~305 ms      1800 / 12  ~56 ms
//     1200 cells /  8 steps   ~25 ms       900 /  6  ~16 ms
// The old optimizer scored every candidate at 4200/22, so its cap of 22
// evaluations was already ~6.7 s of solve — it could not afford to search
// anything beyond position. Two-stage fixes that: screen wide and cheap, then
// re-score only the finalists at a fidelity worth reporting. Roughly
//     64 screens x 16 ms + 8 strategy scores + 4 finals x 56 ms  ~ 1.4 s.
// The screening fidelity does not have to PICK the winner — it has to avoid
// eliminating it, because finalists are re-scored and re-ranked by the final
// pass. Measured on 18 layouts (AC power × interior-door state × AC room) on
// the example home, against a 4200/22 reference:
//     900/4/6    rho 0.73   winner in screen top-4: yes
//     1200/4/8   rho 0.77   winner in screen top-4: yes   <- SCREEN
//     1800/6/12  rho 0.99   winner in screen top-4: yes
//     2600/6/16  rho 0.99   picks the same winner, 0 regret <- FINAL
// Top-4 recall held at every rung, so the cheap screen is safe given that we
// carry 4 finalists forward. Caveat: n=18, one floor plan, one goal — enough to
// justify the ladder, not enough to call it validated in general.
//
// Fully deterministic: no Math.random anywhere, candidates are enumerated in a
// fixed order and ties break by order. The same goal on the same plan always
// gives the same solutions — a hard requirement for the formative study.

/** Coarse screening pass — cheap, used only to RANK many candidates. */
const SCREEN = { targetCells: 1200, iterations: 4, steps: 8 };
/** Screening a DRYING task needs a finer grid. Drying time is read off the 90th
 *  percentile of a per-cell field in one small room, so at 1200 cells the
 *  ranking is mostly quantisation noise — the search moved the extract, scored
 *  itself a win, and landed 70 minutes off the best spot it had already tried.
 *  Roughly 4x the cost per evaluation, on the one task that needs it. */
const SCREEN_DRY = { targetCells: 3600, iterations: 6, steps: 14 };
/** THE MIDDLE RUNG, and the reason the answers are worth trusting.
 *
 *  The header's own numbers say the cheap screen ranks at rho 0.77 and this
 *  rung at 0.99 — so the screen is good enough to say "these twelve are worth
 *  looking at" and not good enough to say which of them is best. It was doing
 *  the second job anyway: the top three by SCREEN score went straight to the
 *  final pass and everything else was discarded, so a candidate the screen
 *  mis-ranked by four places was gone before anything accurate had seen it.
 *
 *  At ~56 ms a shot, re-ranking a dozen costs about 0.7 s and replaces a 0.77
 *  correlation with a 0.99 one at exactly the moment the choice is made. */
const MID = { targetCells: 1800, iterations: 6, steps: 12 };
/** …and the drying tasks need their own, for the same reason SCREEN_DRY exists:
 *  drying time is a percentile of a per-cell field in one small room, and it is
 *  quantisation noise on a coarse grid. */
const MID_DRY = { targetCells: 4200, iterations: 8, steps: 18 };

/** Finalists are re-scored at the shared reporting fidelity, so the temperature
 *  printed on a solution card is the same number the goal verdict will give
 *  after the user applies it. */
const FINAL = REPORT_FIDELITY;

/** The device each goal really turns on, best first — searched first when the
 *  budget is tight, and the one a half-step option keeps.
 *
 *  A LIST, not a single type, because the same goal is served by different
 *  hardware in different homes: "air this room out" means the extract in a
 *  bathroom that has only an extract, and the supply vent in a home that has
 *  one. Pinned to a single type, the primary could be a device the plan does
 *  not contain, and everything keyed off it — search order, the "X only" card —
 *  silently referred to nothing. */
const PRIMARY_PREF: Record<OptimizeGoal, string[]> = {
  cool: ["ac", "fan"],
  warm: ["heater", "fan"],
  ventilate: ["return", "supply", "fan"],
  circulate: ["fan", "supply", "return"],
  balanced: ["ac", "fan", "supply"],
};

/** The first preferred device this plan actually has and this task allows.
 *
 *  `allowed` IS A HARD LIMIT, NOT A PREFERENCE. It used to be one clause of a
 *  fallback chain, so when the preferred device was disallowed the next line
 *  quietly picked it anyway. On the one-room flat — where the participant may
 *  move the fan and nothing else — that returned the extract, and the gallery
 *  offered "return only — a first step": a card proposing to relocate a grille
 *  bolted to the wall, which on inspection also moved nothing at all, because
 *  the half-step keeps the primary device's move and reverts the rest, and the
 *  extract had never been moved in the first place.
 *
 *  `on: false` no longer hides a device either. The fan in that flat starts
 *  switched off, so it was not "present"; the strategy layer switches it on a
 *  moment later, which is exactly the move being proposed. */
function primaryFor(goal: OptimizeGoal, plan: FloorPlan, allowed?: string[]): string {
  const pref = PRIMARY_PREF[goal];
  const permitted = (t: string) => !allowed || allowed.includes(t);
  const here = new Set(plan.items.map((it) => it.type));
  return (
    pref.find((t) => here.has(t) && permitted(t)) ??
    pref.find((t) => permitted(t)) ??
    allowed?.[0] ??
    pref[0]
  );
}

/** One place the goal's primary device was tried, with its screening score. */
interface PrimaryAlt {
  pos: Vec3;
  rot: number;
  roomId: string;
  roomName: string;
  score: number;
}
/** Two suggested spots closer than this are the same suggestion (m).
 *
 *  Was 1.0, which is a whole metre — in a 4 m bathroom that is a quarter of the
 *  room, and it meant "move it a bit further along" had no card to offer,
 *  because every nearby alternative had been folded into the winner. Someone
 *  asking for a small adjustment is asking for exactly the option this was
 *  discarding. 0.6 m is still comfortably more than a hand's width, so the
 *  gallery does not fill up with the same spot four times. */
const ALT_MIN_APART = 0.6;
/** …and two aims closer than this are the same aim (radians, ~40°). Wide enough
 *  that the gallery does not offer four nudges of the same louvre, narrow enough
 *  that "across the room" and "along the wall" are separate cards. */
const ALT_MIN_TURN = 0.7;

/** Which side of the home a window is on, so an option can say WHICH one it
 *  wants open rather than just "a window". */
function sideOfWindow(plan: FloorPlan, w: Opening): string {
  const b = plan.bounds;
  const vertical = Math.abs(w.a[0] - w.b[0]) < 1e-3;
  if (vertical) return Math.abs(w.a[0] - b.x) < Math.abs(w.a[0] - (b.x + b.w)) ? "left-hand" : "right-hand";
  return Math.abs(w.a[1] - b.z) < Math.abs(w.a[1] - (b.z + b.d)) ? "far" : "near";
}

/** Which way a device now points, in words. yaw 0 blows +z (toward the near /
 *  screen-bottom wall), yaw pi/2 blows +x (to the right) — see aimVec. */
function headingName(yaw: number): string {
  const q = ((Math.round(yaw / (Math.PI / 2)) % 4) + 4) % 4;
  return ["at the near wall", "to the right", "at the far wall", "to the left"][q];
}

/** One line per device this option actually moves, aimed or switches on, said
 *  in the words the spot names use. Computed from the two plans, so it cannot
 *  drift from what applying the card would do. */
function movedLines(before: FloorPlan, after: FloorPlan): string[] {
  const rows: Array<{ name: string; spot: string | null; side: string | null; extra: string | null }> = [];
  for (const a of before.items) {
    const b = after.items.find((i) => i.id === a.id);
    if (!b) continue;
    const name = DEVICE_LABEL[a.type] ?? a.type;
    const moved = Math.hypot(b.position[0] - a.position[0], b.position[2] - a.position[2]) > 0.05;
    const turned = Math.abs(Math.atan2(Math.sin(b.rotationY - a.rotationY), Math.cos(b.rotationY - a.rotationY))) > 0.2;
    const room = after.rooms.find((r) => r.id === b.roomId);
    if (moved && room) {
      rows.push({ name, spot: spotName(after, b.roomId, b.position), side: wallSideName(room.rect, b.position), extra: null });
    } else if (turned) {
      rows.push({ name, spot: null, side: null, extra: `aimed ${headingName(b.rotationY)}` });
    }
    if ((a.on ?? true) === false && (b.on ?? true) === true) {
      rows.push({ name, spot: null, side: null, extra: "switched on" });
    }
  }
  // TWO DEVICES CAN LAND ON THE SAME SPOT NAME. "Under the window" covers a
  // 1.2 m radius and the heater and the fan can both be inside it, so the card
  // read "Heater → under the window · Fan → under the window" and looked like it
  // was repeating itself. Where the spot name collides, say which wall as well;
  // where it does not, the plain name is the better sentence.
  return rows.map((r, i) => {
    if (r.spot === null) return `${r.name} → ${r.extra}`;
    const clash = rows.some((o, j) => j !== i && o.spot === r.spot);
    return clash && r.side ? `${r.name} → ${r.spot}, ${r.side}` : `${r.name} → ${r.spot}`;
  });
}

/** Which corner of the room a spot leans toward — the last-resort tie-breaker
 *  when two options share both a name and a wall. */
function quadrantName(rect: Rect, pos: Vec3): string {
  const fx = (pos[0] - rect.x) / rect.w;
  const fz = (pos[2] - rect.z) / rect.d;
  return `${fz < 0.5 ? "far" : "near"} ${fx < 0.5 ? "left" : "right"} side`;
}

/** Where in the room a spot is, in the words someone would use pointing at it.
 *  "Heater somewhere else" twice over is not two options, it is one option and
 *  a shrug — the card has to say which spot it means or the participant has to
 *  apply each one to find out. */
function spotName(plan: FloorPlan, roomId: string, pos: Vec3): string {
  const room = plan.rooms.find((r) => r.id === roomId);
  if (!room) return "another spot";
  const near = (o: Opening) => {
    const cx = (o.a[0] + o.b[0]) / 2;
    const cz = (o.a[1] + o.b[1]) / 2;
    return Math.hypot(cx - pos[0], cz - pos[2]);
  };
  const win = plan.windows.filter((o) => o.rooms.includes(roomId)).sort((a, b) => near(a) - near(b))[0];
  if (win && near(win) < 1.2) return "under the window";
  const door = plan.doors.filter((o) => o.rooms.includes(roomId)).sort((a, b) => near(a) - near(b))[0];
  if (door && near(door) < 1.2) return "beside the doorway";
  return wallSideName(room.rect, pos);
}

/** Which wall (or the middle) a spot sits against, with no reference to doors or
 *  windows. Split out of spotName because it is also the tie-breaker: the
 *  opening-relative names are the ones people actually use, but they cover a
 *  1.2 m radius, and in a 3.6 m bathroom two genuinely different spots are both
 *  "beside the doorway". Same words, different plans, wildly different results —
 *  which is the "it gave me the same answer twice" complaint, earned. */
function wallSideName(rect: Rect, pos: Vec3): string {
  const { x, z, w, d } = rect;
  const fx = (pos[0] - x) / w;
  const fz = (pos[2] - z) / d;
  const edge = Math.min(fx, 1 - fx, fz, 1 - fz);
  if (edge > 0.28) return "out in the middle of the room";
  const vert = Math.min(fz, 1 - fz) < Math.min(fx, 1 - fx);
  if (vert) return fz < 0.5 ? "against the far wall" : "against the near wall";
  return fx < 0.5 ? "against the left-hand wall" : "against the right-hand wall";
}

/** The vertical aims the search tries, matching the panel's own slider range
 *  (±60°). Wall units are swept over all of these and nothing else. */
const TILT_STEPS = [-0.7, -0.35, 0, 0.26, 0.52, 0.79, 1.05];

/** How hard the ACTIVE TASK's own goals pull on a search that was asked for
 *  something else. A tiebreak, not a veto — see scoreOf. */
const TASK_GUARD = 3;

/** Air speed over a target room above which people notice a draught (m/s). */
const DRAFT_CAP = 0.35;
const DRAFT_PENALTY = 8;

/** One of the ACTIVE TASK's own checkable lines, reduced to something the
 *  screening pass can measure: which quantity, over which patch of floor, and
 *  which side of which number counts as done.
 *
 *  The search used to optimise a generic proxy for the goal word it was handed
 *  — "ventilate" meant room-mean freshness — while the task graded something
 *  else entirely. In the studio those are different questions: the goal is smell
 *  over the BED, and a fan that freshens the room average by stirring the bin
 *  end scores well and fails the task. Handing the search the task's own lines
 *  closes that gap, and it is the difference between the smell task's search
 *  finding 0.296 (against a 0.17 bar) and finding the answer. */
export interface TaskZone {
  metric: "temperature" | "smell" | "draft" | "drying";
  /** Temperature goals: grade the room by its WARMEST part. See warmestPart. */
  everywhere?: boolean;
  /** The patch to measure over. Null = the whole room named by `roomId`. */
  zone: Rect | null;
  roomId: string;
  atLeast?: number;
  atMost?: number;
}

export interface SolutionMetrics {
  /** Absolute °C per room. */
  roomTempC: Map<string, number>;
  /** The WARMEST and COLDEST parts of each room (90th/10th percentile, °C).
   *  "Cool this room" and "warm this room" are claims about the corner that is
   *  still wrong, not about the average — see warmestPart. */
  roomWarmestC: Map<string, number>;
  roomColdestC: Map<string, number>;
  /** How fresh the air is per room, 0..1 (1 = swept clean). The contaminant
   *  field read the other way round, because "40% fresh" is the thing a person
   *  asking about a smell wants to know and "0.31 contaminant" is not. Free to
   *  compute: geodesicFields already returns it alongside the temperature. */
  roomFresh: Map<string, number>;
  /** How long the slowest part of each room stays wet, in minutes.
   *
   *  A steamy bathroom pins `roomFresh` to zero — the source is strong enough
   *  that the room mean clamps — so every option card read "0% fresh" and no
   *  option could be told from another. Minutes is also the unit this task is
   *  actually scored in, so the card and the goal finally agree. */
  roomDryMin: Map<string, number>;
  /** Per TaskZone, how far this plan is from satisfying it: 0 = met, larger =
   *  further away, in units of the goal's own tolerance. Empty off-scenario. */
  taskShortfall: number[];
  /** The target room that came off WORST — the number the goal really rests on. */
  worstTargetC: number;
  meanTargetC: number;
  houseMeanSpeed: number;
  worstRoomSpeed: number;
  outflow: number;
  /** Mean air speed across the target rooms — the draught constraint. */
  targetSpeed: number;
  /** Coldest window strip among the rooms a heater is standing in (°C), or null
   *  when nothing is heating. This is the cold pool a radiator under the glass
   *  exists to cancel; a room mean cannot see it, so without this term the
   *  search happily parks the heater on the far wall — a layout the task's own
   *  checklist then fails. */
  heaterWindowC: number | null;
}

export interface Solution {
  id: string;
  /** Which number the option card should print for each room. A task about a
   *  kitchen smell showed "Studio 31.0 °C" on every card — the outdoor
   *  temperature, identical across all of them, and no help whatever in
   *  choosing between two ways of dealing with a bin. */
  readout: "temperature" | "freshness" | "drying";
  /** Short plain-language name for the approach. */
  label: string;
  /** What it actually does, for the option card. */
  detail: string[];
  plan: FloorPlan;
  metrics: SolutionMetrics;
  score: number;
}

interface Strategy {
  id: string;
  label: string;
  /** Device settings by type. */
  devices: Record<string, { on: boolean; power?: number; oscillate?: boolean }>;
  interiorDoors: boolean;
  /** Which exterior windows to open, by id. A LIST, not a flag: the studio task
   *  turns entirely on opening ONE of its two windows and leaving the other
   *  shut, and an all-or-nothing switch cannot say that — every option the
   *  search produced there threw both open, which is the trap the task is built
   *  to teach against. */
  openWindowIds: string[];
  note: string;
}

// ---- plan mutation helpers ----

/** Apply opening states. The same Opening object is referenced from plan.doors /
 *  plan.windows AND from wall.openings, so all three must get the SAME new
 *  object or the solver and the renderer disagree about what is open. */
function withOpenings(plan: FloorPlan, interiorDoors: boolean, openWindowIds: string[]): FloorPlan {
  const next = new Map<string, Opening>();
  const wanted = new Set(openWindowIds);
  const decide = (o: Opening): Opening => {
    // A LOCKED OPENING IS NOT THE SEARCH'S TO TOUCH. The participant's own
    // toggle is disabled for these, so proposing one is proposing something
    // they physically cannot carry out — and in the winter task it proposed
    // opening two windows onto a 2 °C night, which reads as broken advice
    // however the numbers land. The UI already honoured `locked`; the search
    // did not, so the two disagreed about what the task allows.
    if (o.locked) return o;
    const exterior = o.rooms.includes("outside");
    // The entrance is never auto-opened — people don't leave the front door wide
    // open, and letting the search use it would produce advice nobody follows.
    if (o.kind === "door" && exterior) return o;
    const open = exterior ? wanted.has(o.id) : interiorDoors;
    return open === o.open ? o : { ...o, open };
  };
  for (const o of [...plan.doors, ...plan.windows]) next.set(o.id, decide(o));
  const map = (o: Opening) => next.get(o.id) ?? o;
  return {
    ...plan,
    doors: plan.doors.map(map),
    windows: plan.windows.map(map),
    walls: plan.walls.map((w) => ({ ...w, openings: w.openings.map(map) })),
  };
}

function withDevices(plan: FloorPlan, devices: Strategy["devices"]): FloorPlan {
  return {
    ...plan,
    items: plan.items.map((it) => {
      const d = devices[it.type];
      if (!d) return it;
      return {
        ...it,
        on: d.on,
        ...(d.power !== undefined ? { power: d.power } : {}),
        ...(it.type === "fan" && d.oscillate !== undefined ? { oscillate: d.oscillate } : {}),
      };
    }),
  };
}

// ---- scoring ----

function measure(plan: FloorPlan, targetIds: string[], outdoorTemp: number, fid: typeof SCREEN, zones: TaskZone[] = []): SolutionMetrics {
  const built = buildSim3D(plan, { targetCells: fid.targetCells, iterations: fid.iterations });
  for (let s = 0; s < fid.steps; s++) built.sim.step(0.05);
  const { sim, nx, ny, nz, ambient, inside, roomIndex, roomIds } = built;

  const { temp, smell, dry: dryF } = geodesicFields(built);
  const roomTempC = new Map<string, number>();
  for (const [id, d] of roomMeans(built, temp)) roomTempC.set(id, outdoorTemp + d);
  const roomWarmestC = new Map<string, number>();
  const roomColdestC = new Map<string, number>();
  for (const r of plan.rooms) {
    roomWarmestC.set(r.id, outdoorTemp + warmestPart(built, temp, r.rect));
    roomColdestC.set(r.id, outdoorTemp + coldestPart(built, temp, r.rect));
  }
  const roomDryMin = new Map<string, number>();
  for (const r of plan.rooms) roomDryMin.set(r.id, slowestDry(built, dryF, r.rect));
  const roomFresh = new Map<string, number>();
  // Against SMELL_FULL_SCALE, the same fixed reference the contamination view
  // normalises against — so a card saying "62% fresh" and the floor the user is
  // looking at cannot disagree about how bad it is.
  for (const [id, v] of roomMeans(built, smell)) {
    roomFresh.set(id, Math.max(0, Math.min(1, 1 - v / SMELL_FULL_SCALE)));
  }

  // THE TASK'S OWN LINES, measured here so the screening pass can rank by them.
  // Each is normalised to its own tolerance so a 0.03 m/s draught overshoot and
  // a 0.4 °C temperature overshoot are comparable, and clamped at 0 once met —
  // beyond the bar is done, not better, and rewarding overshoot would trade one
  // satisfied line against another.
  const taskShortfall: number[] = [];
  for (const g of zones) {
    // "*" is every room, graded on the worst of them — see checkGoals.
    if (g.metric === "temperature" && g.everywhere && g.roomId === "*") {
      let worst = -Infinity;
      for (const r of plan.rooms) worst = Math.max(worst, warmestPart(built, temp, r.rect));
      const c = outdoorTemp + worst;
      let short = 0;
      if (g.atMost !== undefined) short += Math.max(0, c - g.atMost);
      if (g.atLeast !== undefined) short += Math.max(0, g.atLeast - c);
      taskShortfall.push(short);
      continue;
    }
    const rect = g.zone ?? plan.rooms.find((r) => r.id === g.roomId)?.rect ?? null;
    if (!rect) { taskShortfall.push(0); continue; }
    let v: number | null = null;
    let scale = 1;
    if (g.metric === "draft") { v = zoneSpeed(built, rect); scale = 0.1; }
    else if (g.metric === "temperature") {
      const d = g.everywhere ? warmestPart(built, temp, rect) : zoneMean(built, temp, rect);
      v = d === null ? null : outdoorTemp + d;
      scale = 1;
    }
    else if (g.metric === "drying") { v = slowestDry(built, dryF, rect); scale = 30; }
    else { v = zoneMean(built, smell, rect); scale = 0.05; }
    if (v === null) { taskShortfall.push(0); continue; }
    let short = 0;
    if (g.atMost !== undefined) short += Math.max(0, v - g.atMost) / scale;
    if (g.atLeast !== undefined) short += Math.max(0, g.atLeast - v) / scale;
    taskShortfall.push(short);
  }

  let heaterWindowC: number | null = null;
  for (const it of plan.items) {
    if (it.type !== "heater" || it.on === false) continue;
    const zone = windowZone(plan, it.roomId);
    if (!zone) continue;
    const d = zoneMean(built, temp, zone);
    if (d === null) continue;
    const c = outdoorTemp + d;
    if (heaterWindowC === null || c < heaterWindowC) heaterWindowC = c;
  }

  // air movement, per room and house-wide, plus what actually leaves the house
  const sSum = new Float64Array(roomIds.length);
  const sN = new Int32Array(roomIds.length);
  let outflow = 0;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = sim.cIdx(i, j, k);
        if (sim.solid[c]) continue;
        const [u, v, w] = sim.velocityAt(i, j, k);
        const sp = Math.hypot(u, v, w);
        if (ambient[c]) { outflow += sp; continue; }
        if (!inside[c]) continue;
        const r = roomIndex[c];
        if (r < 0) continue;
        sSum[r] += sp;
        sN[r]++;
      }
  let houseMeanSpeed = 0, worstRoomSpeed = Infinity, rooms = 0;
  for (let r = 0; r < roomIds.length; r++) {
    if (!sN[r]) continue;
    const m = sSum[r] / sN[r];
    houseMeanSpeed += m;
    worstRoomSpeed = Math.min(worstRoomSpeed, m);
    rooms++;
  }
  houseMeanSpeed = rooms ? houseMeanSpeed / rooms : 0;

  const targets = targetIds.length ? targetIds : roomIds;
  const tTemps = targets.map((id) => roomTempC.get(id)).filter((v): v is number => v !== undefined);
  let tSpeedSum = 0, tSpeedN = 0;
  for (let r = 0; r < roomIds.length; r++) {
    if (!targets.includes(roomIds[r]) || !sN[r]) continue;
    tSpeedSum += sSum[r] / sN[r];
    tSpeedN++;
  }

  return {
    roomTempC,
    roomWarmestC,
    roomColdestC,
    roomFresh,
    roomDryMin,
    taskShortfall,
    worstTargetC: tTemps.length ? Math.max(...tTemps) : NaN, // see scoreOf: sign depends on the goal
    meanTargetC: tTemps.length ? tTemps.reduce((a, b) => a + b, 0) / tTemps.length : NaN,
    houseMeanSpeed,
    worstRoomSpeed: Number.isFinite(worstRoomSpeed) ? worstRoomSpeed : 0,
    outflow,
    targetSpeed: tSpeedN ? tSpeedSum / tSpeedN : 0,
    heaterWindowC,
  };
}

/** Collapse the metric vector to one ranked number. The temperature goals use a
 *  max–min form so every requested room has to be handled, plus a draught
 *  penalty ("coolest layout that doesn't blast the room"). */
function scoreOf(
  goal: OptimizeGoal,
  m: SolutionMetrics,
  targetTemps: number[],
  targetIds: string[] = [],
  drying = false,
): number {
  // THE TASK'S OWN LINES WIN when the app knows them. Nothing below is wrong,
  // but all of it is a PROXY for the goal word the sentence was reduced to, and
  // a proxy that disagrees with the tick-boxes is a search that confidently
  // recommends a failing layout. Scored on total shortfall, so a layout that
  // satisfies both lines beats every layout that satisfies one, and among those
  // that satisfy neither the closest wins — which is what makes the gallery
  // useful before the task is finished. The proxy stays as the tiebreak, at a
  // weight small enough that it can only order layouts the task cannot tell
  // apart.
  const base = proxyScore(goal, m, targetTemps, targetIds, drying);
  if (!m.taskShortfall.length) return base;
  // THE SENTENCE LEADS; THE TASK GUARDS. These were the wrong way round: the
  // task's own tick-boxes dominated at 100x, so "cool the living room" and
  // "cool the bedroom" produced the same answer — the search optimised the
  // scenario rather than the request, and the participant's words changed
  // nothing. That is the opposite of what the study is for.
  //
  // Now the request decides (`base` carries the goal word AND the rooms it was
  // grounded to), and the task's lines are a penalty on top: enough that among
  // layouts which serve the request equally the search prefers one that does
  // not wreck a goal, never enough to answer a different question from the one
  // asked. Off-scenario there are no task lines and this term is absent.
  const total = m.taskShortfall.reduce((a, b) => a + b, 0);
  return base - TASK_GUARD * total;
}

/** The original goal-word scoring: what to rank by when there is no task. */
function proxyScore(
  goal: OptimizeGoal,
  m: SolutionMetrics,
  targetTemps: number[],
  targetIds: string[] = [],
  drying = false,
): number {
  const draft = Math.max(0, m.targetSpeed - DRAFT_CAP) * DRAFT_PENALTY;
  // A DRYING TASK IS SCORED ON MINUTES, not on how fast the air is moving.
  // Ranking by air speed picked the layout that stirred the bathroom hardest,
  // which is not the same as the one that clears the damp corner — the search
  // moved the extract 1.5 m, reported a triumph, and left the room at 177
  // minutes against a 95-minute goal. Optimise the number the task is graded
  // on and the two finally point the same way.
  if (drying) {
    const ids = targetIds.length ? targetIds : [...m.roomDryMin.keys()];
    const mins = ids.map((id) => m.roomDryMin.get(id)).filter((v): v is number => v !== undefined);
    if (mins.length) return -Math.max(...mins);
  }
  // THE CORNER THAT IS STILL WRONG, not the average of the room.
  //
  // "Cool the apartment" was scored on room MEANS, and a mean is happily
  // satisfied by chilling one end hard — so the search would return a layout
  // with a cold pool by the unit and a warm far corner and call it the answer.
  // Brute-forcing 192 reachable layouts and ranking them by the warmest corner
  // put the search's pick in the BOTTOM 20%: it was not searching badly, it was
  // searching for the wrong thing. Scored on the worst corner instead, the
  // search optimises what the words mean and what the tick-box measures.
  // A BLEND, because the two readings answer different halves of the question.
  // The room MEAN is what most of these tasks are graded on and what a person
  // means by "is the room warm"; the worst CORNER is what they complain about
  // once the mean is fine, and it is what an "everywhere" goal measures. Scored
  // on the mean alone the search would chill one end hard and call it done;
  // scored on the corner alone it drifts away from the number the tick-box
  // actually reads. 60/40 toward the corner keeps both honest.
  const worstIds = targetIds.length ? targetIds : [...m.roomWarmestC.keys()];
  const roomMean = targetTemps.length
    ? (goal === "cool" ? Math.max(...targetTemps) : Math.min(...targetTemps))
    : 0;
  if (goal === "cool") {
    const hot = worstIds.map((id) => m.roomWarmestC.get(id)).filter((v): v is number => v !== undefined);
    const corner = hot.length ? Math.max(...hot) : roomMean;
    return -(0.6 * corner + 0.4 * roomMean + 0.25 * m.meanTargetC) - draft;
  }
  if (goal === "warm") {
    const cold = worstIds.map((id) => m.roomColdestC.get(id)).filter((v): v is number => v !== undefined);
    const corner = cold.length ? Math.min(...cold) : roomMean;
    const worst = 0.6 * corner + 0.4 * roomMean;
    // The cold pool at the glazing counts too, at a third of a room's weight:
    // enough to break the tie between two placements that warm the room equally,
    // not enough to trade away the room the user actually asked about. Capped at
    // the comfort ceiling so a heater pressed against the glass can't farm score
    // by roasting one strip of floor.
    const glass = m.heaterWindowC === null ? 0 : 0.35 * Math.min(m.heaterWindowC, 24);
    return worst + 0.25 * m.meanTargetC + glass - draft;
  }
  if (goal === "ventilate") {
    // FRESHNESS WHERE IT WAS ASKED FOR, not air speed everywhere. Scored on
    // movement, this goal's answer was always "open every window and turn
    // everything up" — more openings, more outflow, higher score — which is
    // precisely the trap the studio task is built around: its second window
    // feeds an extract two metres away and robs the first of the inflow that
    // was crossing the room. The search cheerfully proposed it every time.
    // Air movement stays in as a tiebreak between layouts that are equally
    // fresh, because a stagnant room that happens to measure clean is not what
    // anyone means by "air this place out".
    const ids = targetIds.length ? targetIds : [...m.roomFresh.keys()];
    const fresh = ids.map((id) => m.roomFresh.get(id)).filter((v): v is number => v !== undefined);
    const worstFresh = fresh.length ? Math.min(...fresh) : 0;
    return 10 * worstFresh + 0.02 * m.outflow + 0.2 * m.houseMeanSpeed;
  }
  // circulate: air moving WHERE IT WAS ASKED FOR. Scored on the house mean and
  // the worst room, "move air from here to there" was satisfied by stirring any
  // room at all — so a fan parked in the destination outscored one actually
  // pushing air through the doorway into it.
  return 2 * m.targetSpeed + 0.5 * m.houseMeanSpeed;
}

function evaluate(
  plan: FloorPlan,
  goal: OptimizeGoal,
  targetIds: string[],
  outdoorTemp: number,
  fid: typeof SCREEN,
  drying = false,
  zones: TaskZone[] = [],
): { metrics: SolutionMetrics; score: number } {
  const metrics = measure(plan, targetIds, outdoorTemp, fid, zones);
  const targetTemps = targetIds.map((id) => metrics.roomTempC.get(id)).filter((v): v is number => v !== undefined);
  return { metrics, score: scoreOf(goal, metrics, targetTemps, targetIds, drying) };
}

// ---- strategies: the discrete variables that were never searched ----

/** Would shutting the interior doors cut a target room off from the only thing
 *  that can serve it?
 *
 *  The winter task is the case that forced this. The heater is room-bound (it
 *  lives in the living room and the search may not carry it next door — see
 *  ROOM_BOUND_DEVICES), the targets are BOTH rooms, and "interior doors shut to
 *  concentrate it" therefore passes the living room by sealing the bedroom at
 *  the outdoor 2 °C. The score notices, but only after the fact: the option is
 *  still built, still shown, and still reads as advice. It is not advice, it is
 *  a way of failing half the request, and nobody would follow it.
 *
 *  So: if a target room has no primary device of its own, the doorway is that
 *  room's only supply and the shut-doors strategy is not offered at all. */
function doorsMustStayOpen(goal: OptimizeGoal, plan: FloorPlan, targetIds: string[]): boolean {
  if (plan.rooms.length < 2) return false;
  const primary = primaryFor(goal, plan);
  const served = new Set(plan.items.filter((it) => it.type === primary && it.on !== false).map((it) => it.roomId));
  const targets = targetIds.length ? targetIds : plan.rooms.map((r) => r.id);
  return targets.some((id) => !served.has(id));
}

function strategiesFor(
  goal: OptimizeGoal,
  lockPower = false,
  allowed?: string[],
  ctx?: { plan: FloorPlan; targetIds: string[]; movable?: string[] },
): Strategy[] {
  /** Strip device settings the task does not let anyone change, so a strategy
   *  never quietly switches something the participant cannot reach. */
  const only = (devices: Strategy["devices"]): Strategy["devices"] => {
    if (!allowed) return devices;
    const out: Strategy["devices"] = {};
    for (const [type, spec] of Object.entries(devices)) if (allowed.includes(type)) out[type] = spec;
    return out;
  };
  /** Name the devices a strategy is actually free to move, for its label. The
   *  option card used to read "Move the fan and vents" on a task where the vent
   *  is bolted to the wall and running all night — describing a change it was
   *  no longer making. */
  /** "the ac" is not how anyone writes it. Acronyms keep their case. */
  const deviceWord = (t: string): string => {
    const l = DEVICE_LABEL[t] ?? t;
    return l === l.toUpperCase() ? l : l.toLowerCase();
  };
  /** Devices this strategy actually asks the participant to place. A device it
   *  switches OFF is not one of them — "Move the heater and the fan" on a card
   *  whose small print says "fan left off" describes something it is not doing. */
  const placed = (devices: Strategy["devices"]) =>
    Object.entries(devices)
      .filter(([t, spec]) => (!allowed || allowed.includes(t)) && (spec as { on?: boolean }).on !== false);
  const movedNames = (devices: Strategy["devices"]): string => {
    const names = placed(devices).map(([t]) => deviceWord(t));
    if (names.length === 0) return "the openings";
    if (names.length === 1) return `the ${names[0]}`;
    return `the ${names.slice(0, -1).join(", the ")} and the ${names[names.length - 1]}`;
  };
  /** The whole verb phrase, because MOVE is not always the verb. A rented
   *  studio's air conditioner is bolted to the wall and the task is which way it
   *  points, so "Move the ac and the fan" describes something nobody can do —
   *  the same complaint as "Move the fan and vents" above, one step further on.
   *  Devices the task will not let anyone carry are AIMED. */
  const movable = ctx?.movable;
  const actionOn = (devices: Strategy["devices"]): string => {
    const types = placed(devices).map(([t]) => t);
    if (!movable || types.length === 0) return `Move ${movedNames(devices)}`;
    const pick = (keep: boolean) =>
      types.filter((t) => movable.includes(t) === keep).map(deviceWord);
    const list = (n: string[]) =>
      n.length === 1 ? `the ${n[0]}` : `the ${n.slice(0, -1).join(", the ")} and the ${n[n.length - 1]}`;
    const moves = pick(true);
    const aims = pick(false);
    if (aims.length === 0) return `Move ${list(moves)}`;
    if (moves.length === 0) return `Aim ${list(aims)}`;
    return `Aim ${list(aims)}, move ${list(moves)}`;
  };
  const out: Strategy[] = [];
  const add = (s: Strategy) => out.push(s);

  if (goal === "cool" || goal === "warm") {
    const dev = goal === "cool" ? "ac" : "heater";
    const other = goal === "cool" ? "heater" : "ac";
    // WINDOWS STAY SHUT for a heating or cooling goal. Opening one throws the
    // conditioned air straight outside and pulls the outdoor temperature in —
    // it is the opposite of the goal, and suggesting it to someone trying to
    // warm a room in winter reads as broken advice however the numbers land.
    // Interior doors are still searched: those move heat between rooms.
    const doorStates = ctx && doorsMustStayOpen(goal, ctx.plan, ctx.targetIds) ? [true] : [true, false];
    // A FAN IS A THING YOU CAN ALSO NOT USE — but only where the participant can
    // switch it back on.
    //
    // `lockPower` hides the whole power block, on/off included (see Panel), so a
    // card that switches the fan off on a locked task hands back a home whose
    // fan cannot be revived: the sweep toggle still moves, the fan still does
    // nothing, and there is no control anywhere that explains why. That is what
    // happened on the winter task — a typed goal returned "fan → off", and
    // after applying it the fan was dead for the rest of the session.
    //
    // So the off-variant is offered exactly where the dial is available.
    const fanStates = lockPower ? [true] : [true, false];
    for (const power of lockPower ? [2] : [2, 3]) {
      for (const doorsOpen of doorStates) {
        for (const fanOn of fanStates) {
        const devices = only({
          [dev]: { on: true, power },
          [other]: { on: false },
          // Locked tasks keep the fan on medium too — it is a device dial like
          // any other, and dropping it to low is a change the user cannot make.
          fan: { on: fanOn, power: lockPower ? 2 : doorsOpen ? 2 : 1, oscillate: true },
        });
        add({
          id: `${dev}${power}-${doorsOpen ? "doors" : "shut"}${fanOn ? "" : "-nofan"}`,
          // With the dial locked the only thing that varies is placement, so the
          // label must describe THAT rather than a power the user can't set.
          label: lockPower
            ? actionOn(devices)
            : `${DEVICE_LABEL[dev] ?? dev} on ${power === 3 ? "high" : "medium"}`,
          devices,
          interiorDoors: doorsOpen,
          openWindowIds: [],
          note: [
            doorsOpen ? "interior doors open so the air reaches every room" : "interior doors shut to concentrate it",
            "windows shut to keep the outdoor air out",
            fanOn ? "fan running" : "fan left off",
          ].join(", "),
        });
        }
      }
    }
    return out;
  }

  // ventilate / circulate / balanced: the openings matter more than the power.
  //
  // SHUTTING THE WINDOWS IS NOT AN OPTION WHEN THEY ARE THE ONLY WAY IN. An
  // extract with nothing open has no make-up air: it depressurises the room and
  // moves nothing (see sim3d). The bathroom is the case — its door is locked
  // shut by the task — and "windows shut, recirculating indoors" was being
  // offered there as one of three ways to dry the room out, when it is the one
  // arrangement guaranteed not to.
  const canSeal = !ctx || ctx.plan.doors.some((d) => d.rooms.includes("outside") && !d.locked);
  const windows = (ctx?.plan.windows ?? []).filter((w) => w.rooms.includes("outside") && !w.locked);
  // WHICH windows, not whether. With two or three of them the subsets are cheap
  // to enumerate and one of them is usually the answer; beyond that the count
  // explodes and would starve the placement search, so fall back to the old
  // all-or-nothing pair.
  let sets: string[][];
  if (windows.length === 0) sets = [[]];
  else if (windows.length <= 3) {
    sets = [];
    for (let mask = (1 << windows.length) - 1; mask >= 0; mask--) {
      const ids = windows.filter((_, i) => mask & (1 << i)).map((w) => w.id);
      if (!ids.length && !canSeal) continue;
      sets.push(ids);
    }
  } else sets = canSeal ? [windows.map((w) => w.id), []] : [windows.map((w) => w.id)];

  const nameOf = (ids: string[]): string => {
    if (ids.length === 0) return "windows shut, recirculating indoors";
    if (ids.length === windows.length)
      return windows.length === 1 ? "the window open to purge stale air" : "every window open to purge stale air";
    const named = ids
      .map((id) => windows.find((w) => w.id === id))
      .filter((w): w is Opening => !!w)
      .map((w) => `${sideOfWindow(ctx!.plan, w)} window`);
    return `only the ${named.join(" and ")} open`;
  };
  /** WHICH WINDOWS IS THE DECISION, so it belongs in the title. With the power
   *  dial locked every option's label collapsed to "Move the fan" — three cards
   *  with the same heading, differing only in a line of small print, which is
   *  the "why did it suggest the same thing twice" complaint in another form. */
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  const titleFor = (base: string, ids: string[]): string => {
    if (sets.length <= 1) return base;
    if (ids.length === 0) return `Windows shut — ${base.toLowerCase()}`;
    if (ids.length === windows.length && windows.length > 1) return `Both windows open — ${base.toLowerCase()}`;
    const named = ids
      .map((id) => windows.find((w) => w.id === id))
      .filter((w): w is Opening => !!w)
      .map((w) => sideOfWindow(ctx!.plan, w));
    return cap(`${named.join(" + ")} window open — ${base.toLowerCase()}`);
  };

  for (const power of lockPower ? [2] : [2, 3]) {
    for (const ids of sets) {
      const devices = only({ fan: { on: true, power, oscillate: true }, supply: { on: true, power }, return: { on: true, power } });
      add({
        id: `air${power}-w${ids.join("_") || "none"}`,
        label: titleFor(
          lockPower ? actionOn(devices) : `Air movers on ${power === 3 ? "high" : "medium"}`,
          ids,
        ),
        devices,
        interiorDoors: true,
        openWindowIds: ids,
        note: nameOf(ids),
      });
    }
  }
  return out;
}

// ---- placement search within one strategy ----

/** Greedy placement over the goal's devices, two sweeps, no early exit. Returns
 *  the best plan found under the coarse screening fidelity. */
function placeDevices(
  base: FloorPlan,
  goal: OptimizeGoal,
  targetIds: string[],
  outdoorTemp: number,
  budget: { left: number },
  allowed?: string[],
  drying = false,
  flow?: FlowHint,
  zones: TaskZone[] = [],
  /** Of `allowed`, the subset the search may REPOSITION. Undefined = all of
   *  them, which is the unrestricted app. See the aim-only branch below. */
  movableDevices?: string[],
): { plan: FloorPlan; changes: string[]; primaryAlts: PrimaryAlt[] } {
  const wanted = allowed
    ? GOAL_DEVICES[goal].filter((t) => allowed.includes(t))
    : GOAL_DEVICES[goal];
  const targets = targetIds.length
    ? targetIds.map((id) => base.rooms.find((r) => r.id === id)).filter((r): r is FloorPlan["rooms"][0] => !!r)
    : [largestRoom(base)];
  const roomOrder = [
    ...targets,
    ...base.rooms.filter((r) => !targets.some((t) => t.id === r.id)),
  ];
  // Openings a placement must stay clear of. A DOORWAY has to stay walkable, so
  // nothing may sit in front of one. A WINDOW does not: you cannot walk through
  // it, and a radiator under the glass is where a radiator belongs. Treating the
  // two alike slid the under-window candidate 1.1 m along the wall — far enough
  // that it stopped killing the cold pool it exists to kill (16.5 °C at the
  // glass instead of 26.4 °C), which is how the search kept ranking it level
  // with the far wall.
  const openings = [...base.doors, ...base.windows];
  const blockersFor = (type: string) => (type === "heater" ? base.doors : openings);
  const changes: string[] = [];

  let working = base;
  // Primary device first (the AC for a cooling goal, the heater for warming):
  // with a small per-strategy budget the order decides who actually gets
  // searched, and spending it on the fan while the AC sits in the wrong room
  // is the worst possible allocation.
  const primary = primaryFor(goal, working, allowed);
  const movable = working.items
    .filter((it) => wanted.includes(it.type) && it.on !== false)
    .sort((a, b) => (b.type === primary ? 1 : 0) - (a.type === primary ? 1 : 0));
  // Every spot the PRIMARY device was tried in, so the caller can offer the
  // runner-ups as real alternatives. When a task pins the power, locks the
  // windows and bolts the heater to one room — the winter task does all three —
  // placement is the ONLY variable left, so a gallery built from strategies
  // alone collapses to a single card. The alternatives have to come from where
  // things go, because that is the entire question being asked.
  let primaryAlts: PrimaryAlt[] = [];

  // Two sweeps: after the second device moves, the first one's best spot may
  // have changed. One pass could never see that (research report §1.3).
  for (let sweep = 0; sweep < 2; sweep++) {
    for (const dev of movable) {
      const it = working.items.find((o) => o.id === dev.id);
      if (!it) continue;
      // A room-bound device (the heater) is searched only within the room it is
      // already standing in — see ROOM_BOUND_DEVICES.
      //
      // A device the user drew an ARROW for is searched in the room the arrow
      // STARTS in, not the room it points at. That room is still the target and
      // still what the score measures; it is simply not where you stand a fan
      // that has to push air into it.
      const flowRoom = flow?.fromRoomId
        ? base.rooms.find((r) => r.id === flow.fromRoomId) ?? null
        : null;
      // The arrow's tail is a CONSTRAINT, not a preference. Merely searching
      // that room first changed nothing: every room was still searched and the
      // score — which rewards air movement wherever it happens — still preferred
      // standing the fan in the middle of the destination, where it stirs that
      // room nicely and carries nothing into it. The user drew where the air
      // should come from; that is not a hint to be outvoted.
      const rooms = ROOM_BOUND_DEVICES.includes(it.type)
        ? roomOrder.filter((r) => r.id === it.roomId)
        : flowRoom
          ? [flowRoom]
          : roomOrder;
      let best: { pos: Vec3; rot: number; roomId: string; roomName: string; osc?: boolean; score: number } | null = null;
      // BOLTED DOWN IS NOT THE SAME AS OFF-LIMITS. A task can let you re-aim a
      // device without letting you move it — a rented studio's air conditioner
      // is the case the distinction exists for — and the search only knew one
      // kind of permission, so allowing the AC at all allowed relocating it. It
      // proposed carrying a wall-mounted unit 3.4 m to the opposite wall, which
      // is not a suggestion; it is the extract-vent bug again in another room.
      //
      // For an aim-only device the candidate set is its CURRENT position at
      // every heading, which is exactly the lever the participant has.
      const aimOnly = movableDevices !== undefined && !movableDevices.includes(it.type);
      // A UNIT ON A WALL CANNOT BLOW THROUGH IT. Sweeping the full circle put a
      // third of the candidate aims into the plaster behind the casing — plans
      // the solver dutifully scored and the vanes could not represent. The arc
      // is the wall's normal plus or minus 75 degrees, which is about what a
      // real louvre reaches.
      const fixedAt = it.mountYaw;
      for (const room of aimOnly ? rooms.filter((r) => r.id === it.roomId) : rooms) {
        // AIM IS TWO ANGLES, NOT ONE. The sweep only varied yaw, so on a task
        // whose answer is "tilt the louvre up off the bed" the search could not
        // reach the answer at all — it turned the unit left and right forever
        // while the jet stayed on the pillow. Tilt is the other half of aimVec
        // and the participant has a control for it, so the search gets one too:
        // seven headings across the wall's arc x five angles from 40° down to
        // 60° up, which is the range of the panel's own slider.
        // A WALL UNIT HAS ONE AXIS OF AIM, NOT TWO. Its casing is bolted flat and
        // the participant has no horizontal control for it (see canTurn), so
        // proposing a heading change is proposing something they cannot carry
        // out — and worse, cannot undo. For anything on a wall the sweep is TILT
        // ALONE; a free-standing aimable device still gets the full circle
        // crossed with tilt.
        const spots = aimOnly
          ? it.mount === "wall"
            ? TILT_STEPS.map((tilt) => ({
                position: it.position,
                rotationY: it.rotationY,
                tilt,
                roomId: it.roomId,
                roomName: room.name,
                axis: "area" as const,
                oscillate: false,
              }))
            : TILT_STEPS.slice(1, 6).flatMap((tilt) =>
                Array.from({ length: 5 }, (_, i) => ({
                  position: it.position,
                  rotationY:
                    fixedAt === undefined
                      ? -Math.PI + (i * 2 * Math.PI) / 5
                      : fixedAt - 1.31 + (i * 2.62) / 4,
                  tilt,
                  roomId: it.roomId,
                  roomName: room.name,
                  axis: "area" as const,
                  oscillate: false,
                })),
              )
          : candidateSpots(room, it.type, working.wallHeight, openings);
        // The tail of the arrow itself, aimed along it: the spot the user
        // literally pointed at, which no generic candidate list contains.
        if (flow && room.id === flow.fromRoomId && !ROOM_BOUND_DEVICES.includes(it.type)) {
          const yaw = Math.atan2(flow.to[0] - flow.from[0], flow.to[1] - flow.from[1]);
          spots.unshift({
            position: [flow.from[0], it.position[1], flow.from[1]],
            rotationY: yaw,
            roomId: room.id,
            roomName: room.name,
            axis: "area",
            oscillate: false,
          });
        }
        for (const cand of spots) {
          if (budget.left <= 0) break;
          const others = working.items.filter((o) => o.id !== it.id);
          const wallBound = cand.axis !== "area";
          // An aim-only device is already where it belongs and is not competing
          // for floor space — running it through the collision solver only lets
          // it drift a few centimetres off its own bracket, which then reads as
          // a move on the card.
          const pos = aimOnly
            ? it.position
            : findFreeSpot(
            room.rect,
            { size: it.size, rotationY: cand.rotationY, mount: it.mount },
            others,
            cand.position,
            cand.axis,
            0.04,
            blockersFor(it.type),
            !wallBound,
          );
          if (!pos) continue;
          const placed: Vec3 = aimOnly
            ? it.position
            : wallBound
            ? cand.axis === "x"
              ? [pos[0], cand.position[1], cand.position[2]]
              : [cand.position[0], cand.position[1], pos[2]]
            : [pos[0], cand.position[1], pos[2]];
          const trial: FloorPlan = {
            ...working,
            items: working.items.map((o) =>
              o.id === it.id
                ? {
                    ...o,
                    position: placed,
                    rotationY: cand.rotationY,
                    roomId: cand.roomId,
                    ...(typeof (cand as { tilt?: number }).tilt === "number" ? { tilt: (cand as { tilt?: number }).tilt } : {}),
                    ...(cand.oscillate !== undefined ? { oscillate: cand.oscillate } : {}),
                  }
                : o,
            ),
          };
          budget.left--;
          const { score } = evaluate(trial, goal, targetIds, outdoorTemp, drying ? SCREEN_DRY : SCREEN, drying, zones);
          if (it.type === primary && sweep === 1) {
            primaryAlts.push({ pos: placed, rot: cand.rotationY, roomId: cand.roomId, roomName: cand.roomName, score });
          }
          if (!best || score > best.score) {
            best = { pos: placed, rot: cand.rotationY, roomId: cand.roomId, roomName: cand.roomName, osc: cand.oscillate, score };
          }
        }
      }
      if (!best) continue;
      const prev = working.items.find((o) => o.id === it.id)!;
      const moved =
        Math.abs(best.pos[0] - prev.position[0]) > 0.05 ||
        Math.abs(best.pos[2] - prev.position[2]) > 0.05 ||
        Math.abs(best.rot - prev.rotationY) > 0.05;
      working = {
        ...working,
        items: working.items.map((o) =>
          o.id === it.id
            ? { ...o, position: best!.pos, rotationY: best!.rot, roomId: best!.roomId, ...(best!.osc !== undefined ? { oscillate: best!.osc } : {}) }
            : o,
        ),
      };
      // "AC -> Studio" is a nonsense line for a unit bolted to the wall of the
      // studio it is already in: nothing went anywhere, the louvre turned. Say
      // which way it now points instead, in the compass words the rest of the
      // cards use.
      if (moved && sweep === 1) {
        changes.push(
          aimOnly
            ? `${DEVICE_LABEL[it.type] ?? it.type} → aimed ${headingName(best.rot)}`
            : `${DEVICE_LABEL[it.type] ?? it.type} → ${best.roomName}`,
        );
      }
    }
  }
  // Best first, and only spots that are meaningfully APART — two candidates
  // 20 cm from each other are the same advice twice, which is exactly what the
  // gallery was accused of showing.
  primaryAlts.sort((a, b) => b.score - a.score);
  const spread: PrimaryAlt[] = [];
  for (const a of primaryAlts) {
    // Two alternatives are the same alternative when they are close in position
    // AND pointing the same way. Distance alone was enough while every primary
    // could be carried around; for a device that is bolted down and only aimed,
    // every alternative shares one position and the whole set collapsed to a
    // single card — on the task where the aim IS the question.
    if (
      spread.some(
        (k) =>
          Math.hypot(k.pos[0] - a.pos[0], k.pos[2] - a.pos[2]) < ALT_MIN_APART &&
          Math.abs(Math.atan2(Math.sin(k.rot - a.rot), Math.cos(k.rot - a.rot))) < ALT_MIN_TURN,
      )
    )
      continue;
    spread.push(a);
    if (spread.length >= 6) break;
  }
  primaryAlts = spread;
  return { plan: working, changes, primaryAlts };
}

/** The panel's own vertical-aim slider runs to ±60°, so the search stays inside
 *  what the participant could actually set. */
const clampTilt = (t: number) => Math.max(-Math.PI / 3, Math.min(Math.PI / 3, t));

/** Hill-climb a plan by NUDGING what the task lets you move: small steps in
 *  position and small turns of the aim, keeping anything that scores better,
 *  until nothing does.
 *
 *  THE CANDIDATE GRID CANNOT BE THE LAST WORD. It is a coarse sample of a
 *  continuous space — the studio's answer wants the fan roughly 30 cm off the
 *  glass at a heading no cardinal direction expresses — so the search would
 *  land in the right neighbourhood and stop a metre short. Screening more grid
 *  points is the expensive way to fix that (the grid grows as the square);
 *  walking downhill from the best few is the cheap one, and it is also the only
 *  thing that can answer "a bit further along", which is the other half of what
 *  this is for.
 *
 *  Deliberately local and deliberately small: it refines an answer, it does not
 *  search for one. Two rounds at a shrinking step, which is enough to close the
 *  gap between a grid point and the optimum near it without turning into a
 *  second global search. */
function refine(
  start: FloorPlan,
  goal: OptimizeGoal,
  targetIds: string[],
  outdoorTemp: number,
  fid: typeof SCREEN,
  drying: boolean,
  zones: TaskZone[],
  movable: string[] | undefined,
  aimable: string[] | undefined,
  budget: { left: number },
): { plan: FloorPlan; improved: boolean; neighbours: Array<{ plan: FloorPlan; score: number }> } {
  const canMove = (t: string) => !movable || movable.includes(t);
  const canAim = (t: string) => !aimable || aimable.includes(t);
  const targets = start.items.filter(
    (it) => it.on !== false && (canMove(it.type) || canAim(it.type)) && (movable || aimable ? true : false),
  );
  if (targets.length === 0) return { plan: start, improved: false, neighbours: [] };

  let best = start;
  let bestScore = evaluate(start, goal, targetIds, outdoorTemp, fid, drying, zones).score;
  const startScore = bestScore;
  // Every distinct layout the walk looked at, best first. When the starting
  // point is ALREADY a local optimum — which it is whenever the participant is
  // asking to adjust something the search itself just polished — there is no
  // improvement to report, and answering "nothing to offer" is not useful. The
  // nearest alternatives are still the answer to "show me something slightly
  // different"; they are just not better.
  const neighbours: Array<{ plan: FloorPlan; score: number }> = [];

  for (const step of [0.55, 0.28]) {
    const turn = step > 0.4 ? Math.PI / 6 : Math.PI / 12;
    for (const it of targets) {
      const here = best.items.find((o) => o.id === it.id);
      if (!here) continue;
      const room = best.rooms.find((r) => r.id === here.roomId);
      if (!room) continue;
      const moves: Array<{ dx: number; dz: number; dr: number; dtilt?: number }> = [];
      if (canMove(it.type)) {
        for (const [dx, dz] of [[step, 0], [-step, 0], [0, step], [0, -step], [step, step], [-step, -step], [step, -step], [-step, step]]) {
          moves.push({ dx, dz, dr: 0 });
        }
      }
      if (canAim(it.type)) {
        // Tilt is half the aim — see the aim-only candidate list. Without this
        // the polish could move an air conditioner's heading and never its
        // angle, which is the one that gets the jet off the bed.
        for (const dt of [turn, -turn]) moves.push({ dx: 0, dz: 0, dr: 0, dtilt: dt });
        // …and for a wall unit that is the ONLY half: the casing does not turn.
        for (const dr of it.mount === "wall" ? [] : [turn, -turn]) {
          // …and the polish stays inside that arc as well, or it walks the aim
          // round into the wall one nudge at a time.
          if (here.mountYaw !== undefined) {
            const off = Math.atan2(Math.sin(here.rotationY + dr - here.mountYaw), Math.cos(here.rotationY + dr - here.mountYaw));
            if (Math.abs(off) > 1.31) continue;
          }
          moves.push({ dx: 0, dz: 0, dr });
        }
      }
      for (const m of moves) {
        if (budget.left <= 0) break;
        const cur = best.items.find((o) => o.id === it.id)!;
        const px = cur.position[0] + m.dx;
        const pz = cur.position[2] + m.dz;
        // Stay inside the room it is already in — a nudge is not a relocation,
        // and a wall-mounted unit must stay on its wall, so only aim moves for
        // anything the task will not let the participant carry.
        if (m.dx || m.dz) {
          if (!canMove(it.type) || cur.mount !== "floor") continue;
          if (px < room.rect.x + 0.3 || px > room.rect.x + room.rect.w - 0.3) continue;
          if (pz < room.rect.z + 0.3 || pz > room.rect.z + room.rect.d - 0.3) continue;
          const others = best.items.filter((o) => o.id !== it.id);
          const blockers = it.type === "heater" ? best.doors : [...best.doors, ...best.windows];
          const free = findFreeSpot(room.rect, { size: it.size, rotationY: cur.rotationY, mount: it.mount }, others, [px, cur.position[1], pz], "area", 0.04, blockers, true);
          if (!free || Math.hypot(free[0] - px, free[2] - pz) > 0.05) continue;
        }
        const trial: FloorPlan = {
          ...best,
          items: best.items.map((o) =>
            o.id === it.id
              ? {
                  ...o,
                  position: [px, o.position[1], pz] as Vec3,
                  rotationY: o.rotationY + m.dr,
                  ...(m.dtilt ? { tilt: clampTilt((o.tilt ?? 0) + m.dtilt) } : {}),
                }
              : o,
          ),
        };
        budget.left--;
        const { score } = evaluate(trial, goal, targetIds, outdoorTemp, fid, drying, zones);
        neighbours.push({ plan: trial, score });
        if (score > bestScore) {
          bestScore = score;
          best = trial;
        }
      }
    }
  }
  neighbours.sort((a, b) => b.score - a.score);
  return { plan: best, improved: bestScore > startScore + 1e-6, neighbours };
}


/** "the ac only" is not how anyone writes it — acronyms keep their case. */
const acronymSafe = (l: string) => (l === l.toUpperCase() ? l : l.toLowerCase());

/** The gallery for a MICRO-ADJUSTMENT: two or three layouts a short walk from
 *  the one already on screen, rather than a fresh search.
 *
 *  Three walks, because "nudge it" is ambiguous about WHAT to nudge and the
 *  honest answer is to show the small set of readings: move everything a
 *  little, move only the device the goal turns on, or leave everything where it
 *  is and only change the aim. Whichever the person meant, one of these is it,
 *  and all three are recognisably the layout they already have. */
function refineOptions(
  plan: FloorPlan,
  goal: OptimizeGoal,
  targetIds: string[],
  opts: FindOptions,
  dryingTask: boolean,
  want: number,
): Solution[] {
  const fid = dryingTask ? SCREEN_DRY : SCREEN;
  const primary = primaryFor(goal, plan, opts.allowedDevices);
  const movable = opts.movableDevices;
  const aimable = opts.allowedDevices;
  const walks: Array<{ label: string; note: string; movable?: string[]; aimable?: string[] }> = [
    { label: "Nudged — everything a little", note: "The same idea, moved a step", movable, aimable },
    {
      label: `Nudged — the ${acronymSafe(DEVICE_LABEL[primary] ?? primary)} only`,
      note: "Only the one thing this goal turns on",
      movable: movable?.filter((t) => t === primary) ?? [primary],
      aimable: [primary],
    },
    { label: "Re-aimed only — nothing moved", note: "Same places, different angles", movable: [], aimable },
  ];
  const out: Solution[] = [];
  const seen = new Set<string>([layoutKey(plan)]);
  for (const w of walks) {
    if (out.length >= want) break;
    const budget = { left: opts.refineBudget ?? 70 };
    const { plan: better, improved, neighbours } = refine(
      plan, goal, targetIds, opts.outdoorTemp, fid, dryingTask,
      opts.taskZones ?? [], w.movable, w.aimable, budget,
    );
    // Improved if it can be; otherwise the best thing it looked at. A layout
    // the search has already polished has no better neighbour by definition,
    // and "no options" in answer to "nudge it" is the dead end this whole path
    // exists to remove.
    const pick = improved ? better : neighbours.find((n) => !seen.has(layoutKey(n.plan)))?.plan;
    if (!pick) continue;
    const key = layoutKey(pick);
    if (seen.has(key)) continue;
    seen.add(key);
    const { metrics, score } = evaluate(pick, goal, targetIds, opts.outdoorTemp, FINAL, dryingTask, opts.taskZones);
    out.push({
      id: `refine-${out.length}`,
      readout: dryingTask ? "drying" : goal === "ventilate" || goal === "circulate" ? "freshness" : "temperature",
      label: w.label,
      detail: [w.note, ...movedLines(plan, pick)],
      plan: pick,
      metrics,
      score,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// ---- top level ----

export interface FindOptions {
  outdoorTemp: number;
  /** Device types the search is allowed to touch — move, aim or switch. Comes
   *  from the task's own ScenarioTools, because a suggestion the participant
   *  cannot carry out is not a suggestion.
   *
   *  The studio task is the case that forced this: it is about a fan and two
   *  windows, and the extract vent runs all night by definition. The search had
   *  no idea, read GOAL_DEVICES for the goal, and cheerfully proposed relocating
   *  the extract — which is not a thing anyone can do at midnight, and answers a
   *  question the task had deliberately closed. Undefined = no restriction (the
   *  unrestricted app). */
  allowedDevices?: string[];
  /** The ACTIVE TASK's checkable lines, so the search optimises what the
   *  participant is graded on rather than a proxy for it. Omit off-scenario. */
  taskZones?: TaskZone[];
  /** Screening evaluations the local polish pass may spend across all finalists.
   *  Separate from screenBudget because it buys something different: not more
   *  places to look, but a better answer at the places already found. */
  refineBudget?: number;
  /** MICRO-ADJUSTMENT MODE. Skip the strategies and the global placement sweep
   *  entirely and just walk downhill from the layout the participant already
   *  has. This is what "move it a bit further along" means: they are not asking
   *  to be shown somewhere else, they are asking for the same idea, nudged —
   *  and a full search answers by proposing a different idea, which reads as
   *  not having been listened to. */
  refineOnly?: boolean;
  /** Of `allowedDevices`, the ones that may actually MOVE. A device that is
   *  allowed but not movable is re-aimed in place — a rented studio's AC is
   *  bolted to the wall and the task is entirely about which way it points.
   *  Undefined = everything allowed is also movable. */
  movableDevices?: string[];
  /** How many solutions to offer. */
  want?: number;
  /** Coarse screening evaluations to spend across all strategies. */
  screenBudget?: number;
  /** The task forbids changing the device dial (ScenarioTools.lockPower), so
   *  every suggestion must be reachable by MOVING things. Offering "heater on
   *  high" when the control is hidden proposes something the participant
   *  cannot do. */
  lockPower?: boolean;
  /** Where a drawn arrow starts and ends. A fan is placed at the TAIL, aimed
   *  along it — see FlowHint. */
  flow?: FlowHint;
  /** May the search MOVE a window, not just open and shut it?
   *
   *  Off by default, and deliberately opt-in per task. In the bathroom the
   *  window's position is half the question — the extract and the glazing
   *  short-circuit when they are close, and the participant is expected to
   *  separate them — so a search that can only toggle it is answering a
   *  different question from the one being asked. Everywhere else the glazing
   *  is part of the building and suggesting it move is not advice. */
  moveOpenings?: boolean;
}

/**
 * Search the user's layout for several good configurations for the goal, best
 * first. Each is a complete, applicable plan with its predicted per-room
 * temperatures, so the user picks the trade-off rather than being handed one.
 */
export function findSolutions(
  plan: FloorPlan,
  goal: OptimizeGoal,
  targetIds: string[],
  opts: FindOptions,
): Solution[] {
  const want = opts.want ?? 3;
  // A room with a moisture source is asking "how long until it is dry", not
  // "how fresh is the air" — see roomDryMin.
  const dryingTask = plan.items.some((it) => it.type === "damp");

  if (opts.refineOnly) return refineOptions(plan, goal, targetIds, opts, dryingTask, want);

  // RAISED FROM 48. It was never the binding constraint — tripling it changed
  // nothing, because the candidate LISTS ran out first — so widening those (see
  // candidateSpots: a fan now gets a grid x four headings instead of two spots
  // facing one way) needs a budget that can actually spend them. Screening is
  // ~25 ms a shot, so this is a few seconds at worst, behind a spinner, on a
  // button the participant pressed deliberately.
  // 180 was the quality peak when a cooling task had two strategies; allowing the
  // fan to be left OFF doubled that to four, which halved what each one could
  // spend on placement. 260 restores it.
  // The screen's job is to NOMINATE, not to choose — the shortlist is re-ranked
  // at MID before anything is picked, so this only has to be wide enough that
  // the good layouts are somewhere in its top nine. 300 keeps every task over a
  // hundred distinct arrangements (the bathroom, whose one movable grille has
  // the narrowest candidate list, is the binding case) without paying for
  // precision the next rung supplies more cheaply.
  const budget = { left: opts.screenBudget ?? 300 };
  const strategies = strategiesFor(goal, opts.lockPower === true, opts.allowedDevices, { plan, targetIds, movable: opts.movableDevices });

  // Split the screening budget EVENLY across strategies. A single shared
  // counter let the first strategy consume everything and left the rest with no
  // placement search at all, so they were compared unfairly.
  const perStrategy = Math.max(4, Math.floor(budget.left / strategies.length));

  const screened: Array<{ strategy: Strategy; plan: FloorPlan; score: number; changes: string[] }> = [];
  const altsByStrategy = new Map<string, { base: FloorPlan; alts: PrimaryAlt[] }>();
  for (const st of strategies) {
    const base = withOpenings(withDevices(plan, st.devices), st.interiorDoors, st.openWindowIds);
    const slice = { left: perStrategy };
    const fid = dryingTask ? SCREEN_DRY : SCREEN;
    const { plan: placed, changes, primaryAlts } = placeDevices(base, goal, targetIds, opts.outdoorTemp, slice, opts.allowedDevices, dryingTask, opts.flow, opts.taskZones, opts.movableDevices);
    // …and then, if the task allows it, where the GLAZING goes. Done after the
    // devices rather than as another strategy dimension: window position times
    // open/shut times power would multiply the strategy count past the point
    // where any of them get a placement search worth the name, and in practice
    // a person settles the extract first and then asks where the window should
    // be relative to it.
    let best = { plan: placed, changes, score: evaluate(placed, goal, targetIds, opts.outdoorTemp, fid, dryingTask, opts.taskZones).score };
    if (opts.moveOpenings) {
      // WHERE THE GLAZING GOES AND WHERE THE GRILLE GOES ARE ONE QUESTION, not
      // two in sequence. This used to sweep window positions against the single
      // best device placement, so the pairs it could reach were (best vent x
      // every window) — and on the bathroom, whose only movable thing IS the
      // vent, that capped the whole search at ~54 distinct arrangements where
      // the other three tasks reach 250. Sweeping the windows against the top
      // few vent spots as well explores the combinations, which is what the
      // task actually asks about: the two are too close together or they are
      // not, and that is a fact about the PAIR.
      const bases = [best.plan, ...primaryAlts.slice(1, 5).map((alt) => ({
        ...placed,
        items: placed.items.map((it) =>
          it.type === primaryFor(goal, plan, opts.allowedDevices) && it.on !== false
            ? { ...it, position: alt.pos, rotationY: alt.rot, roomId: alt.roomId }
            : it,
        ),
      }))];
      for (const base of bases) {
        for (const win of base.windows) {
          if (win.fixed || win.locked) continue;
          for (const spot of windowPlacements(base, win)) {
            if (spot.a[0] === win.a[0] && spot.a[1] === win.a[1]) continue;
            const trial = withOpeningMoved(base, { ...spot, open: win.open });
            const { score } = evaluate(trial, goal, targetIds, opts.outdoorTemp, fid, dryingTask, opts.taskZones);
            if (score > best.score) {
              best = {
                plan: trial,
                changes: [...changes, `Window → ${windowSideName(trial, spot)}`],
                score,
              };
            }
          }
        }
      }
    }
    screened.push({ strategy: st, plan: best.plan, score: best.score, changes: best.changes });
    altsByStrategy.set(st.id, { base: best.plan, alts: primaryAlts });
  }

  // WHEN THERE IS ONLY ONE STRATEGY, THE ALTERNATIVES ARE PLACEMENTS. A task
  // that pins the power, locks the windows and bolts the primary device to one
  // room leaves exactly one strategy — and a gallery built from strategies then
  // has one card in it, on the task where "where should this go?" IS the whole
  // question. So the runner-up spots for the primary device become options in
  // their own right, each a complete plan the participant can apply and compare.
  if (screened.length < want) {
    const top = screened[0];
    const bank = top ? altsByStrategy.get(top.strategy.id) : undefined;
    const primaryType = primaryFor(goal, plan, opts.allowedDevices);
    for (const alt of bank?.alts.slice(1) ?? []) {
      if (screened.length >= Math.max(want, 3)) break;
      const variant: FloorPlan = {
        ...bank!.base,
        items: bank!.base.items.map((it) =>
          it.type === primaryType && it.on !== false
            ? { ...it, position: alt.pos, rotationY: alt.rot, roomId: alt.roomId }
            : it,
        ),
      };
      // An aim-only primary has ONE position and many headings, so naming the
      // card after the spot gives every alternative the same title and, worse,
      // describes a move that is not on offer — "AC against the right-hand
      // wall" is where it has always been bolted.
      const aimOnlyPrimary =
        opts.movableDevices !== undefined && !opts.movableDevices.includes(primaryType);
      const where = aimOnlyPrimary ? `aimed ${headingName(alt.rot)}` : spotName(plan, alt.roomId, alt.pos);
      screened.push({
        strategy: {
          ...top!.strategy,
          id: `${top!.strategy.id}-alt${screened.length}`,
          label: `${DEVICE_LABEL[primaryType] ?? primaryType} ${where}`,
          // The note stays the STRATEGY's — which doors and windows this option
          // wants — because the placement is now spelled out by movedLines,
          // computed per card. It used to be overwritten with the spot name to
          // stop three identical notes crowding out the one line that differed;
          // now the differing lines are generated, so the note can go back to
          // carrying the thing none of them say.
        },
        plan: variant,
        score: alt.score,
        // The alternatives are built on the winner's PLAN, window move and all,
        // so they have to inherit its change lines too. Dropping them meant a
        // card that relocates the glazing said nothing about the glazing, and
        // the participant only found out by applying it.
        changes: [...top!.changes],
      });
    }
  }

  // Re-score the finalists at display fidelity, so the numbers we SHOW are the
  // numbers the Temp view will show. Screening ranks; the final pass reports.
  screened.sort((a, b) => b.score - a.score);
  // SHORTLIST WIDE, THEN RE-RANK ACCURATELY. Taking the screen's top three
  // straight to the final pass trusted a 0.77 correlation to make the choice;
  // the shortlist is now twelve and they are re-scored at MID (0.99) before
  // anything is picked. See MID.
  const shortlist = screened.slice(0, Math.max(want * 3, 9));
  const midFid = dryingTask ? MID_DRY : MID;
  for (const f of shortlist) {
    f.score = evaluate(f.plan, goal, targetIds, opts.outdoorTemp, midFid, dryingTask, opts.taskZones).score;
  }
  shortlist.sort((a, b) => b.score - a.score);
  const finalists = shortlist.slice(0, Math.max(want, 3));
  // POLISH THE ONES WE ARE ABOUT TO SHOW. Each is a grid point, and the grid is
  // a sample of a continuous space; a couple of hundred milliseconds of walking
  // downhill from it is worth more than the same time spent screening more grid.
  //
  // The walk itself stays on the cheap screen — it is dozens of evaluations and
  // running them at MID cost five seconds for a step that is usually right
  // anyway. What it cannot be trusted about is whether it ARRIVED somewhere
  // better, because a hill-climb on a noisy signal will happily climb the
  // noise. So every refinement is checked once at MID against where it started,
  // and thrown away if it does not hold up: one accurate evaluation per
  // finalist buys back the accuracy the cheap walk gives away.
  const polish = { left: opts.refineBudget ?? 60 };
  for (const f of finalists) {
    const { plan: better, improved } = refine(
      f.plan, goal, targetIds, opts.outdoorTemp, dryingTask ? SCREEN_DRY : SCREEN,
      dryingTask, opts.taskZones ?? [], opts.movableDevices, opts.allowedDevices, polish,
    );
    if (!improved) continue;
    const checked = evaluate(better, goal, targetIds, opts.outdoorTemp, midFid, dryingTask, opts.taskZones).score;
    if (checked > f.score) {
      f.plan = better;
      f.score = checked;
    }
  }
  finalists.sort((a, b) => b.score - a.score);
  const solutions: Solution[] = finalists.map((f) => {
    const { metrics, score } = evaluate(f.plan, goal, targetIds, opts.outdoorTemp, FINAL, dryingTask, opts.taskZones);
    // WHAT THIS CARD ACTUALLY DOES, read off the plan rather than inherited.
    // The alternatives are built on the winner's plan and were carrying the
    // winner's change lines, so a card that moved the heater somewhere else
    // still described the winner's heater — and a card that moved the fan as
    // well never mentioned the fan at all. On the winter task that reads as
    // "the tool thinks the fan does not matter", which is the opposite of the
    // lesson.
    const detail = [f.strategy.note, ...movedLines(plan, f.plan), ...f.changes.filter((c) => c.startsWith("Window"))];
    return {
      id: f.strategy.id,
      readout: dryingTask ? "drying" : goal === "ventilate" || goal === "circulate" ? "freshness" : "temperature",
      label: f.strategy.label,
      detail,
      plan: f.plan,
      metrics,
      score,
    };
  });
  solutions.sort((a, b) => b.score - a.score);

  // Drop options that are indistinguishable from a better one — a gallery of
  // near-identical choices is worse than one answer.
  // WHEN THE AIM IS THE QUESTION, THE AIM IS THE DIFFERENCE. The similarity test
  // below asks whether two options produce a different ROOM — mean temperature,
  // mean air speed — and for a bolted-down device that is precisely the wrong
  // question: this task exists because an AC's aim barely moves the room mean
  // (0.5 °C across every layout tried) while completely changing where the cold
  // goes and who is sleeping in the draught. Every alternative aim therefore
  // looked like a duplicate of the first and the gallery collapsed to one card,
  // on the one task where the gallery is a list of aims.
  const primaryType = primaryFor(goal, plan, opts.allowedDevices);
  const aimIsTheAnswer =
    opts.movableDevices !== undefined && !opts.movableDevices.includes(primaryType);
  const aimOf = (p: FloorPlan) => p.items.find((i) => i.type === primaryType)?.rotationY ?? 0;
  const kept: Solution[] = [];
  for (const s of solutions) {
    const dup = aimIsTheAnswer
      ? kept.some(
          (k) => Math.abs(Math.atan2(Math.sin(aimOf(k.plan) - aimOf(s.plan)), Math.cos(aimOf(k.plan) - aimOf(s.plan)))) < ALT_MIN_TURN,
        )
      : kept.some((k) =>
      dryingTask
        ? Math.abs(
            Math.max(...[...k.metrics.roomDryMin.values()]) - Math.max(...[...s.metrics.roomDryMin.values()]),
          ) < 4
        : Math.abs(k.metrics.meanTargetC - s.metrics.meanTargetC) < 0.25 &&
          Math.abs(k.metrics.houseMeanSpeed - s.metrics.houseMeanSpeed) < 0.02,
    );
    if (!dup) kept.push(s);
    if (kept.length >= want) break;
  }

  // TWO CARDS MAY NOT SHARE A HEADING. The opening-relative spot names are the
  // ones people actually use — "beside the doorway" beats "at (2.4, 0.9)" — but
  // they describe a 1.2 m radius, so in a small room two spots that are metres
  // apart in effect can land on the same words. The bathroom task produced
  // exactly that: two "return beside the doorway" cards, 35 and 71 minutes of
  // drying, indistinguishable until you applied one. Where that happens the
  // wall the device is against is appended, which is the next thing you would
  // say pointing at it.
  const byLabel = new Map<string, Solution[]>();
  for (const s of kept) byLabel.set(s.label, [...(byLabel.get(s.label) ?? []), s]);
  for (const [, group] of byLabel) {
    if (group.length < 2) continue;
    for (const s of group) {
      const it = s.plan.items.find((i) => i.type === primaryType && i.on !== false);
      const room = it ? s.plan.rooms.find((r) => r.id === it.roomId) : null;
      if (!it || !room) continue;
      const side = wallSideName(room.rect, it.position);
      // The wall name is the first tie-breaker, but two spots can share that
      // too — "out in the middle of the room" covers the whole middle, so two
      // mid-room fan placements collided on it as well. Fall back to the
      // quadrant, which two distinguishable spots cannot both be in.
      const q = quadrantName(room.rect, it.position);
      const add = !s.label.includes(side) ? side : !s.label.includes(q) ? q : null;
      if (add) s.label = `${s.label}, ${add}`;
    }
  }
  return kept.length ? kept : solutions.slice(0, 1);
}

/** Devices this goal will touch, for the review text. */
export function goalDevices(goal: OptimizeGoal): string[] {
  return GOAL_DEVICES[goal];
}

/**
 * Never hand back a finished task.
 *
 * A suggestion that satisfies every goal at once turns the tool into a button
 * you press to win: the participant learns that asking works, and nothing about
 * why the answer is the answer. The study wants to watch them converge over
 * several turns — ask, look at what changed, ask again — so any option that
 * completes the task is withheld.
 *
 * What is offered instead has to be real PROGRESS, though, or the feature is
 * just broken. Withholding naively left the winter task offering "shut the
 * interior doors", which passes the living room and drops the bedroom to the
 * outdoor 2 °C — fewer goals met than doing nothing at all. So the survivors
 * are ranked by how many goals they actually meet, and the best complete option
 * is also offered in cut-down form: its primary device's move only (the heater
 * for warming, the AC for cooling), with everything else back where the user
 * had it. That is the strongest honest half-step — the right heater spot, the
 * fan still to work out.
 *
 * Outside a study task there are no goals to complete and nothing is withheld.
 */
export function withholdComplete(
  options: Solution[],
  metCount: (plan: FloorPlan) => { met: number; total: number },
  goal: OptimizeGoal,
  current: FloorPlan,
  targetIds: string[],
  outdoorTemp: number,
  want = 3,
  /** The same hard limit findSolutions was given. Without it the half-step
   *  option resolved its own primary device from scratch and could name one the
   *  task forbids — see primaryFor. */
  allowedDevices?: string[],
): Solution[] {
  if (options.length === 0) return options;

  const primary = primaryFor(goal, current, allowedDevices);
  /** The same solution with only the primary device moved. Re-scored, not
   *  copied: the card prints the temperature the option will actually produce,
   *  and half the moves produce a different temperature from all of them. */
  const trim = (s: Solution): Solution => {
    const plan: FloorPlan = {
      ...s.plan,
      items: s.plan.items.map((it) =>
        it.type === primary ? it : current.items.find((o) => o.id === it.id) ?? it,
      ),
    };
    const { metrics, score } = evaluate(plan, goal, targetIds, outdoorTemp, FINAL, s.readout === "drying");
    return {
      ...s,
      id: `${s.id}-partial`,
      // ITS OWN LABEL, or the gallery shows two cards reading "Move the fan"
      // with no way to tell which is which — the strategy label describes the
      // strategy, and this option is deliberately only part of one.
      label: `${DEVICE_LABEL[primary] ?? primary} only — a first step`,
      plan,
      metrics,
      score,
      detail: [`Just the ${(DEVICE_LABEL[primary] ?? primary).toLowerCase()} moved — the rest is yours to work out`],
    };
  };

  /** The same solution with the OPENINGS kept and every device put back.
   *
   *  The other half-step keeps the primary device's move, which on a task whose
   *  only movable thing IS the primary device is the whole answer — so it
   *  completes the task, gets withheld with everything else, and the gallery
   *  comes back empty. That happened on the bathroom the moment its threshold
   *  became reachable: the search found a passing layout, every candidate was
   *  withheld, and "Find solutions" did nothing at all, which is worse than
   *  offering too much.
   *
   *  Opening the window without moving the grille is a real, honest half of
   *  that task — necessary, nowhere near sufficient — and it is the half-step
   *  for any task where the openings and the placement both matter. */
  const openingsOnly = (s: Solution): Solution => {
    const plan: FloorPlan = { ...s.plan, items: current.items };
    const { metrics, score } = evaluate(plan, goal, targetIds, outdoorTemp, FINAL, s.readout === "drying");
    return {
      ...s,
      id: `${s.id}-openings`,
      label: "The openings only — a first step",
      plan,
      metrics,
      score,
      detail: ["Doors and windows set; where things stand is yours to work out"],
    };
  };

  const keep = (list: Solution[]) => list.map((s) => ({ s, ...metCount(s.plan) })).filter((c) => c.total === 0 || c.met < c.total);
  let scored = keep(options);
  // THE ONE-DEVICE HALF-STEP IS A LAST RESORT TOO, and it was not: it was mixed
  // in with the full options and usually outscored them, so the winter task —
  // where the heater and the fan BOTH have to move, and the runner-up options
  // move both — led with a card that moved only the heater. Reading that, the
  // obvious inference is that the tool thinks the fan does not matter, which is
  // the opposite of the lesson. It earns its place only when every full option
  // finishes the job and is therefore withheld.
  if (scored.length === 0) scored = keep(options.slice(0, 1).map(trim));
  // ONLY WHEN THERE IS NOTHING LEFT. The openings-only step is a last resort,
  // not a standing extra card: adding it unconditionally changed what every
  // other task offers, and those were already the way they should be. It earns
  // its place exactly when the normal candidates all finish the job and are
  // therefore all withheld — which is the case that used to return an empty
  // gallery and look like a broken button.
  if (scored.length === 0) scored = keep(options.slice(0, 1).map(openingsOnly));
  if (scored.length === 0) return [];

  scored.sort((a, b) => b.met - a.met || b.s.score - a.s.score);
  const seen = new Set<string>();
  const out: Solution[] = [];
  for (const c of scored) {
    // Two options that produce the same home are one option. The half-steps can
    // collapse onto each other (or onto a full solution) whenever a task has
    // only one movable device, and three cards that apply the same change are
    // the "why did it suggest the same thing twice" complaint by another route.
    const key = layoutKey(c.s.plan);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c.s);
    if (out.length >= want) break;
  }
  return out;
}

/** Everything about a plan that a suggestion can change, as one comparable
 *  string: where each device sits, which way it points, whether it is running,
 *  and where each opening is and whether it is open.
 *
 *  Used for three things that are all the same complaint — "it keeps giving me
 *  the same answer": collapsing options that produce an identical home, dropping
 *  an option that is the home you already have, and remembering across a session
 *  which layouts have already been offered. The opening POSITION is in the key
 *  because the humidity task can move a window, so two options that differ only
 *  in where the glazing went are genuinely different advice. */
export function layoutKey(plan: FloorPlan): string {
  return JSON.stringify([
    plan.items
      .map((i) =>
        [
          i.id,
          i.position[0].toFixed(2),
          i.position[2].toFixed(2),
          i.rotationY.toFixed(2),
          i.on ?? true,
          i.power ?? 2,
        ].join(":"),
      )
      .sort(),
    [...plan.doors, ...plan.windows]
      .map((o) => [o.id, o.open, o.a[0].toFixed(2), o.a[1].toFixed(2), o.b[0].toFixed(2), o.b[1].toFixed(2)].join(":"))
      .sort(),
  ]);
}

export type { PlacedItem };
