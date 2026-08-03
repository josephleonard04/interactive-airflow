import type { FloorPlan, Rect, RoomType } from "../floorplan/types";
import { normalizeText, type Vocabulary } from "./normalize";

// Intent → physics: translate a non-expert's everyday comfort goal ("keep my
// bedroom cool", "no kitchen smell in the bedroom") into a small, fixed set of
// physical objectives the simulation can evaluate. This is the seed dictionary
// described in docs/contribution-positioning.md §2 — the model in llmGoal.ts
// generalizes beyond it, but every objective from either route stays in this
// vocabulary so it is always checkable against the solver.

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
// THE DICTIONARY IS THE FAST PATH, AND THE ONLY ONE THAT ALWAYS WORKS. A model
// now sits behind it (llmGoal.ts) for wording this cannot match, but it needs a
// backend, a credential and a network — none of which a study session on a
// borrowed laptop is guaranteed to have. So a word missing here still costs a
// round trip at best and a shrug at worst, and the lists below stay deliberately
// over-inclusive: every way this project's four problems get described — heat,
// cold, smell, stale air, damp, draught — plus the devices, rooms and objects
// they get described in terms of.

/** Which sensation a temperature word NAMES — not which direction it asks for.
 *  "hot" and "cool" both name a temperature; whether the person wants more or
 *  less of it depends on whether they are describing a problem or a wish. */
type Sensation = "warmth" | "chill";

interface TempWord {
  words: string[];
  sensation: Sensation;
  /** True for words that can only ever be a complaint. Nobody asks a room to be
   *  sweltering or freezing; naming one always means "fix this". */
  alwaysComplaint?: boolean;
}

/**
 * COMPLAINT OR WISH — the distinction the old dictionary did not make, and the
 * reason it read every one of these backwards:
 *
 *     "my room is much colder than the rest"   → asked for it to be COLDER
 *     "the bedroom is too cold"                → colder
 *     "it's freezing in here"                  → colder
 *     "it gets so hot in the afternoon"        → hotter
 *
 * Each names the PROBLEM, and the old lexicon mapped the problem word straight
 * to a goal — so the optimizer went looking for a layout that made the cold
 * bedroom colder, confidently and silently. The first of those four is the one
 * real participant sentence we have.
 *
 * A word preceded by a complaint marker ("it is", "gets", "too", "way") is
 * describing what is wrong, and the goal is its OPPOSITE. A word preceded by a
 * wish marker ("keep", "make", "I want") is the goal itself. Wish wins when both
 * appear, because "I want it less cold" is a wish about a complaint.
 */
const TEMP_WORDS: TempWord[] = [
  {
    sensation: "warmth",
    words: [
      "warm", "warmer", "warmth", "warming", "hot", "hotter", "heat", "heated",
      "heating", "heater", "radiator", "cozy", "cosy", "toasty", "snug",
    ],
  },
  {
    sensation: "warmth",
    alwaysComplaint: true,
    words: [
      "boiling", "roasting", "baking", "sweltering", "scorching", "stifling",
      "muggy", "sweaty", "sweating", "overheating", "overheated", "humid",
      "sauna", "oven", "furnace", "tropical", "burning", "blazing",
    ],
  },
  {
    sensation: "chill",
    words: [
      "cool", "cooler", "cooling", "cold", "colder", "chilly", "chill",
      "aircon", "airconditioning", "airconditioner", "conditioner", "conditioning",
      "refreshing",
    ],
  },
  {
    sensation: "chill",
    alwaysComplaint: true,
    words: ["freezing", "frigid", "icy", "nippy", "frosty", "arctic", "shivering", "shiver"],
  },
];

/** Everything whose direction does not depend on framing. A smell is never
 *  wanted and a draught on your face is never asked for, so these map straight
 *  through however they are phrased. */
