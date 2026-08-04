import { buildSim3D, advectDiffuseFill } from "../sim/sim3d";
import { findFreeSpot, type SearchAxis } from "../floorplan/collision";
import type { FloorPlan, Opening, PlacedItem, Rect, Vec3 } from "../floorplan/types";
import { DEVICE_LABEL, GOAL_DEVICES, largestRoom, type OptimizeGoal } from "./optimize";
import { ventMountY } from "../floorplan/catalog";

// Layout-adaptive optimization: instead of fixed spots, we SEARCH. For each
// goal-relevant device we generate candidate placements from the user's actual
// floor plan (each room's walls / ceiling / centre, collision- and
// doorway-free), then score complete configurations by running the real Euler
// solver on a coarse grid and measuring the goal:
//   cool/warm      -> mean temperature in the target room (advected fill)
//   ventilate      -> outflow at open exterior openings + house air movement
//   circulate/bal. -> house-wide air movement + per-room uniformity
// A greedy pass places one device at a time, keeping the best-scoring spot
// given everything placed so far. Budgeted to stay interactive (~a few sec).

export interface SearchBudget {
  targetCells: number;
  iterations: number;
  steps: number;
  fillIters: number;
  maxEvals: number;
}

const DEFAULT_BUDGET: SearchBudget = {
  targetCells: 4200,
  iterations: 8,
  steps: 22,
  fillIters: 40,
  maxEvals: 22,
};

export interface SearchResult {
  items: PlacedItem[];
  changes: string[];
  evals: number;
  targetName: string;
}

