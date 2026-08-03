import type { FloorPlan, Rect } from "../floorplan/types";
import type { Objective } from "./objectives";

// Plain-language goals the keyword parser can't match, resolved by Claude.
//
// The seed vocabulary in objectives.ts covers the phrasings the pilot survey
// produced and nothing else, so a participant who says "it gets stuffy in here
// after I cook" gets silence — the tool looks broken even though the thought
// was perfectly clear. This asks the backend to map that sentence onto the SAME
// objective vocabulary, so whatever comes back is still checkable against the
// solver rather than being free-form text.
//
// KEYWORD-FIRST, LLM SECOND. This is only consulted when parseGoal() returns
// nothing: phrases that already work keep working offline, with no added
// latency and no API call. And every failure here — no key, no backend, network
// down, a refusal — resolves to an empty list, so a live study session degrades
// to exactly today's behaviour instead of erroring in front of a participant.

const BACKEND_URL =
  ((globalThis as { OPENFOAM_BACKEND?: string }).OPENFOAM_BACKEND ?? "http://127.0.0.1:8000").replace(/\/$/, "");

/** Why the fallback produced nothing — so the UI can tell "the parser is not
 *  running" apart from "the parser read it and there was no goal in it". Those
 *  need completely different words in front of a participant, and returning a
 *  bare empty list made them identical. */
export type LlmReason = "ok" | "unreachable" | "no-key" | "bad-key" | "error" | "no-goal";

export interface LlmResult {
  objectives: Objective[];
  reason: LlmReason;
  /** The backend's own message, for the study log. Never shown verbatim. */
  detail?: string;
}

interface WireObjective {
  scalar: Objective["scalar"];
  direction: Objective["direction"];
  regionId: string | null;
  sourceId: string | null;
}

/** Resolve a free-text goal via the backend. Returns [] if unavailable. */
export async function parseGoalWithLLM(
  text: string,
  plan: FloorPlan,
  sketch?: Rect | null,
  signal?: AbortSignal,
): Promise<LlmResult> {
  let data: { objectives?: WireObjective[]; error?: string };
  try {
    const res = await fetch(`${BACKEND_URL}/api/parse-goal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal,
      body: JSON.stringify({
        text,
        rooms: plan.rooms.map((r) => ({ id: r.id, name: r.name, type: r.type })),
      }),
    });
    if (!res.ok) return { objectives: [], reason: "error", detail: `HTTP ${res.status}` };
    data = await res.json();
  } catch (e) {
    // Nothing listening on the port: the backend was never started, which is
    // the overwhelmingly likely cause and the one the user can act on.
    return { objectives: [], reason: "unreachable", detail: String(e) };
  }

  if (data.error) {
    // A REJECTED KEY IS NOT A MISSING ONE, and the two need different advice.
    // /api/health reports goalLlm:true whenever a key is merely present, so a
    // typo'd or expired key looks fully configured right up until every parse
    // comes back 401 and the tool appears to understand nothing.
    const reason: LlmReason = /ANTHROPIC_API_KEY/i.test(data.error)
      ? "no-key"
      : /401|authentication|invalid x-api-key/i.test(data.error)
        ? "bad-key"
        : "error";
    return { objectives: [], reason, detail: data.error };
  }

  const named = (id: string | null) => plan.rooms.find((r) => r.id === id) ?? null;
  const objectives = (data.objectives ?? []).map((o) => {
    const region = named(o.regionId);
    const source = named(o.sourceId);
    return {
      raw: text,
      scalar: o.scalar,
      direction: o.direction,
      regionId: region?.id ?? null,
      regionName: region?.name ?? null,
      sourceId: source?.id ?? null,
      sourceName: source?.name ?? null,
      // A sketched area still wins as the region when the goal didn't name a
      // room — same precedence the keyword parser uses.
      regionRect: !region && sketch ? sketch : null,
    };
  });
  return { objectives, reason: objectives.length ? "ok" : "no-goal" };
}