const LEXICON: Array<{ words: string[]; scalar: Scalar; direction: Direction }> = [
  {
    // The complaint: something in here smells.
    words: [
      "smell", "smells", "smelly", "smelling", "odor", "odour", "odors",
      "odours", "stink", "stinks", "stinky", "stench", "reek", "reeks",
      "reeking", "whiff", "pong", "fume", "fumes", "smoke", "smoky", "rotten",
      "rotting", "rancid", "garbage", "rubbish", "trash", "waste", "sewage",
      "drains", "cooking",
    ],
    scalar: "contaminant",
    direction: "low",
  },
  {
    // The wish, said from the other end: I want the air in here exchanged.
    // Same objective — one names what is wrong, the other what is wanted.
    words: [
      "fresh", "freshen", "freshening", "stuffy", "stale", "airless", "musty",
      "fusty", "ventilate", "ventilation", "ventilated", "airy", "breathe",
      "breathing", "breathable", "circulate", "circulation", "circulating",
      "suffocating", "sticky", "clammy",
    ],
    scalar: "contaminant",
    direction: "low",
  },
  {
    // Damp is the same field: moisture the airflow has to carry out.
    //
    // "dry this room" read as nothing at all, because `dry` was listed as an
    // ordinary word to protect it from spelling repair and never as a goal —
    // so the one verb people reach for first in a bathroom was the one word
    // the dictionary would not act on. The mould words are here for the same
    // reason: nobody says "reduce the contaminant", they say the wall is going
    // black.
    words: [
      "damp", "dampness", "moisture", "moist", "condensation", "condensating",
      "mould", "mold", "mouldy", "moldy", "mildew", "soggy", "sodden",
      "drying", "dries", "dried", "dry", "drier", "dryer", "steamy", "steam",
      "steaming", "sweating", "humidity", "wet", "wetness", "wetter", "clammy",
      "black", "blackening", "blotch", "blotches", "stain", "stains",
      "stained", "staining", "peeling", "flaking", "spores", "musty",
    ],
    scalar: "contaminant",
    direction: "low",
  },
  {
    // Air you can feel on you. "More breeze" is handled at the call site.
    words: [
      "draft", "drafty", "draught", "draughty", "breeze", "breezy", "blowing",
      "blow", "blows", "blown", "wind", "windy", "gust", "gusts", "gusty",
      "gale", "airflow",
    ],
    scalar: "draft",
    direction: "low",
  },
];

/** Said before a temperature word, these mark it as the PROBLEM. */
const COMPLAINT_MARKERS = [
  "too", "so", "very", "really", "extremely", "unbearably", "always", "still",
  "is", "was", "are", "were", "gets", "getting", "feels", "feeling", "seems",
  "keeps", "much", "way", "far", "bit", "quite", "super", "insanely",
  "ridiculously", "constantly",
];

/** Said before a temperature word, these mark it as the GOAL. Checked first —
 *  "I want it less cold" is a wish, not a complaint. */
const WISH_MARKERS = [
  "keep", "make", "makes", "want", "wants", "need", "needs", "get", "turn",
  "bring", "prefer", "like", "would", "please", "let", "have", "enough", "up",
  "down", "more", "stay", "staying", "remain", "warmer", "cooler",
];

/** "Get rid of this" — whatever framing follows, the sensation named is the
 *  thing to remove. "don't make it cold", "less heat", "without making it cold". */
const REMOVERS = [
  // "not" rather than "dont": the normalizer expands every n't contraction, so
  // "don't want it cold" arrives as "do not want it cold".
  "not", "dont", "stop", "avoid", "prevent", "without", "less", "reduce",
  "lower", "no", "rid",
];

/** Negates the PREDICATE rather than the situation: "never gets warm" is a
 *  complaint about the ABSENCE of warmth, so it cancels the complaint reading
 *  and lands back on wanting warmth. Distinct from REMOVERS, which negate the
 *  situation and do not compound with a complaint. */
const PREDICATE_NEGATERS = ["never", "isnt", "arent", "wasnt", "wont", "doesnt", "cant", "hardly", "barely"];

/** "Move air from the kitchen to the bedroom" is a request for MORE air
 *  movement, and the draught list reads every airflow word as a complaint —
 *  the one phrasing the sketch tool exists to express was the one the typed
 *  box could not read at all. These verbs, applied to air, always mean "get
 *  some of it moving", so they flip the draught goal's direction the way
 *  "more" and "stronger" already do. */
