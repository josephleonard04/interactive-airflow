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
const STOPS: Array<{ c: number; rgb: RGB }> = [
  { c: 12, rgb: { r: 0.05, g: 0.11, b: 0.45 } }, // deep navy — coldest
  { c: 16, rgb: { r: 0.11, g: 0.34, b: 0.78 } }, // strong blue
  { c: 19, rgb: { r: 0.29, g: 0.60, b: 0.92 } }, // mid blue
  { c: 21.5, rgb: { r: 0.60, g: 0.82, b: 0.97 } }, // light blue — cool
  { c: 24, rgb: { r: 0.95, g: 0.95, b: 0.90 } }, // near-neutral — comfortable
  { c: 26.5, rgb: { r: 0.98, g: 0.78, b: 0.47 } }, // warm sand
  { c: 29, rgb: { r: 0.96, g: 0.55, b: 0.24 } }, // orange
  { c: 32, rgb: { r: 0.87, g: 0.28, b: 0.13 } }, // strong orange-red
  { c: 36, rgb: { r: 0.60, g: 0.05, b: 0.09 } }, // deep red — hottest
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
