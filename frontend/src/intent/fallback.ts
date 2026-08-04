import type { ScenarioGoal } from "../floorplan/scenarios";
import type { FloorPlan, Rect } from "../floorplan/types";
import type { Objective } from "./objectives";

// THE LAST RESORT, SO THE BOX IS NEVER A DEAD END.
//
// Dictionary first, model second, and then — before this existed — nothing: a
// sentence neither route could read got a shrug and no search. That is the
// worst possible outcome in a study session, because the participant cannot
// tell "the app did not understand me" from "the app has no answer", and the
// second reading is the one that stops them typing again. "Can you adjust it a
// little", "help", "something better", a typo — all of them dead-ended.
//
// But the app is never actually without a goal. Every scenario ships with the
// task's own checkable goals, on screen the whole time, and they are already in
// the same vocabulary the parser emits. So an unreadable sentence falls back to
// "work on the task in front of you", which is both a defensible reading of
// "adjust it" and strictly better than silence. The panel says it did this, so
// nobody mistakes the fallback for comprehension — and the sentence is still
// logged verbatim as the coverage gap it is.

/** The zone a person occupies around a named object — the same margin the
 *  dictionary uses when it grounds "a draught on the bed". */
const NEAR_MARGIN = 0.35;

function itemRegion(plan: FloorPlan, type: string): { rect: Rect; roomId: string } | null {
  const it = plan.items.find((x) => x.type === type);
  if (!it) return null;
  const [sw, , sd] = it.size;
  return {
    rect: {
      x: it.position[0] - sw / 2 - NEAR_MARGIN,
      z: it.position[2] - sd / 2 - NEAR_MARGIN,
      w: sw + 2 * NEAR_MARGIN,
      d: sd + 2 * NEAR_MARGIN,
    },
    roomId: it.roomId,
  };
}

/** Objectives standing in for "whatever this task is asking for", built from the
 *  scenario's own tick-boxes. Returns [] off-scenario (the free-play app), where
 *  there is no task to fall back to. */
export function objectivesFromScenario(
  goals: ScenarioGoal[] | undefined,
  plan: FloorPlan,
  text: string,
): Objective[] {
  const out: Objective[] = [];
  for (const g of goals ?? []) {
    const near = g.nearItem ? itemRegion(plan, g.nearItem) : null;
    const room = plan.rooms.find((r) => r.id === g.roomId) ?? null;
    const base = {
      raw: text,
      regionId: near ? near.roomId : room?.id ?? null,
      regionName: room?.name ?? null,
      regionRect: near ? near.rect : null,
    };
    if (g.metric === "temperature") {
      // `atLeast` set means the task is asking the room to be WARM ENOUGH; a
      // bare `atMost` means keep it cool. Winter sets both, and there the floor
      // is the binding one — the room is cold and the task is to warm it.
      out.push({ ...base, scalar: "temperature", direction: g.atLeast != null ? "high" : "low" });
    } else if (g.metric === "smell" || g.metric === "drying") {
      out.push({ ...base, scalar: "contaminant", direction: "low" });
    } else {
      out.push({ ...base, scalar: "draft", direction: g.atLeast != null ? "high" : "low" });
    }
  }
  // Two goals over the same room and scalar (the winter task's "warm enough"
  // plus its window strip) would send the search chasing one target twice.
  const seen = new Set<string>();
  return out.filter((o) => {
    const k = `${o.scalar}|${o.direction}|${o.regionId}|${o.regionRect ? "rect" : ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
