// Making the seed dictionary survive contact with how people actually type.
//
// The parser matched raw substrings, so it read exactly one spelling of one
// wording and nothing else. "i want bedarea to be nice to sleep" — a real
// sentence from a real session — matched nothing at all: `bedarea` is not a
// word, and `nice to sleep` names no physical quantity. The lexicon was not
// wrong, it was brittle in three specific ways, and each has a cheap fix:
//
//   spelling   "stufy", "bedrom", "draught"     → near-miss matching
//   compounds  "bedarea", "livingroom"          → split against known words
//   apostrophes "it's", "don't", "isn't"        → expanded before matching
//
// What this deliberately does NOT do is guess. Every transformation here maps
// one string to another string already in the dictionary; nothing invents a
// goal. A sentence with no comfort wish in it still comes out empty, which is
// the honest answer and the one the panel now reports.

/** Levenshtein distance, bailing out as soon as it exceeds `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let best = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

/** Words that must never be corrected INTO a dictionary word.
 *
 *  "cook" is one edit from "cool", and "it gets stuffy after I cook" is a
 *  sentence people actually write — correcting it would turn a cooking smell
 *  into a request to cool the room. These are the near-misses that occur in
 *  this domain; the length floors below stop most of the rest. */
const NEVER_CORRECT = new Set([
  "cook", "cooking", "cooked", "look", "book", "took", "good", "food", "wood",
  "door", "doors", "room", "rooms", "roof", "floor", "cost", "most", "best",
  "rest", "west", "east", "want", "wall", "walls", "call", "fall", "tall",
  "well", "will", "wet", "bad", "bag", "big", "bit", "but", "old", "cat", "car",
  "hold", "cold" /* real word, already in the dictionary — never rewrite it */,
]);

/** One edit is allowed from this length up, two from the longer floor.
 *  Four-letter words are excluded entirely: at that length almost every English
 *  word is one edit from another one. */
const FUZZY_MIN_1 = 5;
const FUZZY_MIN_2 = 8;

const CONTRACTIONS: Array<[RegExp, string]> = [
  [/\bcan't\b/g, "can not"],
  [/\bwon't\b/g, "will not"],
  [/n['’]t\b/g, " not"],
  [/\bit['’]s\b/g, "it is"],
  [/\bi['’]m\b/g, "i am"],
  [/\bthat['’]s\b/g, "that is"],
  [/\bthere['’]s\b/g, "there is"],
  [/\bi['’]ve\b/g, "i have"],
  [/\bi['’]d\b/g, "i would"],
  [/['’]re\b/g, " are"],
  [/['’]ll\b/g, " will"],
];

export interface Vocabulary {
  /** Every single-token word the dictionary knows, canonical form. */
  words: Set<string>;
}

/**
 * Fold a typed sentence onto the dictionary's own spellings.
 *
 * Returns the sentence with each token replaced by the dictionary word it
 * plainly meant, space-padded so the existing ` word` substring matching keeps
 * working unchanged. Tokens the dictionary does not know are passed through
 * untouched — they may still be part of a multi-word phrase, or a room name.
 */
export function normalizeText(text: string, vocab: Vocabulary): string {
  let s = ` ${text.toLowerCase()} `;
  for (const [re, to] of CONTRACTIONS) s = s.replace(re, to);
  // Punctuation to spaces: "bedroom's", "cool!", "smell/odour" all tokenise.
  s = s.replace(/[^a-z0-9]+/g, " ");

  const out: string[] = [];
  for (const token of s.split(" ")) {
    if (!token) continue;
    if (vocab.words.has(token)) {
      out.push(token);
      continue;
    }
    // A glued compound: "bedarea" → "bed area", "livingroom" → "living room".
    // Both halves must be words the dictionary already knows, so this can only
    // ever produce a phrase it could already have read.
    const split = splitCompound(token, vocab);
    if (split) {
      out.push(split[0], split[1]);
      continue;
    }
    const near = nearestWord(token, vocab);
    out.push(near ?? token);
  }
  return ` ${out.join(" ")} `;
}

function splitCompound(token: string, vocab: Vocabulary): [string, string] | null {
  if (token.length < 6) return null;
  for (let i = 3; i <= token.length - 3; i++) {
    const a = token.slice(0, i);
    const b = token.slice(i);
    if (vocab.words.has(a) && vocab.words.has(b)) return [a, b];
  }
  return null;
}

function nearestWord(token: string, vocab: Vocabulary): string | null {
  if (token.length < FUZZY_MIN_1 || NEVER_CORRECT.has(token)) return null;
  const max = token.length >= FUZZY_MIN_2 ? 2 : 1;
  let best: string | null = null;
  let bestD = max + 1;
  for (const w of vocab.words) {
    if (w.length < FUZZY_MIN_1) continue; // never correct INTO a short word
    const d = editDistance(token, w, max);
    if (d < bestD) {
      bestD = d;
      best = w;
    }
  }
  return bestD <= max ? best : null;
}