export interface Candidate {
  position: Vec3;
  rotationY: number;
  roomId: string;
  roomName: string;
  /** Collision-dodge direction: wall devices slide along their wall line only. */
  axis: SearchAxis;
  /** Fan sweep mode this candidate evaluates (fans only). */
  oscillate?: boolean;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Candidate spots for a device type in one room: each wall + the centre,
 *  facing into the room — derived from the room's actual geometry. Wall
 *  devices carry the axis of THEIR wall so they can only slide along it. */
export function candidateSpots(
  room: { id: string; name: string; rect: Rect },
  type: string,
  wallHeight: number,
  /** The home's openings — doors and windows. Two candidates are derived from
   *  them, because a bare list of wall midpoints cannot express either one:
   *
   *  A HEATER gets a spot directly under each of this room's exterior windows —
   *  the place a century of radiator practice says is right, and the only one
   *  that kills the cold downdraught off the glass. The living-room window in
   *  the winter task sits at 80% along its wall, so "under the window" was not
   *  in the candidate set at all and the search could never propose it.
   *
   *  A FAN gets a spot behind each interior doorway, aimed through it. */
  openings: Opening[] = [],
): Candidate[] {
  const { x, z, w, d } = room.rect;
  const cx = x + w / 2;
  const cz = z + d / 2;
  const out: Candidate[] = [];
  const mk = (px: number, py: number, pz: number, rot: number, axis: SearchAxis, oscillate?: boolean) =>
    out.push({ position: [px, py, pz] as Vec3, rotationY: rot, roomId: room.id, roomName: room.name, axis, oscillate });

  if (type === "ac") {
    const y = clamp(1.9, 0.6, wallHeight - 0.4);
    mk(cx, y, z + d - 0.14, Math.PI, "x"); // north wall, blows -z
    mk(cx, y, z + 0.14, 0, "x"); // south wall, blows +z
    mk(x + 0.14, y, cz, Math.PI / 2, "z"); // west wall, blows +x
    mk(x + w - 0.14, y, cz, -Math.PI / 2, "z"); // east wall, blows -x
  } else if (type === "heater") {
    // Wall midpoints AND thirds. A radiator goes against a wall, but "against
    // the far wall" is a three-metre run in these rooms and the midpoint is not
    // always the best metre of it — the winter task's answer depends on which
    // end of the living room the heat starts from, and only the midpoint was
    // ever tried.
    for (const f of [0.28, 0.5, 0.72]) {
      mk(x + 0.2, 0.25, z + d * f, Math.PI / 2, "z");
      mk(x + w - 0.2, 0.25, z + d * f, -Math.PI / 2, "z");
      mk(x + w * f, 0.25, z + 0.2, 0, "x");
      mk(x + w * f, 0.25, z + d - 0.2, Math.PI, "x");
    }
    for (const o of openings) {
      if (o.kind !== "window" || !o.rooms.includes(room.id) || !o.rooms.includes("outside")) continue;
      const vertical = Math.abs(o.a[0] - o.b[0]) < 1e-3; // window runs along z
      const mid = vertical ? (o.a[1] + o.b[1]) / 2 : (o.a[0] + o.b[0]) / 2;
      const line = vertical ? o.a[0] : o.a[1];
      if (vertical) {
        const west = Math.abs(line - x) < Math.abs(line - (x + w));
        mk(west ? x + 0.2 : x + w - 0.2, 0.25, clamp(mid, z + 0.4, z + d - 0.4), west ? Math.PI / 2 : -Math.PI / 2, "z");
      } else {
        const south = Math.abs(line - z) < Math.abs(line - (z + d));
        mk(clamp(mid, x + 0.4, x + w - 0.4), 0.25, south ? z + 0.2 : z + d - 0.2, south ? 0 : Math.PI, "x");
      }
    }
  } else if (type === "return") {
    // AN EXTRACT GOES ON A WALL, JUST UNDER THE CEILING — nowhere else.
    //
    // There was no branch for it at all, so it fell through to the fan's and
    // the search proposed standing a wall-mounted grille in the middle of the
    // floor. On the bathroom task, where the extract is the only thing the
    // participant may move, that made "find solutions" produce a suggestion
    // that could not be carried out and did not help: the option card said
    // "Move the vent", the vent went to the centre of the room, and the drying
    // time barely shifted.
    //
    // Eight spots: the four wall midpoints and the four corners, which is the
    // set a person dragging it would actually consider — and, crucially, the
    // corner diagonally opposite the window, which is this task's answer and
    // was not previously reachable.
    const y = ventMountY(wallHeight);
    const m = 0.09;
    const cornerIn = 0.55;
    // midpoints
    mk(cx, y, z + m, 0, "x");
    mk(cx, y, z + d - m, Math.PI, "x");
    mk(x + m, y, cz, Math.PI / 2, "z");
    mk(x + w - m, y, cz, -Math.PI / 2, "z");
    // corners, sitting on the long wall a little in from each end
    mk(x + cornerIn, y, z + m, 0, "x");
    mk(x + w - cornerIn, y, z + m, 0, "x");
    mk(x + cornerIn, y, z + d - m, Math.PI, "x");
    mk(x + w - cornerIn, y, z + d - m, Math.PI, "x");
  } else if (type === "supply") {
    mk(cx, wallHeight - 0.1, cz, 0, "area");
    mk(x + w * 0.3, wallHeight - 0.1, z + d * 0.3, 0, "area");
    mk(x + w * 0.7, wallHeight - 0.1, z + d * 0.7, 0, "area");
  } else {
    // FAN: A GRID OF SPOTS x FOUR HEADINGS. It used to be two spots, both facing
    // +z whatever the room was doing, plus the doorway pair below — so the one
    // variable that decides what a fan does was not searched at all. Sweeping
    // the studio by hand shows why that mattered: over the bed, air speed runs
    // from 0.09 to 1.37 m/s across fan positions and headings, and the search
    // was choosing from four points in that space, all at one heading.
    //
    // 3x3 interior grid x 4 cardinal headings = 36, plus a swept variant at each
    // grid point (a stand fan oscillating is a real, different thing and the old
    // set had it on two spots only). ~45 candidates per room against a screening
    // pass of ~25 ms; the budget below was raised to match, and it is only spent
    // where a fan is actually one of the devices in play.
    // AND STANDING IN AN OPEN WINDOW'S INFLOW, pointing into the room. This is
    // the studio smell task's actual answer — put the fan where the fresh air
    // comes in and push it across — and no interior grid point expresses it: the
    // spot is 30 cm off the glass, and the nearest grid row is a metre away. The
    // search found 0.296 against a 0.17 bar until this existed, i.e. it could
    // not reach the answer at all, however long it was given.
    for (const o of openings) {
      if (o.kind !== "window" || !o.rooms.includes(room.id) || !o.rooms.includes("outside")) continue;
      const vertical = Math.abs(o.a[0] - o.b[0]) < 1e-3;
      const mid = vertical ? (o.a[1] + o.b[1]) / 2 : (o.a[0] + o.b[0]) / 2;
      const line = vertical ? o.a[0] : o.a[1];
      const stand = 0.45; // far enough in to fit, close enough to be "at" it
      let px: number, pz: number;
      if (vertical) {
        const west = Math.abs(line - x) < Math.abs(line - (x + w));
        px = west ? x + stand : x + w - stand;
        pz = clamp(mid, z + 0.4, z + d - 0.4);
      } else {
        const south = Math.abs(line - z) < Math.abs(line - (z + d));
        px = clamp(mid, x + 0.4, x + w - 0.4);
        pz = south ? z + stand : z + d - stand;
      }
      // aimed straight in off the glass, and along the wall each way
      const inward = Math.atan2(cx - px, cz - pz);
      for (const yaw of [inward, inward + Math.PI / 2, inward - Math.PI / 2]) mk(px, 0.65, pz, yaw, "area", false);
      mk(px, 0.65, pz, inward, "area", true);
    }
    // Plus, standing back from each interior doorway and pointing THROUGH it.
    // A fan's whole job in a multi-room home is carrying conditioned air to the
    // room next door, and neither of the spots above can express that: both sit
    // mid-room facing +z whatever the doorway is doing. Without this the search
    // could put the heater in exactly the right place and still leave the far
    // room cold, offering a solution its own task marks as unfinished.
    for (const o of openings) {
      if (o.kind !== "door" || o.rooms.includes("outside") || !o.rooms.includes(room.id)) continue;
      const dxm = (o.a[0] + o.b[0]) / 2;
      const dzm = (o.a[1] + o.b[1]) / 2;
      const back = 1.2; // metres back from the doorway, inside this room
      const len = Math.hypot(dxm - cx, dzm - cz) || 1;
      const px = clamp(dxm + ((cx - dxm) / len) * back, x + 0.4, x + w - 0.4);
      const pz = clamp(dzm + ((cz - dzm) / len) * back, z + 0.4, z + d - 0.4);
      const yaw = Math.atan2(dxm - px, dzm - pz); // yaw 0 = +z, +pi/2 = +x
      mk(px, 0.65, pz, yaw, "area", false);
      mk(px, 0.65, pz, yaw, "area", true);
    }
    // THE GRID LAST, AND THAT ORDER MATTERS. The screening budget is finite and
    // spent in list order, so a candidate that never fits inside it might as
    // well not exist — the studio's answer (fan in the bed-side window) was
    // generated, sat at position 46 of 53, and was cut off every single run.
    // The opening-derived spots above are the ones a person would actually try
    // first and the ones the tasks are built around; the grid is the sweep that
    // catches everything else, and it is the part worth truncating.
    for (const fx of [0.25, 0.5, 0.75]) {
      for (const fz of [0.25, 0.5, 0.75]) {
        const px = x + w * fx;
        const pz = z + d * fz;
        for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) mk(px, 0.65, pz, yaw, "area", false);
        mk(px, 0.65, pz, 0, "area", true);
      }
    }
  }
  return out;
}

