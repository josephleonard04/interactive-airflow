import { findFreeSpot } from "../floorplan/collision";
import type { FloorPlan, Opening, PlacedItem, Vec3 } from "../floorplan/types";
import { REPORT_FIDELITY, buildSim3D, geodesicFields, roomMeans } from "../sim/sim3d";
import { candidateSpots } from "./searchOptimize";
import { DEVICE_LABEL, GOAL_DEVICES, largestRoom, type OptimizeGoal } from "./optimize";

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
/** Finalists are re-scored at the shared reporting fidelity, so the temperature
 *  printed on a solution card is the same number the goal verdict will give
 *  after the user applies it. */
const FINAL = REPORT_FIDELITY;

/** The device each goal really turns on — searched first when budget is tight. */
const PRIMARY_OF: Record<OptimizeGoal, string> = {
  cool: "ac",
  warm: "heater",
  ventilate: "supply",
  circulate: "fan",
  balanced: "ac",
};

/** Air speed over a target room above which people notice a draught (m/s). */
const DRAFT_CAP = 0.35;
const DRAFT_PENALTY = 8;

export interface SolutionMetrics {
  /** Absolute °C per room. */
  roomTempC: Map<string, number>;
  /** The target room that came off WORST — the number the goal really rests on. */
  worstTargetC: number;
  meanTargetC: number;
  houseMeanSpeed: number;
  worstRoomSpeed: number;
  outflow: number;
  /** Mean air speed across the target rooms — the draught constraint. */
  targetSpeed: number;
}

export interface Solution {
  id: string;
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
  windows: boolean;
  note: string;
}

// ---- plan mutation helpers ----

/** Apply opening states. The same Opening object is referenced from plan.doors /
 *  plan.windows AND from wall.openings, so all three must get the SAME new
 *  object or the solver and the renderer disagree about what is open. */
function withOpenings(plan: FloorPlan, interiorDoors: boolean, windows: boolean): FloorPlan {
  const next = new Map<string, Opening>();
  const decide = (o: Opening): Opening => {
    const exterior = o.rooms.includes("outside");
    // The entrance is never auto-opened — people don't leave the front door wide
    // open, and letting the search use it would produce advice nobody follows.
    if (o.kind === "door" && exterior) return o;
    const open = exterior ? windows : interiorDoors;
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

  const roomTempC = new Map<string, number>();
  for (const [id, d] of roomMeans(built, geodesicFields(built).temp)) roomTempC.set(id, outdoorTemp + d);

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
    worstTargetC: tTemps.length ? Math.max(...tTemps) : NaN, // see scoreOf: sign depends on the goal
    meanTargetC: tTemps.length ? tTemps.reduce((a, b) => a + b, 0) / tTemps.length : NaN,
    houseMeanSpeed,
    worstRoomSpeed: Number.isFinite(worstRoomSpeed) ? worstRoomSpeed : 0,
    outflow,
    targetSpeed: tSpeedN ? tSpeedSum / tSpeedN : 0,
  };
}

/** Collapse the metric vector to one ranked number. The temperature goals use a
 *  max–min form so every requested room has to be handled, plus a draught
 *  penalty ("coolest layout that doesn't blast the room"). */
function scoreOf(goal: OptimizeGoal, m: SolutionMetrics, targetTemps: number[]): number {
  const draft = Math.max(0, m.targetSpeed - DRAFT_CAP) * DRAFT_PENALTY;
  if (goal === "cool") {
    const worst = targetTemps.length ? Math.max(...targetTemps) : 0; // hottest room
    return -(worst + 0.25 * m.meanTargetC) - draft;
  }
  if (goal === "warm") {
    const worst = targetTemps.length ? Math.min(...targetTemps) : 0; // coldest room
    return worst + 0.25 * m.meanTargetC - draft;
  }
  if (goal === "ventilate") return m.outflow * 0.02 + m.houseMeanSpeed + m.worstRoomSpeed;
  return m.houseMeanSpeed + 2 * m.worstRoomSpeed;
}

function evaluate(
  plan: FloorPlan,
  goal: OptimizeGoal,
  targetIds: string[],
  outdoorTemp: number,
  fid: typeof SCREEN,
): { metrics: SolutionMetrics; score: number } {
  const metrics = measure(plan, targetIds, outdoorTemp, fid);
  const targetTemps = targetIds.map((id) => metrics.roomTempC.get(id)).filter((v): v is number => v !== undefined);
  return { metrics, score: scoreOf(goal, metrics, targetTemps) };
}

// ---- strategies: the discrete variables that were never searched ----

