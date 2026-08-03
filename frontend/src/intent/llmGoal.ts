import type { FloorPlan, Rect } from "../floorplan/types";
import type { Objective } from "./objectives";

// The second half of the language layer: sentences the keyword dictionary in
// objectives.ts cannot read, sent to a model on the backend and mapped onto the
// SAME objective vocabulary the solver evaluates.
//
// KEYWORD FIRST, MODEL SECOND. resolveObjectives only reaches for this when the
// dictionary returns nothing, so every phrasing that already works keeps working
// instantly, offline, with no key and no network. What this adds is coverage for
// the sentences a participant actually types that the lexicon was never told
// about — and, when it is not available, an honest sentence saying so instead of
// a button that appears to do nothing.
//
// EVERY FAILURE IS THE SAME FAILURE, from the participant's side: the tool did
// not understand them. What differs is what the RESEARCHER can do about it, so
// the reasons are kept apart and logged — "the backend was never started" and
// "the dictionary and the model both read this and found no goal in it" are the
// same silence on screen and completely different findings in the log.

/** Where the parser lives. Set VITE_GOAL_PARSER_URL at build time to point a
 *  published page at a parser that is actually on the internet; with it unset,
 *  `npm run dev` talks to the local FastAPI backend, and with neither running
 *  the whole path degrades to the offline dictionary. */
const BACKEND_URL = (
  (import.meta.env.VITE_GOAL_PARSER_URL as string | undefined) ??
  (globalThis as { OPENFOAM_BACKEND?: string }).OPENFOAM_BACKEND ??
  "http://127.0.0.1:8000"
).replace(/\/$/, "");

/** Why the fallback produced nothing. The UI needs different words for each:
 *  "the parser is not running" and "it read your sentence and there was no
 *  comfort goal in it" are the same empty list and completely different advice. */
export type LlmReason = "ok" | "no-goal" | "unreachable" | "no-key" | "bad-key" | "error";

export interface LlmResult {
  objectives: Objective[];
  reason: LlmReason;
  /** The backend's own message, for the study log. Never shown verbatim — it is
   *  a stack-trace fragment, not a sentence for a participant. */
  detail?: string;
}

interface WireObjective {
  scalar: Objective["scalar"];
  direction: Objective["direction"];
  regionId: string | null;
  nearItem: string | null;
  sourceId: string | null;
}

/** Footprint of an item type, with the margin objectives.ts uses for the same
 *  job — the zone a person occupies around it, not the object's own outline. */
function itemRegion(plan: FloorPlan, type: string): { rect: Rect; name: string; roomId: string } | null {
  const it = plan.items.find((x) => x.type === type);
  if (!it) return null;
  const m = 0.35;
  const [sw, , sd] = it.size;
  return {
    rect: { x: it.position[0] - sw / 2 - m, z: it.position[2] - sd / 2 - m, w: sw + 2 * m, d: sd + 2 * m },
    name: `the ${type.replace(/_/g, " ")}`,
    roomId: it.roomId,
  };
}

/** Resolve a free-text goal via the backend. Never throws; never returns
 *  objectives the plan cannot ground. */
export async function parseGoalWithLLM(
  text: string,
  plan: FloorPlan,
  sketch?: Rect | null,
  opts: { outdoorTemp?: number; signal?: AbortSignal } = {},
): Promise<LlmResult> {
  let data: { objectives?: WireObjective[]; error?: string };
  try {
    const res = await fetch(`${BACKEND_URL}/api/parse-goal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: opts.signal,
      body: JSON.stringify({
        text,
        rooms: plan.rooms.map((r) => ({ id: r.id, name: r.name, type: r.type })),
        items: Array.from(new Set(plan.items.map((i) => i.type))),
        outdoor_temp: opts.outdoorTemp ?? null,
      }),
    });
    if (!res.ok) return { objectives: [], reason: "error", detail: `HTTP ${res.status}` };
    data = await res.json();
  } catch (e) {
    // Nothing listening on the port. Overwhelmingly the likely cause, and the
    // one the researcher can actually act on.
    return { objectives: [], reason: "unreachable", detail: String(e) };
  }

  if (data.error) {
    // A REJECTED KEY IS NOT A MISSING ONE. /api/health reports goalParser:true
    // whenever a key is merely present, so a typo'd or expired one looks fully
    // configured right up until every parse comes back 401 and the tool appears
    // to understand nothing.
    const reason: LlmReason = /ANTHROPIC_API_KEY/i.test(data.error)
      ? "no-key"
      : /401|authentication|invalid x-api-key/i.test(data.error)
        ? "bad-key"
        : "error";
    return { objectives: [], reason, detail: data.error };
  }

  const roomOf = (id: string | null) => plan.rooms.find((r) => r.id === id) ?? null;
  const objectives: Objective[] = (data.objectives ?? [])
    .map((o) => {
    // An item beats a room: "no draught on the bed" is about the bed, and
    // measuring the whole studio instead would average the sleeping end
    // together with the kitchen. Same precedence the dictionary uses.
      const obj = o.nearItem ? itemRegion(plan, o.nearItem) : null;
      const room = roomOf(o.regionId);
      const source = roomOf(o.sourceId);
      return {
        raw: text,
        scalar: o.scalar,
        direction: o.direction,
        regionId: obj ? obj.roomId : room?.id ?? null,
        regionName: obj ? obj.name : room?.name ?? null,
        sourceId: source?.id ?? null,
        sourceName: source?.name ?? null,
        // A sketched area still stands in as the region when the sentence named
        // no room and no item — again, as the dictionary does.
        regionRect: obj ? obj.rect : !room && sketch ? sketch : null,
      };
    })
    // AN OBJECTIVE NOBODY CAN MEASURE IS NOT AN OBJECTIVE. The model is handed
    // the room list, so a region that grounds nowhere is a mistake it made, not
    // a place the participant declined to name — and letting one through hands
    // the optimizer a goal with no target to score, which searches the whole
    // home against nothing. Dropping it means the panel says "say which room
    // you mean", which is both true and actionable.
    .filter((o) => o.regionId !== null || o.regionRect !== null);
  return { objectives, reason: objectives.length ? "ok" : "no-goal" };
}