/** Score a full plan for the goal — bigger is better. */
function scorePlan(plan: FloorPlan, goal: OptimizeGoal, targetId: string | null, budget: SearchBudget): number {
  const built = buildSim3D(plan, { targetCells: budget.targetCells, iterations: budget.iterations });
  const { sim, nx, ny, nz, cellCenter, ambient } = built;
  for (let s = 0; s < budget.steps; s++) sim.step(0.05);

  const target = (targetId ? plan.rooms.find((r) => r.id === targetId) : null) ?? largestRoom(plan);
  const inRect = (r: Rect, x: number, zz: number) => x > r.x && x < r.x + r.w && zz > r.z && zz < r.z + r.d;

  if (goal === "cool" || goal === "warm") {
    const temp = advectDiffuseFill(built, sim.tempFixed, sim.tempVal, { iters: budget.fillIters });
    let sum = 0;
    let n = 0;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const c = sim.cIdx(i, j, k);
          if (sim.solid[c] || ambient[c]) continue;
          const [wx, , wz] = cellCenter(i, j, k);
          if (!inRect(target.rect, wx, wz)) continue;
          sum += temp[c];
          n++;
        }
    const mean = n ? sum / n : 0;
    return goal === "cool" ? -mean : mean;
  }

  // air-movement goals: house-wide mean speed + worst-room coverage bonus,
  // plus (for ventilate) the outflow actually leaving through open exteriors.
  const roomSum = new Map<string, { s: number; n: number }>();
  for (const r of plan.rooms) roomSum.set(r.id, { s: 0, n: 0 });
  let outflow = 0;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = sim.cIdx(i, j, k);
        if (sim.solid[c]) continue;
        const [u, v, w] = sim.velocityAt(i, j, k);
        const sp = Math.hypot(u, v, w);
        if (ambient[c]) {
          outflow += sp;
          continue;
        }
        const [wx, , wz] = cellCenter(i, j, k);
        const room = plan.rooms.find((r) => inRect(r.rect, wx, wz));
        if (!room) continue;
        const acc = roomSum.get(room.id)!;
        acc.s += sp;
        acc.n++;
      }
  let houseMean = 0;
  let worst = Infinity;
  let rooms = 0;
  for (const { s, n } of roomSum.values()) {
    if (!n) continue;
    const m = s / n;
    houseMean += m;
    worst = Math.min(worst, m);
    rooms++;
  }
  houseMean = rooms ? houseMean / rooms : 0;
  const uniform = Number.isFinite(worst) ? worst : 0;
  return goal === "ventilate" ? outflow * 0.02 + houseMean + uniform : houseMean + 2 * uniform;
}

