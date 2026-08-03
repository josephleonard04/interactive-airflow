import type { RGB } from "./temperature";
import { rgbCss } from "./temperature";

// Colour scale for the contaminant field — kitchen smell in one task, bathroom
// moisture in another.
//
// WHY THIS REPLACED A SINGLE-HUE WASH. The old ramp went light lavender → deep
// violet, skipped anything under 2 % of the peak, and passed the value through a
// square root first. Three consequences, all working against the task:
//
//  1. Clean air was not drawn at all. The whole point of opening the right
//     window is that fresh air arrives and the smell leaves — and the fresh air
//     was invisible, so half of what the participant had just achieved simply
//     was not on screen.
//  2. The square root lifted every small trace toward the middle of the ramp, so
//     a room with a faint haze everywhere looked much like a room with a real
//     problem. It flattened exactly the difference the task turns on.
//  3. One hue means the eye is comparing lightness alone, which is the weakest
//     comparison it makes across a large area.
//
// So: two ends that are obviously different things — fresh air is a cool mint,
// the smell is a saturated magenta — and an S-curve instead of a square root, so
// nearly-clean reads as clean, the source stays vivid, and the middle is where
// the contrast is spent. Moving the fan or opening the other window now changes
// the picture, not just its shade.

/**
 * The reading that counts as "full strength" — the top of the ramp.
 *
 * FIXED, not the current frame's peak. Normalizing against whatever the worst
 * patch happened to be meant the scale slid along with the room: ventilating the
 * studio dropped the smell over the bed from 0.44 to 0.21, but the peak fell
 * too, so the picture barely moved and the participant's best move looked like
 * their worst. Against a fixed reference the same change reads as 0.81 → 0.37 —
 * the whole floor greens out, which is what actually happened.
 *
 * 0.55 is measured: the column-averaged value directly over the source is 0.54
 * in the studio, 0.53 in the one-room flat and 0.58 in the bathroom, so one
 * constant serves all three and the source always sits at the magenta end.
 * Anything above clamps.
 */
export const SMELL_FULL_SCALE = 0.55;

/** Normalized concentration (0 = clean, 1 = full strength at the source). */
// THE FRESH END HAS TO BE A COLOUR, NOT AN ABSENCE. The first version put a soft
// mint at 0 and a near-white neutral a quarter of the way up, so clean air was
// almost the colour of the floor and there was no telling by eye whether a spot
// was fresh or merely unremarkable. Fresh air is now a vivid teal, and it holds
// its green well past the middle of the low half — the band from "swept clean"
// to "neither" is where a participant reads whether their window is working, so
// it gets real colour instead of a fade to grey.
const STOPS: Array<{ u: number; rgb: RGB }> = [
  { u: 0.0, rgb: { r: 0.0, g: 0.72, b: 0.56 } }, // vivid teal — swept clean
  { u: 0.14, rgb: { r: 0.24, g: 0.82, b: 0.66 } }, // green, unmistakably fresh
  { u: 0.3, rgb: { r: 0.58, g: 0.9, b: 0.8 } }, // mint
  { u: 0.42, rgb: { r: 0.85, g: 0.93, b: 0.92 } }, // pale — the turn
  { u: 0.5, rgb: { r: 0.93, g: 0.91, b: 0.94 } }, // neutral — neither
  { u: 0.62, rgb: { r: 0.8, g: 0.64, b: 0.94 } }, // light violet
  { u: 0.78, rgb: { r: 0.6, g: 0.31, b: 0.88 } }, // violet
  { u: 0.9, rgb: { r: 0.55, g: 0.11, b: 0.72 } }, // deep violet
  { u: 1.0, rgb: { r: 0.72, g: 0.03, b: 0.5 } }, // magenta — at the source
];

/** Smoothstep. Pushes faint traces toward clean and keeps the strong end strong,
 *  spending the ramp's contrast in the middle — which is where the difference
 *  between "the smell reaches the bed" and "it doesn't" actually lives. */
const scurve = (a: number) => a * a * (3 - 2 * a);

/** Colour for a contaminant reading, normalized against the strongest patch
 *  currently on screen. */
export function smellColor(normalized: number): RGB {
  const u = scurve(Math.max(0, Math.min(1, normalized)));
  if (u <= 0) return STOPS[0].rgb;
  const last = STOPS[STOPS.length - 1];
  if (u >= 1) return last.rgb;
  for (let i = 1; i < STOPS.length; i++) {
    const b = STOPS[i];
    if (u > b.u) continue;
    const a = STOPS[i - 1];
    const t = (u - a.u) / (b.u - a.u);
    return {
      r: a.rgb.r + (b.rgb.r - a.rgb.r) * t,
      g: a.rgb.g + (b.rgb.g - a.rgb.g) * t,
      b: a.rgb.b + (b.rgb.b - a.rgb.b) * t,
    };
  }
  return last.rgb;
}

/** The ramp as a CSS gradient, for the legend — same stops, so the legend and
 *  the 3D view cannot disagree. */
export function smellGradientCss(): string {
  return `linear-gradient(90deg,${STOPS.map((s) => `${rgbCss(s.rgb)} ${(s.u * 100).toFixed(0)}%`).join(",")})`;
}
