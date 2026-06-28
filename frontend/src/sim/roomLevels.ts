import type { FloorPlan } from "../floorplan/types";

// Steady-state scalar level per room over the open-door connectivity graph:
// rooms linked by OPEN doors share the condition, open windows/doors vent to
// ambient (0), and walls / closed doors block it. Used both by the 3D fill
// visualization and by the intent→physics evaluator. Solved by a small
// Gauss-Seidel relaxation of Laplace's equation on the room graph.

export type LevelKind = "temperature" | "contamination";

export const POWER: Record<number, number> = { 1: 0.5, 2: 1.0, 3: 1.6 };
const SOURCE_T = 10; // heater (+) / AC (−) magnitude at full power

export function computeRoomLevels(plan: FloorPlan, kind: LevelKind, sourceRoomId: string | null): Map<string, number> {
  const ids = plan.rooms.map((r) => r.id);
  const adj = new Map<string, string[]>(ids.map((id) => [id, []]));
  const outside = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const o of [...plan.doors, ...plan.windows]) {
    if (!o.open) continue;
    const [a, b] = o.rooms;
    if (b === "outside") outside.set(a, (outside.get(a) ?? 0) + 1);
    else { adj.get(a)?.push(b); adj.get(b)?.push(a); }
  }

  const fixed = new Set<string>();
  const val = new Map<string, number>(ids.map((id) => [id, 0]));
  if (kind === "temperature") {
    for (const it of plan.items) {
      if (it.on === false) continue;
      const p = POWER[it.power ?? 2] ?? 1;
      if (it.type === "heater") { val.set(it.roomId, (val.get(it.roomId) ?? 0) + SOURCE_T * p); fixed.add(it.roomId); }
      if (it.type === "ac") { val.set(it.roomId, (val.get(it.roomId) ?? 0) - SOURCE_T * p); fixed.add(it.roomId); }
    }
  } else if (sourceRoomId) {
    val.set(sourceRoomId, 1);
    fixed.add(sourceRoomId);
  }

  const T = new Map<string, number>(ids.map((id) => [id, fixed.has(id) ? val.get(id)! : 0]));
  for (let it = 0; it < 80; it++) {
    for (const id of ids) {
      if (fixed.has(id)) continue;
      const nb = adj.get(id)!;
      const out = outside.get(id)!;
      let sum = 0;
      let n = 0;
      for (const m of nb) { sum += T.get(m)!; n++; }
      n += out; // outside contributes ambient 0
      T.set(id, n > 0 ? sum / n : 0);
    }
  }
  return T;
}