/**
 * Greedy sim-scored search over device placements for the user's actual
 * layout. Never overlaps objects or blocks openings (collision-checked).
 */
export function searchOptimize(
  plan: FloorPlan,
  goal: OptimizeGoal,
  targetId: string | null,
  budget: Partial<SearchBudget> = {},
): SearchResult {
  const B: SearchBudget = { ...DEFAULT_BUDGET, ...budget };
  const target = (targetId ? plan.rooms.find((r) => r.id === targetId) : null) ?? largestRoom(plan);
  const roomOrder = [
    target,
    ...plan.rooms.filter((r) => r.id !== target.id).sort((a, b) => b.rect.w * b.rect.d - a.rect.w * a.rect.d),
  ];
  const openings = [...plan.doors, ...plan.windows];
  const wanted = GOAL_DEVICES[goal];
  const changes: string[] = [];

  let working: FloorPlan = { ...plan, items: plan.items.map((it) => ({ ...it })) };
  let evals = 0;
  const primaryOf: Record<OptimizeGoal, string> = {
    cool: "ac",
    warm: "heater",
    ventilate: "supply",
    circulate: "fan",
    balanced: "ac",
  };

  const counts: Record<string, number> = {};
  const toPlace = working.items
    .filter((it) => wanted.includes(it.type) && it.on !== false)
    .sort((a, b) => (a.type === primaryOf[goal] ? -1 : 0) - (b.type === primaryOf[goal] ? -1 : 0));

  for (const it of toPlace) {
    const index = counts[it.type] ?? 0;
    counts[it.type] = index + 1;
    // Primary device (and the first of each type) searches the target room
    // first; extra devices of a type prefer the OTHER rooms for coverage.
    const roomsToTry = index === 0 ? roomOrder : [...roomOrder.slice(1), roomOrder[0]];

    let best: { cand: Candidate; score: number } | null = null;
    for (const room of roomsToTry) {
      if (evals >= B.maxEvals) break;
      for (const cand of candidateSpots(room, it.type, plan.wallHeight, [...plan.doors, ...plan.windows])) {
        if (evals >= B.maxEvals) break;
        const others = working.items.filter((o) => o.id !== it.id);
        // Wall devices (AC/heater) may only slide ALONG their wall — never into
        // the room, onto a window, or into a doorway (no area fallback).
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
        if (!pos) continue; // occupied / blocks a doorway — skip, never overlap
        const placedPos: Vec3 = wallBound
          ? cand.axis === "x"
            ? [pos[0], cand.position[1], cand.position[2]] // keep the wall's z
            : [cand.position[0], cand.position[1], pos[2]] // keep the wall's x
          : [pos[0], cand.position[1], pos[2]];
        const trial: FloorPlan = {
          ...working,
          items: working.items.map((o) =>
            o.id === it.id
              ? {
                  ...o,
                  position: placedPos,
                  rotationY: cand.rotationY,
                  roomId: cand.roomId,
                  ...(cand.oscillate !== undefined ? { oscillate: cand.oscillate } : {}),
                }
              : o,
          ),
        };
        const score = scorePlan(trial, goal, targetId, B);
        evals++;
        if (!best || score > best.score) {
          best = { cand: { ...cand, position: placedPos }, score };
        }
      }
      // good-enough early exit: the target room usually wins for primaries
      if (best && index === 0 && room.id === target.id && it.type === primaryOf[goal]) break;
    }

    if (!best) {
      changes.push(`${DEVICE_LABEL[it.type] ?? it.type}: no free spot — left in place`);
      continue;
    }
    const prev = working.items.find((o) => o.id === it.id)!;
    const moved =
      Math.abs(best.cand.position[0] - prev.position[0]) > 0.05 ||
      Math.abs(best.cand.position[2] - prev.position[2]) > 0.05 ||
      Math.abs(best.cand.rotationY - prev.rotationY) > 0.05;
    working = {
      ...working,
      items: working.items.map((o) =>
        o.id === it.id
          ? {
              ...o,
              position: best!.cand.position,
              rotationY: best!.cand.rotationY,
              roomId: best!.cand.roomId,
              ...(best!.cand.oscillate !== undefined ? { oscillate: best!.cand.oscillate } : {}),
            }
          : o,
      ),
    };
    if (moved) changes.push(`Moved ${DEVICE_LABEL[it.type] ?? it.type} to ${best.cand.roomName} (best of search)`);
    if (it.type === "fan" && best.cand.oscillate !== undefined) {
      changes.push(`Fan sweep → ${best.cand.oscillate ? "on (oscillating)" : "off (fixed)"} (best of search)`);
    }
  }

  if (evals > 0) changes.push(`Compared ${evals} layouts with the simulator`);
  return { items: working.items, changes, evals, targetName: target.name };
}
