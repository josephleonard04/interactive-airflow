// Absolute-temperature colour scale.
//
// The field the solver produces is a DELTA from the outdoor baseline, which is
// what the visualization used to draw — normalized against whatever the run's
// own maximum happened to be. Two problems with that: a room sitting at the
// baseline had a delta of ~0 and was skipped entirely, so most of the house was
// simply not coloured; and because the scale was re-normalized every run, the
// same colour meant a different temperature each time.
//
// So: convert to absolute °C (outdoor + delta) and map it through a FIXED ramp
// anchored on human comfort. Every interior cell gets a colour, the legend can
// print real numbers, and blue always means the same temperature.

/** Ends of the scale. Anything outside is clamped to the end colour. */
export const TEMP_MIN_C = 12;
export const TEMP_MAX_C = 36;
/** Middle of the comfort band — where the ramp is neutral. */
export const TEMP_NEUTRAL_C = 24;

export interface RGB {
  r: number;
  g: number;
  b: number;
}

// Perceptually ordered stops: deep blue (cold) → light blue (cool) → warm-neutral
// (comfortable) → orange → deep red (hot). Distinct enough in lightness that the
// bands stay readable for colour-vision-deficient viewers and in greyscale.
// STEEP THROUGH THE MIDDLE, WHICH IS WHERE ROOMS ACTUALLY LIVE. The first
// version spread its colour evenly over 12–36 °C, so an ordinary winter home —
// a 17 °C bedroom next to a 23 °C living room, a 6 °C difference that is the
// whole task — came out as two shades of pale, and the heater itself, at ~27 °C,
// was a mild sand colour. Nothing looked hot because nothing in a heating
// problem ever reaches 32 °C.
//
// So the ramp is compressed onto 15–29 °C, where indoor air sits, and the ends
// are kept for the extremes. Every stop is also more saturated: the neutral is a
// light warm grey rather than near-white, so "comfortable" still reads as a
// colour and not as blank floor.
const STOPS: Array<{ c: number; rgb: RGB }> = [
  { c: 12, rgb: { r: 0.03, g: 0.07, b: 0.38 } }, // deep navy — coldest
  { c: 15, rgb: { r: 0.05, g: 0.24, b: 0.78 } }, // strong blue
  { c: 17.5, rgb: { r: 0.13, g: 0.47, b: 0.95 } }, // azure — a cold room
  { c: 20, rgb: { r: 0.42, g: 0.71, b: 0.99 } }, // mid blue — cool
  { c: 22, rgb: { r: 0.72, g: 0.87, b: 0.98 } }, // pale blue — slightly cool
  { c: 23.5, rgb: { r: 0.94, g: 0.92, b: 0.86 } }, // light warm grey — comfortable
  { c: 25, rgb: { r: 0.99, g: 0.83, b: 0.48 } }, // amber
  { c: 27, rgb: { r: 0.99, g: 0.60, b: 0.18 } }, // orange — a heater's air
  { c: 29, rgb: { r: 0.94, g: 0.31, b: 0.09 } }, // red
  { c: 32, rgb: { r: 0.83, g: 0.13, b: 0.07 } }, // strong red
  { c: 36, rgb: { r: 0.55, g: 0.02, b: 0.06 } }, // deep red — hottest
];

/** Colour for an absolute air temperature in °C. */
export function tempColor(celsius: number): RGB {
  if (celsius <= STOPS[0].c) return STOPS[0].rgb;
  const last = STOPS[STOPS.length - 1];
  if (celsius >= last.c) return last.rgb;
  for (let i = 1; i < STOPS.length; i++) {
    const b = STOPS[i];
    if (celsius > b.c) continue;
    const a = STOPS[i - 1];
    const t = (celsius - a.c) / (b.c - a.c);
    return {
      r: a.rgb.r + (b.rgb.r - a.rgb.r) * t,
      g: a.rgb.g + (b.rgb.g - a.rgb.g) * t,
      b: a.rgb.b + (b.rgb.b - a.rgb.b) * t,
    };
  }
  return last.rgb;
}

// ---------------------------------------------------------------- flow colour

/** Below this spread there is nothing to divide: everything is one temperature,
 *  and stretching a full blue→red ramp over the rounding noise would invent a
 *  hot end and a cold end that do not exist. */
export const FLOW_MIN_SPREAD_C = 2;

