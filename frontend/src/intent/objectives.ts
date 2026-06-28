import type { FloorPlan, RoomType } from "../floorplan/types";

// Intent → physics: translate a non-expert's everyday comfort goal ("keep my
// bedroom cool", "no kitchen smell in the bedroom") into a small, fixed set of
// physical objectives the simulation can evaluate. This is the seed dictionary
// described in docs/contribution-positioning.md §2 — the LLM layer can later
// generalize beyond it, but every objective stays in this vocabulary so it is
// always checkable against the solver.

export type Scalar = "temperature" | "contaminant";
export type Direction = "low" | "high";

export interface Objective {
  raw: string;
  scalar: Scalar;
  direction: Direction; // low = minimize, high = maximize
  /** The room the goal is about (where we want the condition met). */
  regionId: string | null;
  regionName: string | null;
  /** For smell goals: the room the odor comes from, if named. */
  sourceId?: string | null;
  sourceName?: string | null;
}

// word → (scalar, direction). First match wins.
const LEXICON: Array<{ words: string[]; scalar: Scalar; direction: Direction }> = [
  { words: ["cool", "cold", "chilly", "cooler", "chill"], scalar: "temperature", direction: "low" },
  { words: ["warm", "hot", "cozy", "cosy", "toasty", "warmer", "heat"], scalar: "temperature", direction: "high" },
  { words: ["smell", "odor", "odour", "stink", "stench", "fume", "fumes", "smoke", "stinky"], scalar: "contaminant", direction: "low" },
];

const NEGATERS = ["no", "not", "without", "keep out", "out of", "away", "avoid", "free of", "don't", "dont", "prevent"];

const ROOM_WORDS: Array<{ words: string[]; type: RoomType }> = [
  { words: ["bedroom", "bed room", "bed"], type: "bedroom" },
  { words: ["kitchen"], type: "kitchen" },
  { words: ["living", "lounge", "family room"], type: "living" },
  { words: ["bathroom", "bath", "toilet", "washroom"], type: "bathroom" },
];

function findRooms(text: string, plan: FloorPlan): Array<{ id: string; name: string; type: RoomType; at: number }> {
  const hits: Array<{ id: string; name: string; type: RoomType; at: number }> = [];
  for (const room of plan.rooms) {
    const entry = ROOM_WORDS.find((rw) => rw.type === room.type);
    const words = [room.name.toLowerCase(), ...(entry ? entry.words : [])];
    let best = -1;
    for (const w of words) {
      const i = text.indexOf(w);
      if (i >= 0 && (best < 0 || i < best)) best = i;
    }
    if (best >= 0) hits.push({ id: room.id, name: room.name, type: room.type, at: best });
  }
  return hits.sort((a, b) => a.at - b.at);
}

/** Parse one free-text comfort goal into objectives over the fixed vocabulary. */
export function parseGoal(text: string, plan: FloorPlan): Objective[] {
  const t = ` ${text.toLowerCase().trim()} `;
  const rooms = findRooms(t, plan);
  const out: Objective[] = [];

  for (const lex of LEXICON) {
    const idx = lex.words.map((w) => t.indexOf(` ${w}`)).filter((i) => i >= 0);
    if (idx.length === 0) continue;
    const at = Math.min(...idx);

    if (lex.scalar === "contaminant") {
      // smell goals: someone wants LESS smell somewhere. The protected room is
      // usually the one phrased as "my X" / "in X" / "out of X"; the source is a
      // smell-producing room named earlier (e.g. "kitchen smell").
      const negated = NEGATERS.some((n) => t.includes(n));
      const target = pickTargetRoom(t, rooms, at);
      const source = rooms.find((r) => r.id !== target?.id && (r.type === "kitchen" || r.type === "bathroom")) ?? rooms.find((r) => r.id !== target?.id) ?? null;
      out.push({
        raw: text,
        scalar: "contaminant",
        direction: negated ? "low" : "low", // smell goals are virtually always "less"
        regionId: target?.id ?? null,
        regionName: target?.name ?? null,
        sourceId: source?.id ?? null,
        sourceName: source?.name ?? null,
      });
    } else {
      const region = nearestRoom(rooms, at) ?? rooms[0] ?? null;
      out.push({
        raw: text,
        scalar: "temperature",
        direction: lex.direction,
        regionId: region?.id ?? null,
        regionName: region?.name ?? null,
      });
    }
  }
  return out;
}

function nearestRoom(rooms: Array<{ id: string; name: string; at: number }>, at: number) {
  if (rooms.length === 0) return null;
  return rooms.reduce((b, r) => (Math.abs(r.at - at) < Math.abs(b.at - at) ? r : b));
}

// the room being protected: prefer one introduced by "my"/"in"/"into"/"out of"
function pickTargetRoom(
  t: string,
  rooms: Array<{ id: string; name: string; type: RoomType; at: number }>,
  smellAt: number,
) {
  if (rooms.length === 0) return null;
  const cues = ["my ", "in ", "into ", "out of ", "to ", "reach "];
  for (const cue of cues) {
    let from = 0;
    while (true) {
      const i = t.indexOf(cue, from);
      if (i < 0) break;
      const after = i + cue.length;
      const r = rooms.find((rm) => rm.at >= after - 1 && rm.at <= after + 14);
      if (r && r.type !== "kitchen") return r;
      from = i + cue.length;
    }
  }
  // otherwise the room mentioned after the smell word, else the last room
  return rooms.find((r) => r.at > smellAt) ?? rooms[rooms.length - 1];
}
