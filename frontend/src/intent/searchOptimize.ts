import { buildSim3D, advectDiffuseFill } from "../sim/sim3d";
import { findFreeSpot, type SearchAxis } from "../floorplan/collision";
import type { FloorPlan, PlacedItem, Rect, Vec3 } from "../floorplan/types";
import { DEVICE_LABEL, GOAL_DEVICES, largestRoom, type OptimizeGoal } from "./optimize";

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
export function candidateSpots(room: { id: string; name: string; rect: Rect }, type: string, wallHeight: number): Candidate[] {
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
    mk(x + 0.2, 0.25, cz, Math.PI / 2, "z");
    mk(x + w - 0.2, 0.25, cz, -Math.PI / 2, "z");
    mk(cx, 0.25, z + 0.2, 0, "x");
    mk(cx, 0.25, z + d - 0.2, Math.PI, "x");
  } else if (type === "supply") {
    mk(cx, wallHeight - 0.1, cz, 0, "area");
    mk(x + w * 0.3, wallHeight - 0.1, z + d * 0.3, 0, "area");
    mk(x + w * 0.7, wallHeight - 0.1, z + d * 0.7, 0, "area");
  } else {
    // fan: two spots × sweep on/off — oscillation is part of the search
    mk(cx, 0.65, cz, 0, "area", true);
    mk(cx, 0.65, cz, 0, "area", false);
    mk(x + w * 0.3, 0.65, z + d * 0.35, 0, "area", true);
    mk(x + w * 0.3, 0.65, z + d * 0.35, 0, "area", false);
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
      for (const cand of candidateSpots(room, it.type, plan.wallHeight)) {
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
