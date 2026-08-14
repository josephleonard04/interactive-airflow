import type { FloorPlan, Rect, Vec2 } from "../floorplan/types";
import type { OptimizeGoal } from "./optimize";

// Sketching as a way of stating an intent, alongside typing one.
//
// Typing is not always the natural move: "warm THIS corner, and bring the air
// from the living room into the bedroom" is a sentence about geometry, and the
// geometry is right there on screen. So the second input is a drawing — but a
// drawing on its own is ambiguous (a box could mean warm, cool, air it out, or
// leave it alone), so every mark carries the intent it was drawn with. The user
// picks a pen, then draws where they mean it.
//
// Two kinds of mark:
//   AREA   a box (or a click, which becomes a small square) with one of four
//          intents — warm / cool / fresh air / no draught.
//   ARROW  from one point to another: "move air this way", e.g. living room →
//          bedroom. Its destination is what the user wants served.
//
// Both reduce to the SAME objective vocabulary the typed goals use, so the
// solver, the review panel and the study log cannot tell the two inputs apart
// downstream — which is the point: this is a second way to say the same thing,
// not a second system.

export type SketchIntent = "warm" | "cool" | "fresh" | "nodraft";
export type SketchTool = SketchIntent | "arrow";

export interface SketchArea {
  id: string;
  kind: "area";
  intent: SketchIntent;
  rect: Rect;
}

export interface SketchArrow {
  id: string;
  kind: "arrow";
  from: Vec2;
  to: Vec2;
}

export type SketchMark = SketchArea | SketchArrow;

export const INTENT_LABEL: Record<SketchIntent, string> = {
  warm: "Warm",
  cool: "Cool",
  fresh: "Fresh air",
  nodraft: "No draft",
};

/** One colour per intent, used by the mini-map, the mark list and the 3D
 *  highlight so a drawn box means the same thing everywhere it appears. */
export const INTENT_COLOR: Record<SketchIntent, string> = {
  warm: "#e07a3f",
  cool: "#3f86e0",
  fresh: "#2a9d8f",
  nodraft: "#8a6fd0",
};

export const TOOL_COLOR = (t: SketchTool): string => (t === "arrow" ? "#5b6470" : INTENT_COLOR[t]);

/** Which room a point falls in. */
function roomAt(plan: FloorPlan, x: number, z: number) {
  return (
    plan.rooms.find((r) => x >= r.rect.x && x <= r.rect.x + r.rect.w && z >= r.rect.z && z <= r.rect.z + r.rect.d) ??
    null
  );
}

/** The room a drawn area sits in (by its centre). */
export function areaRoom(plan: FloorPlan, rect: Rect) {
  return roomAt(plan, rect.x + rect.w / 2, rect.z + rect.d / 2);
}

/** Where the air is being asked to come FROM and go TO, in world coordinates.
 *
 *  A fan pushes air away from itself, so "move air from the living room to the
 *  bedroom" puts the fan in the LIVING ROOM, aimed through the doorway. The
 *  search only ever knew the destination — that is the room that has to be
 *  served, and it is what the score is measured on — so it dutifully stood the
 *  fan in the middle of the bedroom, which is the one place it cannot do the
 *  job the arrow asked for. The arrow's tail has to travel with the goal. */
export interface FlowHint {
  from: Vec2;
  to: Vec2;
  fromRoomId: string | null;
  toRoomId: string | null;
}

export interface SketchGoal {
  /** The search goal these marks reduce to. */
  goal: OptimizeGoal;
  /** The first arrow drawn, if any — see FlowHint. */
  flow?: FlowHint;
  /** Rooms the user wants served, in drawing order. */
  targetIds: string[];
  /** Plain-language rendering of the drawing — shown on the option cards and
   *  written to the study log, so a sketched turn reads like a typed one. */
  text: string;
  /** True when the drawing asks for LESS air movement AND NOTHING ELSE, which
   *  is not a placement search at all — it is "turn the movers down", the same
   *  as typing "no draft on the bed".
   *
   *  A no-draft box next to a cool box is NOT that. "Still here, cold there" is
   *  one coherent request — it is the apartment task written in two rectangles —
   *  and switching the movers off answers half of it by giving up on the other
   *  half. That case searches, with the calm box travelling as a constraint the
   *  task's own draft goal already scores. */
  calm: boolean;
  /** Rooms a no-draft box was drawn over, when the drawing ALSO asks for
   *  something to be delivered. Carried for the wording and the log. */
  calmIds: string[];
}