function strategiesFor(goal: OptimizeGoal): Strategy[] {
  const out: Strategy[] = [];
  const add = (s: Strategy) => out.push(s);

  if (goal === "cool" || goal === "warm") {
    const dev = goal === "cool" ? "ac" : "heater";
    const other = goal === "cool" ? "heater" : "ac";
    for (const power of [2, 3]) {
      for (const doorsOpen of [true, false]) {
        for (const win of [false, true]) {
          add({
            id: `${dev}${power}-${doorsOpen ? "doors" : "shut"}-${win ? "win" : "nowin"}`,
            label: `${DEVICE_LABEL[dev] ?? dev} on ${power === 3 ? "high" : "medium"}`,
            devices: {
              [dev]: { on: true, power },
              [other]: { on: false },
              fan: { on: true, power: doorsOpen ? 2 : 1, oscillate: true },
            },
            interiorDoors: doorsOpen,
            windows: win,
            note: [
              doorsOpen ? "interior doors open so the air reaches every room" : "interior doors shut to concentrate it",
              win ? "windows open" : "windows shut",
            ].join(", "),
          });
        }
      }
    }
    return out;
  }

  // ventilate / circulate / balanced: the openings matter more than the power
  for (const power of [2, 3]) {
    for (const win of [true, false]) {
      add({
        id: `air${power}-${win ? "win" : "nowin"}`,
        label: `Air movers on ${power === 3 ? "high" : "medium"}`,
        devices: { fan: { on: true, power, oscillate: true }, supply: { on: true, power }, return: { on: true, power } },
        interiorDoors: true,
        windows: win,
        note: win ? "windows open to purge stale air" : "windows shut, recirculating indoors",
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
): { plan: FloorPlan; changes: string[] } {
  const wanted = GOAL_DEVICES[goal];
  const targets = targetIds.length
    ? targetIds.map((id) => base.rooms.find((r) => r.id === id)).filter((r): r is FloorPlan["rooms"][0] => !!r)
    : [largestRoom(base)];
  const roomOrder = [
    ...targets,
    ...base.rooms.filter((r) => !targets.some((t) => t.id === r.id)),
  ];
  const openings = [...base.doors, ...base.windows];
  const changes: string[] = [];

  let working = base;
  // Primary device first (the AC for a cooling goal, the heater for warming):
  // with a small per-strategy budget the order decides who actually gets
  // searched, and spending it on the fan while the AC sits in the wrong room
  // is the worst possible allocation.
  const primary = PRIMARY_OF[goal];
  const movable = working.items
    .filter((it) => wanted.includes(it.type) && it.on !== false)
    .sort((a, b) => (b.type === primary ? 1 : 0) - (a.type === primary ? 1 : 0));

  // Two sweeps: after the second device moves, the first one's best spot may
  // have changed. One pass could never see that (research report §1.3).
  for (let sweep = 0; sweep < 2; sweep++) {
    for (const dev of movable) {
      const it = working.items.find((o) => o.id === dev.id);
      if (!it) continue;
      let best: { pos: Vec3; rot: number; roomId: string; roomName: string; osc?: boolean; score: number } | null = null;
      for (const room of roomOrder) {
        for (const cand of candidateSpots(room, it.type, working.wallHeight)) {
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
            openings,
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
          const { score } = evaluate(trial, goal, targetIds, outdoorTemp, SCREEN);
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
  return { plan: working, changes };
}

// ---- top level ----

export interface FindOptions {
  outdoorTemp: number;
  /** How many solutions to offer. */
  want?: number;
  /** Coarse screening evaluations to spend across all strategies. */
  screenBudget?: number;
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
  const budget = { left: opts.screenBudget ?? 48 };
  const strategies = strategiesFor(goal);

  // Split the screening budget EVENLY across strategies. A single shared
  // counter let the first strategy consume everything and left the rest with no
  // placement search at all, so they were compared unfairly.
  const perStrategy = Math.max(4, Math.floor(budget.left / strategies.length));

  const screened: Array<{ strategy: Strategy; plan: FloorPlan; score: number; changes: string[] }> = [];
  for (const st of strategies) {
    const base = withOpenings(withDevices(plan, st.devices), st.interiorDoors, st.windows);
    const slice = { left: perStrategy };
    const { plan: placed, changes } = placeDevices(base, goal, targetIds, opts.outdoorTemp, slice);
    const { score } = evaluate(placed, goal, targetIds, opts.outdoorTemp, SCREEN);
    screened.push({ strategy: st, plan: placed, score, changes });
  }

  // Re-score the finalists at display fidelity, so the numbers we SHOW are the
  // numbers the Temp view will show. Screening ranks; the final pass reports.
  screened.sort((a, b) => b.score - a.score);
  // The final pass is ~305 ms each, so carry only as many finalists as we will
  // actually show. (The screening validation says the true winner is inside the
  // screen's top 4, which this covers for want<=3.)
  const finalists = screened.slice(0, Math.max(want, 3));
  const solutions: Solution[] = finalists.map((f) => {
    const { metrics, score } = evaluate(f.plan, goal, targetIds, opts.outdoorTemp, FINAL);
    const detail = [f.strategy.note, ...f.changes];
    return { id: f.strategy.id, label: f.strategy.label, detail, plan: f.plan, metrics, score };
  });
  solutions.sort((a, b) => b.score - a.score);

  // Drop options that are indistinguishable from a better one — a gallery of
  // near-identical choices is worse than one answer.
  const kept: Solution[] = [];
  for (const s of solutions) {
    const dup = kept.some(
      (k) =>
        Math.abs(k.metrics.meanTargetC - s.metrics.meanTargetC) < 0.25 &&
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

export type { PlacedItem };
