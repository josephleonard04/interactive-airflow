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
  nodraft: "No draught",
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

export interface SketchGoal {
  /** The search goal these marks reduce to. */
  goal: OptimizeGoal;
  /** Rooms the user wants served, in drawing order. */
  targetIds: string[];
  /** Plain-language rendering of the drawing — shown on the option cards and
   *  written to the study log, so a sketched turn reads like a typed one. */
  text: string;
  /** True when the drawing asks for LESS air movement, which is not a placement
   *  search at all — it is "turn the movers down", the same as typing "no
   *  draught on the bed". */
  calm: boolean;
}

/** Reduce a drawing to a goal the solver already understands.
 *
 *  Areas decide WHAT is wanted (the first one drawn wins if they disagree —
 *  "warm here and cool there" is two sessions' worth of intent, not one) and
 *  WHERE. An arrow adds its destination room as somewhere that must be served,
 *  because "bring it from the living room to the bedroom" names the bedroom as
 *  the room in trouble. An arrow on its own, with no area, is a request to move
 *  air along it. */
export function sketchToGoal(marks: SketchMark[], plan: FloorPlan): SketchGoal | null {
  if (marks.length === 0) return null;

  const areas = marks.filter((m): m is SketchArea => m.kind === "area");
  const arrows = marks.filter((m): m is SketchArrow => m.kind === "arrow");
  const intent = areas[0]?.intent ?? null;

  const targetIds: string[] = [];
  const push = (id: string | undefined | null) => {
    if (id && !targetIds.includes(id)) targetIds.push(id);
  };
  for (const a of areas) if (a.intent === intent) push(areaRoom(plan, a.rect)?.id);
  for (const a of arrows) push(roomAt(plan, a.to[0], a.to[1])?.id);

  const nameOf = (id: string) => plan.rooms.find((r) => r.id === id)?.name ?? id;
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
      targetIds,
      text: arrowText.join(", ") || "move air along the arrow",
      calm: false,
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
          : `no draught in ${where}`;

  return { goal, targetIds, text: [head, ...arrowText].join(", "), calm: intent === "nodraft" };
}

let markSeq = 0;
export const nextMarkId = (): string => `mark-${++markSeq}`;