/** Reduce a drawing to a goal the solver already understands.
 *
 *  Areas decide WHAT is wanted (the first one drawn wins if they disagree —
 *  "warm here and cool there" is two sessions' worth of intent, not one) and
 *  WHERE. ONE PAIR IS EXEMPT: a no-draft box and a deliver-something box are
 *  not a disagreement. "Keep this end still, get cold air to that end" is a
 *  single request, and it is the one the apartment task is about — so the
 *  deliverable leads the search and the no-draft box rides along as a
 *  constraint. Read the other way round it produced nonsense: the first box
 *  drawn was the no-draft one, everything after it was discarded, and the whole
 *  drawing came back as "switch the fan off".
 *  An arrow adds its destination room as somewhere that must be served,
 *  because "bring it from the living room to the bedroom" names the bedroom as
 *  the room in trouble. An arrow on its own, with no area, is a request to move
 *  air along it. */
export function sketchToGoal(marks: SketchMark[], plan: FloorPlan): SketchGoal | null {
  if (marks.length === 0) return null;

  const areas = marks.filter((m): m is SketchArea => m.kind === "area");
  const arrows = marks.filter((m): m is SketchArrow => m.kind === "arrow");
  // A no-draft box asks for something to STOP; the other three ask for
  // something to ARRIVE. Split them before picking a winner, so a drawing that
  // has one of each keeps both halves.
  const deliver = areas.filter((a) => a.intent !== "nodraft");
  const calmAreas = areas.filter((a) => a.intent === "nodraft");
  const intent = (deliver[0] ?? areas[0])?.intent ?? null;
  const leading = deliver.length ? deliver : calmAreas;

  const targetIds: string[] = [];
  const push = (id: string | undefined | null) => {
    if (id && !targetIds.includes(id)) targetIds.push(id);
  };
  for (const a of leading) if (a.intent === intent) push(areaRoom(plan, a.rect)?.id);
  for (const a of arrows) push(roomAt(plan, a.to[0], a.to[1])?.id);
  const calmIds: string[] = [];
  for (const a of calmAreas) {
    const id = areaRoom(plan, a.rect)?.id;
    if (id && !calmIds.includes(id)) calmIds.push(id);
  }

  const nameOf = (id: string) => plan.rooms.find((r) => r.id === id)?.name ?? id;
  // The first arrow is the one that decides where the fan stands. Two arrows
  // pointing different ways is two intents, and picking one is more honest than
  // averaging them into a direction nobody drew.
  const a0 = arrows[0];
  const flow: FlowHint | undefined = a0
    ? {
        from: a0.from,
        to: a0.to,
        fromRoomId: roomAt(plan, a0.from[0], a0.from[1])?.id ?? null,
        toRoomId: roomAt(plan, a0.to[0], a0.to[1])?.id ?? null,
      }
    : undefined;
  const arrowText = arrows
    .map((a) => {
      const from = roomAt(plan, a.from[0], a.from[1]);
      const to = roomAt(plan, a.to[0], a.to[1]);
      return from && to && from.id !== to.id ? `move air from ${from.name} to ${to.name}` : "move air along the arrow";
    })
    .filter((t, i, all) => all.indexOf(t) === i);

  if (!intent) {
    // arrows only
    return {
      goal: "circulate",
      flow,
      targetIds,
      text: arrowText.join(", ") || "move air along the arrow",
      calm: false,
      calmIds: [],
    };
  }

  const goal: OptimizeGoal =
    intent === "warm" ? "warm" : intent === "cool" ? "cool" : intent === "fresh" ? "ventilate" : "circulate";
  const where = targetIds.length ? targetIds.map(nameOf).join(" and ") : "the area you drew";
  const head =
    intent === "warm"
      ? `warm ${where}`
      : intent === "cool"
        ? `cool ${where}`
        : intent === "fresh"
          ? `fresh air in ${where}`
          : `no draft in ${where}`;

  // The calm boxes still get said out loud even when they are not steering, so
  // the card and the log show the whole drawing rather than the half that won.
  const calmText = calmIds.length ? [`no draft in ${calmIds.map(nameOf).join(" and ")}`] : [];
  return {
    goal,
    flow,
    targetIds,
    text: [head, ...calmText, ...arrowText].join(", "),
    // Only a drawing that asks for NOTHING to arrive is a "quiet everything"
    // request. With a cool box or an arrow on the pad there is a job to do.
    calm: intent === "nodraft" && !arrows.length,
    calmIds,
  };
}

let markSeq = 0;
export const nextMarkId = (): string => `mark-${++markSeq}`;
