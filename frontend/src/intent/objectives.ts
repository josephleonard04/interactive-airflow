import type { FloorPlan, Rect, RoomType } from "../floorplan/types";
import { normalizeText, type Vocabulary } from "./normalize";

// Intent → physics: translate a non-expert's everyday comfort goal ("keep my
// bedroom cool", "no kitchen smell in the bedroom") into a small, fixed set of
// physical objectives the simulation can evaluate. This is the seed dictionary
// described in docs/contribution-positioning.md §2 — the LLM layer can later
// generalize beyond it, but every objective stays in this vocabulary so it is
// always checkable against the solver.

export type Scalar = "temperature" | "contaminant" | "draft";
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
  /** Set when the region came from a user-sketched area (world coords). */
  regionRect?: Rect | null;
}

// Deictic phrases that refer to a sketched area ("keep THIS AREA cool").
const DEICTIC = /\b(this|that|the|marked) (area|spot|place|zone|corner|region)\b|\bhere\b/;

/** The room containing the sketch's centre, so a sketched area inherits the
 *  room-level physics of wherever it was drawn. */
function sketchRoom(plan: FloorPlan, sketch: Rect) {
  const cx = sketch.x + sketch.w / 2;
  const cz = sketch.z + sketch.d / 2;
  return plan.rooms.find(
    (r) => cx >= r.rect.x && cx <= r.rect.x + r.rect.w && cz >= r.rect.z && cz <= r.rect.z + r.rect.d,
  ) ?? null;
}

// word → (scalar, direction). First match wins.
const LEXICON: Array<{ words: string[]; scalar: Scalar; direction: Direction }> = [
  {
    words: [
      "cool", "cold", "chilly", "cooler", "chill", "colder", "freezing", "frigid",
      "icy", "aircon", "airconditioning", "airconditioner", "refreshing",
      "sweltering", "boiling", "roasting", "sweaty", "muggy", "overheating",
      "overheated", "baking", "sticky",
    ],
    scalar: "temperature",
    direction: "low",
  },
  {
    words: [
      "warm", "hot", "cozy", "cosy", "toasty", "warmer", "heat", "heater",
      "heating", "warmth", "radiator", "snug",
    ],
    scalar: "temperature",
    direction: "high",
  },
  {
    words: [
      "smell", "smells", "smelly", "odor", "odour", "stink", "stinks", "stench",
      "fume", "fumes", "smoke", "stinky", "reek", "reeks", "whiff",
      "rubbish", "garbage", "trash", "waste",
    ],
    scalar: "contaminant",
    direction: "low",
  },
  // "I want FRESH AIR near the bed", "it's STUFFY in here". Same objective as a
  // smell goal — get the air in this spot exchanged — said from the other end:
  // one names what is wrong, the other names what is wanted. The lexicon knew
  // only the complaint, so the most natural way to ask for ventilation matched
  // nothing at all and the search quietly refused to run.
  {
    words: [
      "fresh", "freshen", "stuffy", "stale", "airless", "musty", "stifling",
      "ventilate", "ventilation", "ventilated", "airy", "breathe", "breathable",
      "circulate", "circulation", "suffocating", "clammy", "mould", "mold",
      "condensation",
    ],
    scalar: "contaminant",
    direction: "low",
  },
  // draft / air movement on a spot — "no air blowing on my face", "too drafty"
  {
    words: [
      "draft", "drafty", "draught", "draughty", "breeze", "breezy", "blowing",
      "blow", "blows", "wind", "windy", "gust", "gusty",
    ],
    scalar: "draft",
    direction: "low",
  },
];

/** Words that say a place should be BETTER without saying which way.
 *
 *  "I want the bed area to be nice to sleep" names no physical quantity at all,
 *  and a dictionary keyed on quantities can only shrug at it — which is exactly
 *  what it did. But the sentence is not ambiguous to a person: nice-to-sleep in
 *  a heatwave means cooler, and in February it means warmer. The weather is the
 *  missing half of the sentence, and the task already knows it.
 *
 *  With no weather to hand it falls back to ventilation, the one reading that is
 *  never actively wrong: "make it nicer in here" always at least means fresher. */
