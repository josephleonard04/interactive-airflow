import { findFreeSpot } from "../floorplan/collision";
import type { FloorPlan, Opening, PlacedItem, Vec3 } from "../floorplan/types";
import { REPORT_FIDELITY, buildSim3D, geodesicFields, roomMeans, slowestDry, zoneMean } from "../sim/sim3d";
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

/** Which side of the home a window is on, so an option can say WHICH one it
 *  wants open rather than just "a window". */
function sideOfWindow(plan: FloorPlan, w: Opening): string {
  const b = plan.bounds;
  const vertical = Math.abs(w.a[0] - w.b[0]) < 1e-3;
  if (vertical) return Math.abs(w.a[0] - b.x) < Math.abs(w.a[0] - (b.x + b.w)) ? "left-hand" : "right-hand";
  return Math.abs(w.a[1] - b.z) < Math.abs(w.a[1] - (b.z + b.d)) ? "far" : "near";
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
  const { x, z, w, d } = room.rect;
  const fx = (pos[0] - x) / w;
  const fz = (pos[2] - z) / d;
  const edge = Math.min(fx, 1 - fx, fz, 1 - fz);
  if (edge > 0.28) return "out in the middle of the room";
  const vert = Math.min(fz, 1 - fz) < Math.min(fx, 1 - fx);
  if (vert) return fz < 0.5 ? "against the far wall" : "against the near wall";
  return fx < 0.5 ? "against the left-hand wall" : "against the right-hand wall";
}

/** Air speed over a target room above which people notice a draught (m/s). */
const DRAFT_CAP = 0.35;
const DRAFT_PENALTY = 8;