/** Diverging ramp for the airflow lines and dots, in normalized 0..1. */
const FLOW_STOPS: Array<{ u: number; rgb: RGB }> = [
  { u: 0.0, rgb: { r: 0.04, g: 0.25, b: 0.95 } }, // full blue — the coldest air here
  { u: 0.22, rgb: { r: 0.31, g: 0.63, b: 0.99 } },
  { u: 0.42, rgb: { r: 0.73, g: 0.87, b: 0.99 } },
  { u: 0.5, rgb: { r: 0.95, g: 0.93, b: 0.89 } }, // mixed — neither, and it shows
  { u: 0.58, rgb: { r: 0.99, g: 0.85, b: 0.55 } },
  { u: 0.78, rgb: { r: 0.99, g: 0.52, b: 0.14 } },
  { u: 1.0, rgb: { r: 0.95, g: 0.09, b: 0.05 } }, // full red — the warmest air here
];

/**
 * Colour for the air a streamline or dot is carrying, scaled to THIS home's own
 * hot and cold ends rather than to the absolute comfort ramp.
 *
 * The absolute ramp cannot do this job. In a winter task the whole house lives
 * between about 8 °C and 27 °C, which on a scale built for comfort is pale blue
 * at one end and mild sand at the other — so the air leaving the heater looked
 * almost the same as the air in the middle of the room, and no line was ever
 * red. The question these lines answer is "where does the warm air go, and where
 * does the cold come in", and that question is about the extremes present right
 * now: the heater's own air should read hot, the draught off the glass should
 * read cold, and everything between them should show the mixing.
 *
 * `lo`/`mid`/`hi` are the coldest, mean and warmest interior air in the current
 * solution. The outer twentieth of each half is saturated, so air AT a device
 * reads as that device rather than as most of the way toward it.
 *
 * Below `FLOW_MIN_SPREAD_C` of spread it defers to the absolute ramp: with no
 * heater and no open window there is no story to tell, and a rainbow over a
 * half-degree of drift would be a lie.
 */
export function flowColor(celsius: number, lo: number, mid: number, hi: number): RGB {
  if (!(hi - lo > FLOW_MIN_SPREAD_C)) return tempColor(celsius);
  // TWO HALVES, STRETCHED SEPARATELY. Scaling linearly from the coldest to the
  // warmest air put 95 % of the lines in the red half — in a heated home almost
  // every cell is warm compared with the one cold patch at the glass, so the
  // midpoint of the extremes is nowhere near the middle of the air. Anchoring
  // the pale centre on the home's MEAN air instead makes the colour say what it
  // should: warmer than this room is warm, colder is cold.
  const warmer = celsius >= mid;
  const reach = warmer ? hi - mid : mid - lo;
  const raw =
    reach <= 1e-6
      ? 0.5
      : warmer
        ? 0.5 + 0.5 * ((celsius - mid) / reach)
        : 0.5 - 0.5 * ((mid - celsius) / reach);
  // Saturate the outer tenth of each half, so air AT a device reads as that
  // device rather than as most of the way toward it.
  const u = Math.max(0, Math.min(1, (raw - 0.05) / 0.9));
  if (u <= 0) return FLOW_STOPS[0].rgb;
  const last = FLOW_STOPS[FLOW_STOPS.length - 1];
  if (u >= 1) return last.rgb;
  for (let i = 1; i < FLOW_STOPS.length; i++) {
    const b = FLOW_STOPS[i];
    if (u > b.u) continue;
    const a = FLOW_STOPS[i - 1];
    const t = (u - a.u) / (b.u - a.u);
    return {
      r: a.rgb.r + (b.rgb.r - a.rgb.r) * t,
      g: a.rgb.g + (b.rgb.g - a.rgb.g) * t,
      b: a.rgb.b + (b.rgb.b - a.rgb.b) * t,
    };
  }
  return last.rgb;
}

/** The flow ramp as a CSS gradient, for the airflow legend. */
export function flowGradientCss(): string {
  return `linear-gradient(90deg,${FLOW_STOPS.map((s) => `${rgbCss(s.rgb)} ${(s.u * 100).toFixed(0)}%`).join(",")})`;
}

const hex = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
export const rgbCss = ({ r, g, b }: RGB) => `rgb(${hex(r)},${hex(g)},${hex(b)})`;

/** The ramp as a CSS gradient, for the legend — same stops, so the legend and
 *  the 3D view cannot disagree. */
export function tempGradientCss(): string {
  const span = TEMP_MAX_C - TEMP_MIN_C;
  const parts = STOPS.map((s) => `${rgbCss(s.rgb)} ${(((s.c - TEMP_MIN_C) / span) * 100).toFixed(1)}%`);
  return `linear-gradient(90deg,${parts.join(",")})`;
}

/** Plain-language band for a temperature, for the per-room readout. */
export function tempLabel(celsius: number): string {
  if (celsius < 16) return "cold";
  if (celsius < 20) return "cool";
  if (celsius < 22.5) return "slightly cool";
  if (celsius <= 25.5) return "comfortable";
  if (celsius <= 28) return "slightly warm";
  if (celsius <= 32) return "warm";
  return "hot";
}