const COMFORT_WORDS = [
  "nice", "nicer", "comfortable", "comfy", "comfort", "pleasant", "bearable",
  "liveable", "livable", "decent", "sleep", "sleeping", "rest", "relax",
  "relaxing", "nap", "napping",
];
/** At or above this outdoors, "make it comfortable" means cool it down. */
const COMFORT_HOT_C = 26;
/** At or below this, it means warm it up. */
const COMFORT_COLD_C = 16;

/** Every single word the dictionary knows, for spelling and compound repair. */
const VOCABULARY: Vocabulary = {
  words: new Set<string>([
    ...LEXICON.flatMap((l) => l.words),
    ...COMFORT_WORDS,
    "bedroom", "bed", "kitchen", "living", "lounge", "bathroom", "bath",
    "toilet", "washroom", "studio", "apartment", "flat", "house", "home",
    "couch", "sofa", "desk", "table", "closet", "window", "windows", "door",
    "doors", "vent", "extract", "area", "spot", "zone", "corner", "region",
    "place", "night", "morning", "here", "inside",
  ]),
};

// Objects a draft goal can point at ("no air blowing on the bed"): the item's
// footprint becomes the evaluation region. Matched before room words.
const OBJECT_WORDS: Array<{ words: string[]; type: string }> = [
  { words: ["bed"], type: "bed" },
  { words: ["couch", "sofa"], type: "couch" },
  { words: ["desk"], type: "desk" },
  { words: ["table"], type: "table" },
];

/** Footprint rect (with margin) of the first item of a named type. */
function objectRegion(t: string, plan: FloorPlan): { rect: Rect; name: string; roomId: string } | null {
  for (const ow of OBJECT_WORDS) {
    if (!ow.words.some((w) => t.includes(` ${w}`) || t.includes(`${w} `))) continue;
    const it = plan.items.find((x) => x.type === ow.type);
    if (!it) continue;
    const m = 0.35; // margin: the zone a person occupies around the object
    const [sw, , sd] = it.size;
    return {
      rect: { x: it.position[0] - sw / 2 - m, z: it.position[2] - sd / 2 - m, w: sw + 2 * m, d: sd + 2 * m },
      name: `the ${ow.type}`,
      roomId: it.roomId,
    };
  }
  return null;
}

/** Joins two rooms into one compound goal: "living room and bedroom", "X & Y". */
const CONJOINED = /\band\b|&|,|\bboth\b|\bplus\b/;

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
  // A ONE-ROOM HOME NEEDS NO NAMING. In the studio and the one-room flat there
  // is exactly one room, so "it's stuffy in here" is unambiguous — and requiring
  // the name meant those two tasks, the ones where people are most likely to say
  // "in here", were the ones that grounded nowhere.
  if (hits.length === 0 && plan.rooms.length === 1) {
    const r = plan.rooms[0];
    hits.push({ id: r.id, name: r.name, type: r.type, at: 0 });
  }
  return hits.sort((a, b) => a.at - b.at);
}

/** Parse one free-text comfort goal into objectives over the fixed vocabulary.
 *  `sketch` is an optionally user-drawn area: deictic goals ("keep this area
 *  cool") ground to it, and it is the fallback region when no room is named. */