const MOVE_AIR = /\b(move|moving|bring|brings|bringing|push|pushing|send|sending|get|getting|carry|carrying|circulate|circulating|blow|blowing)\b[^.]{0,18}\b(air|breeze|draft|draught|airflow|wind)\b/;

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
  "nice", "nicer", "comfortable", "comfy", "comfort", "comfortably", "pleasant",
  "bearable", "liveable", "livable", "decent", "better", "sleep", "sleeping",
  "asleep", "rest", "resting", "relax", "relaxing", "nap", "napping",
  "unbearable", "uncomfortable", "horrible", "awful", "miserable",
];
/** At or above this outdoors, "make it comfortable" means cool it down. */
const COMFORT_HOT_C = 26;
/** At or below this, it means warm it up. */
const COMFORT_COLD_C = 16;

/** Every single word the dictionary knows, for spelling and compound repair. */
const VOCABULARY: Vocabulary = {
  words: new Set<string>([
    ...TEMP_WORDS.flatMap((t) => t.words),
    ...LEXICON.flatMap((l) => l.words),
    ...COMFORT_WORDS,
    ...COMPLAINT_MARKERS,
    ...WISH_MARKERS,
    ...REMOVERS,
    ...PREDICATE_NEGATERS,
    "bedroom", "bed", "kitchen", "living", "lounge", "bathroom", "bath",
    "toilet", "washroom", "studio", "apartment", "flat", "house", "home",
    "room", "rooms", "couch", "sofa", "desk", "table", "closet", "wardrobe",
    "pillow", "window", "windows", "door", "doors", "vent", "extract", "fan",
    "area", "spot", "zone", "corner", "region", "place", "side", "night",
    "morning", "afternoon", "evening", "summer", "winter", "here", "inside",
    "shower", "bin", "fridge", "sink", "stove", "air", "tub", "bath", "basin",
    "tile", "tiles", "ceiling", "wall", "corner", "patch", "mirror",
    // ORDINARY WORDS, LISTED SO THEY ARE LEFT ALONE. A word the dictionary does
    // not know gets spelling-repaired toward one it does, and at edit distance 1
    // that quietly turns ordinary English into a goal: "making" became "baking",
    // a heat complaint, so "without MAKING the bedroom cold" asked to cool it.
    // Anything in this set passes through untouched.
    "make", "makes", "making", "made", "want", "wants", "wanted", "wanting",
    "keep", "keeps", "keeping", "kept", "get", "gets", "getting", "got",
    "put", "putting", "take", "takes", "taking", "going", "doing", "being",
    "been", "have", "has", "had", "having", "will", "would", "could", "should",
    "please", "this", "that", "these", "those", "with", "from", "into", "onto",
    "over", "under", "near", "beside", "next", "some", "any", "every", "when",
    "while", "after", "before", "during", "because", "since", "then", "than",
    "they", "them", "their", "there", "what", "which", "where", "how", "why",
    "much", "many", "most", "same", "other", "another", "around", "through",
    "always", "night", "nights", "really", "little", "whole", "part", "side",
  ]),
};


/** Does this sentence want the OPPOSITE of the sensation the word names?
 *
 *  Four framings, in the order they are checked:
 *
 *    "warm enough"            → wish for more of it   (the `enough` idiom)
 *    "don't make it cold"     → remove it             (REMOVERS)
 *    "it gets too cold"       → complaint, so oppose  (COMPLAINT_MARKERS)
 *    "never gets warm"        → complaint of ABSENCE, so back to wanting it
 */