export interface SolutionMetrics {
  /** Absolute °C per room. */
  roomTempC: Map<string, number>;
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

function measure(plan: FloorPlan, targetIds: string[], outdoorTemp: number, fid: typeof SCREEN): SolutionMetrics {
  const built = buildSim3D(plan, { targetCells: fid.targetCells, iterations: fid.iterations });
  for (let s = 0; s < fid.steps; s++) built.sim.step(0.05);
  const { sim, nx, ny, nz, ambient, inside, roomIndex, roomIds } = built;

  const { temp, smell, dry: dryF } = geodesicFields(built);
  const roomTempC = new Map<string, number>();
  for (const [id, d] of roomMeans(built, temp)) roomTempC.set(id, outdoorTemp + d);
  const roomDryMin = new Map<string, number>();
  for (const r of plan.rooms) roomDryMin.set(r.id, slowestDry(built, dryF, r.rect));
  const roomFresh = new Map<string, number>();
  // Against SMELL_FULL_SCALE, the same fixed reference the contamination view
  // normalises against — so a card saying "62% fresh" and the floor the user is
  // looking at cannot disagree about how bad it is.
  for (const [id, v] of roomMeans(built, smell)) {
    roomFresh.set(id, Math.max(0, Math.min(1, 1 - v / SMELL_FULL_SCALE)));
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
    roomFresh,
    roomDryMin,
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
  if (goal === "cool") {
    const worst = targetTemps.length ? Math.max(...targetTemps) : 0; // hottest room
    return -(worst + 0.25 * m.meanTargetC) - draft;
  }
  if (goal === "warm") {
    const worst = targetTemps.length ? Math.min(...targetTemps) : 0; // coldest room
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
): { metrics: SolutionMetrics; score: number } {
  const metrics = measure(plan, targetIds, outdoorTemp, fid);
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
  ctx?: { plan: FloorPlan; targetIds: string[] },
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
  const movedNames = (devices: Strategy["devices"]): string => {
    const names = Object.keys(devices)
      .filter((t) => !allowed || allowed.includes(t))
      .map((t) => (DEVICE_LABEL[t] ?? t).toLowerCase());
    if (names.length === 0) return "the openings";
    if (names.length === 1) return `the ${names[0]}`;
    return `the ${names.slice(0, -1).join(", the ")} and the ${names[names.length - 1]}`;
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
    for (const power of lockPower ? [2] : [2, 3]) {
      for (const doorsOpen of doorStates) {
        const devices = only({
          [dev]: { on: true, power },
          [other]: { on: false },
          // Locked tasks keep the fan on medium too — it is a device dial like
          // any other, and dropping it to low is a change the user cannot make.
          fan: { on: true, power: lockPower ? 2 : doorsOpen ? 2 : 1, oscillate: true },
        });
        add({
          id: `${dev}${power}-${doorsOpen ? "doors" : "shut"}`,
          // With the dial locked the only thing that varies is placement, so the
          // label must describe THAT rather than a power the user can't set.
          label: lockPower
            ? `Move ${movedNames(devices)}`
            : `${DEVICE_LABEL[dev] ?? dev} on ${power === 3 ? "high" : "medium"}`,
          devices,
          interiorDoors: doorsOpen,
          openWindowIds: [],
          note: [
            doorsOpen ? "interior doors open so the air reaches every room" : "interior doors shut to concentrate it",
            "windows shut to keep the outdoor air out",
          ].join(", "),
        });
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
          lockPower ? `Move ${movedNames(devices)}` : `Air movers on ${power === 3 ? "high" : "medium"}`,
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
      for (const room of rooms) {
        const spots = candidateSpots(room, it.type, working.wallHeight, openings);
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
          const pos = findFreeSpot(
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
          const placed: Vec3 = wallBound
            ? cand.axis === "x"
              ? [pos[0], cand.position[1], cand.position[2]]
              : [cand.position[0], cand.position[1], pos[2]]
            : [pos[0], cand.position[1], pos[2]];
          const trial: FloorPlan = {
            ...working,
            items: working.items.map((o) =>
              o.id === it.id
                ? { ...o, position: placed, rotationY: cand.rotationY, roomId: cand.roomId, ...(cand.oscillate !== undefined ? { oscillate: cand.oscillate } : {}) }
                : o,
            ),
          };
          budget.left--;
          const { score } = evaluate(trial, goal, targetIds, outdoorTemp, drying ? SCREEN_DRY : SCREEN, drying);
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
      if (moved && sweep === 1) changes.push(`${DEVICE_LABEL[it.type] ?? it.type} → ${best.roomName}`);
    }
  }
  // Best first, and only spots that are meaningfully APART — two candidates
  // 20 cm from each other are the same advice twice, which is exactly what the
  // gallery was accused of showing.
  primaryAlts.sort((a, b) => b.score - a.score);
  const spread: PrimaryAlt[] = [];
  for (const a of primaryAlts) {
    if (spread.some((k) => Math.hypot(k.pos[0] - a.pos[0], k.pos[2] - a.pos[2]) < ALT_MIN_APART)) continue;
    spread.push(a);
    if (spread.length >= 6) break;
  }
  primaryAlts = spread;
  return { plan: working, changes, primaryAlts };
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
  const budget = { left: opts.screenBudget ?? 48 };
  const strategies = strategiesFor(goal, opts.lockPower === true, opts.allowedDevices, { plan, targetIds });

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
    const { plan: placed, changes, primaryAlts } = placeDevices(base, goal, targetIds, opts.outdoorTemp, slice, opts.allowedDevices, dryingTask, opts.flow);
    // …and then, if the task allows it, where the GLAZING goes. Done after the
    // devices rather than as another strategy dimension: window position times
    // open/shut times power would multiply the strategy count past the point
    // where any of them get a placement search worth the name, and in practice
    // a person settles the extract first and then asks where the window should
    // be relative to it.
    let best = { plan: placed, changes, score: evaluate(placed, goal, targetIds, opts.outdoorTemp, fid, dryingTask).score };
    if (opts.moveOpenings) {
      for (const win of placed.windows) {
        if (win.fixed || win.locked) continue;
        for (const spot of windowPlacements(placed, win)) {
          if (spot.a[0] === win.a[0] && spot.a[1] === win.a[1]) continue;
          const trial = withOpeningMoved(best.plan, { ...spot, open: win.open });
          const { score } = evaluate(trial, goal, targetIds, opts.outdoorTemp, fid, dryingTask);
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
      const where = spotName(plan, alt.roomId, alt.pos);
      screened.push({
        strategy: {
          ...top!.strategy,
          id: `${top!.strategy.id}-alt${screened.length}`,
          label: `${DEVICE_LABEL[primaryType] ?? primaryType} ${where}`,
          // The strategy note is identical on every one of these — same doors,
          // same windows — so repeating it three times just pushes the one line
          // that differs off the bottom of the card.
          note: `In ${alt.roomName}, ${where}`,
        },
        plan: variant,
        score: alt.score,
        changes: [],
      });
    }
  }

  // Re-score the finalists at display fidelity, so the numbers we SHOW are the
  // numbers the Temp view will show. Screening ranks; the final pass reports.
  screened.sort((a, b) => b.score - a.score);
  // The final pass is ~305 ms each, so carry only as many finalists as we will
  // actually show. (The screening validation says the true winner is inside the
  // screen's top 4, which this covers for want<=3.)
  const finalists = screened.slice(0, Math.max(want, 3));
  const solutions: Solution[] = finalists.map((f) => {
    const { metrics, score } = evaluate(f.plan, goal, targetIds, opts.outdoorTemp, FINAL, dryingTask);
    const detail = [f.strategy.note, ...f.changes];
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
  const kept: Solution[] = [];
  for (const s of solutions) {
    const dup = kept.some((k) =>
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

  const candidates = [...options, ...options.slice(0, 1).map(trim)];
  const keep = (list: Solution[]) => list.map((s) => ({ s, ...metCount(s.plan) })).filter((c) => c.total === 0 || c.met < c.total);
  let scored = keep(candidates);
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