export function parseGoal(
  text: string,
  plan: FloorPlan,
  sketch?: Rect | null,
  opts: { outdoorTemp?: number } = {},
): Objective[] {
  // Fold spellings, contractions and glued compounds onto the dictionary's own
  // words first, so everything below matches what the person MEANT to type. The
  // plan's own room names join the vocabulary, so "Studio" and "Living +
  // kitchen" can be repaired the same way the fixed words are.
  const vocab: Vocabulary = {
    words: new Set([
      ...VOCABULARY.words,
      ...plan.rooms.flatMap((r) => r.name.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2)),
    ]),
  };
  const t = normalizeText(text, vocab);
  const rooms = findRooms(t, plan);
  const out: Objective[] = [];

  // Sketch grounding: "this area" (or no named room at all) → the sketched spot.
  const deictic = DEICTIC.test(t);
  const sk = sketch ? sketchRoom(plan, sketch) : null;
  const sketchTarget = sk
    ? { id: sk.id, name: `the area you marked (${sk.name})`, rect: sketch! }
    : null;

  for (const lex of LEXICON) {
    const idx = lex.words.map((w) => t.indexOf(` ${w}`)).filter((i) => i >= 0);
    if (idx.length === 0) continue;
    const at = Math.min(...idx);

    if (lex.scalar === "contaminant") {
      // smell goals: someone wants LESS smell somewhere. The protected room is
      // usually the one phrased as "my X" / "in X" / "out of X"; the source is a
      // smell-producing room named earlier (e.g. "kitchen smell").
      const negated = NEGATERS.some((n) => t.includes(n));
      const named = pickTargetRoom(t, rooms, at);
      const useSketch = sketchTarget && (deictic || !named);
      const target = useSketch ? sketchTarget : named;
      const source = rooms.find((r) => r.id !== target?.id && (r.type === "kitchen" || r.type === "bathroom")) ?? rooms.find((r) => r.id !== target?.id) ?? null;
      out.push({
        raw: text,
        scalar: "contaminant",
        direction: negated ? "low" : "low", // smell goals are virtually always "less"
        regionId: target?.id ?? null,
        regionName: target?.name ?? null,
        sourceId: source?.id ?? null,
        sourceName: source?.name ?? null,
        regionRect: useSketch ? sketch : null,
      });
    } else if (lex.scalar === "draft") {
      // draft goals usually point at a spot: an object ("on the bed"), the
      // sketched area, or a named room — in that priority order.
      const obj = objectRegion(t, plan);
      const named = nearestRoom(rooms, at) ?? rooms[0] ?? null;
      const useSketch = !obj && sketchTarget && (deictic || !named);
      const more = /\b(more|stronger|breezy|breezier)\b/.test(t) && !NEGATERS.some((n) => t.includes(n));
      out.push({
        raw: text,
        scalar: "draft",
        direction: more ? "high" : "low",
        regionId: obj ? obj.roomId : useSketch ? sketchTarget!.id : named?.id ?? null,
        regionName: obj ? obj.name : useSketch ? sketchTarget!.name : named?.name ?? null,
        regionRect: obj ? obj.rect : useSketch ? sketch : null,
      });
    } else {
      const named = nearestRoom(rooms, at) ?? rooms[0] ?? null;
      const useSketch = sketchTarget && (deictic || !named);
      if (!useSketch && rooms.length > 1 && CONJOINED.test(t)) {
        // "cool the living room AND the bedroom" is two goals, not one. Emitting
        // only the nearest room silently dropped the other one — the optimizer
        // then cooled a single room and the verdict reported success while the
        // other room was untouched.
        for (const r of rooms) {
          out.push({
            raw: text,
            scalar: "temperature",
            direction: lex.direction,
            regionId: r.id,
            regionName: r.name,
            regionRect: null,
          });
        }
        continue;
      }
      const region = useSketch ? sketchTarget : named;
      out.push({
        raw: text,
        scalar: "temperature",
        direction: lex.direction,
        regionId: region?.id ?? null,
        regionName: region?.name ?? null,
        regionRect: useSketch ? sketch : null,
      });
    }
  }

  // Nothing named a quantity — but the sentence may still have asked for one.
  // "Make the bed area nice to sleep" is a real wish with a real answer; it just
  // leaves the direction to the weather, which the task knows and the sentence
  // does not have to repeat.
  if (out.length === 0 && COMFORT_WORDS.some((w) => t.includes(` ${w} `))) {
    const obj = objectRegion(t, plan);
    const named = rooms[0] ?? null;
    const useSketch = !obj && sketchTarget && (deictic || !named);
    const region = obj
      ? { id: obj.roomId, name: obj.name, rect: obj.rect }
      : useSketch
        ? { id: sketchTarget!.id, name: sketchTarget!.name, rect: sketch! }
        : named
          ? { id: named.id, name: named.name, rect: null }
          : plan.rooms.length === 1
            ? { id: plan.rooms[0].id, name: plan.rooms[0].name, rect: null }
            : null;
    const outdoor = opts.outdoorTemp;
    const scalar: Scalar =
      outdoor == null ? "contaminant" : outdoor >= COMFORT_HOT_C || outdoor <= COMFORT_COLD_C ? "temperature" : "contaminant";
    const direction: Direction = scalar === "temperature" && outdoor != null && outdoor <= COMFORT_COLD_C ? "high" : "low";
    out.push({
      raw: text,
      scalar,
      direction,
      regionId: region?.id ?? null,
      regionName: region?.name ?? null,
      regionRect: region?.rect ?? null,
    });
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