function wantsOpposite(text: string, at: number, word: string, entry: TempWord): boolean {
  const after = text.slice(at + word.length + 1).trim().split(/\s+/).slice(0, 2);
  // "warm enough" / "not warm enough" both ask for MORE warmth. The idiom
  // outranks everything else, including the negation sitting in front of it.
  if (after.includes("enough")) return false;

  // Eight, not five: "I do not want the room to be hot" puts the negation six
  // tokens back. Wide enough for a normal clause, short enough that a negation
  // about something else earlier in the sentence does not reach across.
  const before = text.slice(0, at).trim().split(/\s+/).slice(-8);
  if (before.some((w) => REMOVERS.includes(w))) return true;

  let complaint = entry.alwaysComplaint ?? false;
  if (!complaint) {
    // Nearest marker wins; a wish marker beats a complaint one at equal distance.
    for (let i = before.length - 1; i >= 0; i--) {
      if (WISH_MARKERS.includes(before[i])) break;
      if (COMPLAINT_MARKERS.includes(before[i])) {
        complaint = true;
        break;
      }
    }
  }
  if (before.some((w) => PREDICATE_NEGATERS.includes(w))) complaint = !complaint;
  return complaint;
}

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

  /** Emit a temperature objective for a word found at `at`, in `direction`.
   *  Compound goals ("cool the living room AND the bedroom") become one
   *  objective per room — emitting only the nearest silently dropped the other,
   *  and the verdict then reported success while half the home was untouched. */
  function emitTemperature(at: number, direction: Direction) {
    const named = nearestRoom(rooms, at) ?? rooms[0] ?? null;
    const useSketch = sketchTarget && (deictic || !named);
    if (!useSketch && rooms.length > 1 && CONJOINED.test(t)) {
      for (const r of rooms) {
        out.push({
          raw: text,
          scalar: "temperature",
          direction,
          regionId: r.id,
          regionName: r.name,
          regionRect: null,
        });
      }
      return;
    }
    const region = useSketch ? sketchTarget : named;
    out.push({
      raw: text,
      scalar: "temperature",
      direction,
      regionId: region?.id ?? null,
      regionName: region?.name ?? null,
      regionRect: useSketch ? sketch : null,
    });
  }

  // Temperature first, each word's direction decided from how it is framed.
  for (const entry of TEMP_WORDS) {
    const hits = entry.words
      .map((w) => ({ w, at: t.indexOf(` ${w}`) }))
      .filter((h) => h.at >= 0)
      .sort((a, b) => a.at - b.at);
    if (hits.length === 0) continue;
    const { w, at } = hits[0];
    // A complaint asks for the OPPOSITE of the sensation it names: "too hot"
    // wants cooling, "much colder than the rest" wants warming.
    const opposite = wantsOpposite(t, at, w, entry);
    const direction: Direction =
      entry.sensation === "warmth" ? (opposite ? "low" : "high") : opposite ? "high" : "low";
    emitTemperature(at, direction);
  }

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
      const more =
        (/\b(more|stronger|breezy|breezier)\b/.test(t) || MOVE_AIR.test(t)) &&
        !NEGATERS.some((n) => t.includes(n));
      out.push({
        raw: text,
        scalar: "draft",
        direction: more ? "high" : "low",
        regionId: obj ? obj.roomId : useSketch ? sketchTarget!.id : named?.id ?? null,
        regionName: obj ? obj.name : useSketch ? sketchTarget!.name : named?.name ?? null,
        regionRect: obj ? obj.rect : useSketch ? sketch : null,
      });
    }
  }

  // "MOVE AIR FROM THE KITCHEN TO THE BEDROOM" names no quantity at all — no
  // temperature, no smell, no draught — so every list above shrugs at it, and
  // it is one of the most natural things a person says about airflow. It is
  // also exactly what the sketch tool's arrow means, so the typed box was
  // refusing a request the drawn one accepts.
  //
  // The DESTINATION is the goal. "From the kitchen to the bedroom" wants air
  // arriving in the bedroom; grounding it to the kitchen would aim the fan at
  // the wrong end of the sentence, so the room introduced by "to" wins and the
  // last room named is the fallback.
  if (!out.some((o) => o.scalar === "draft") && MOVE_AIR.test(t)) {
    const dest = destinationRoom(t, rooms);
    const useSketch = sketchTarget && (deictic || !dest);
    out.push({
      raw: text,
      scalar: "draft",
      direction: "high",
      regionId: useSketch ? sketchTarget!.id : dest?.id ?? null,
      regionName: useSketch ? sketchTarget!.name : dest?.name ?? null,
      regionRect: useSketch ? sketch : null,
    });
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

/** The room a "move air to X" sentence is aiming AT. Prefers the room right
 *  after "to"/"into"/"toward", then the last room named — a sentence that
 *  mentions two rooms is almost always naming the source first. */
function destinationRoom(
  t: string,
  rooms: Array<{ id: string; name: string; type: RoomType; at: number }>,
) {
  if (rooms.length === 0) return null;
  for (const cue of [" to ", " into ", " toward ", " towards ", " over to "]) {
    let from = 0;
    for (;;) {
      const i = t.indexOf(cue, from);
      if (i < 0) break;
      const after = i + cue.length;
      const r = rooms.find((rm) => rm.at >= after - 1 && rm.at <= after + 14);
      if (r) return r;
      from = i + cue.length;
    }
  }
  return rooms[rooms.length - 1];
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
