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

/** Ends of the scale. Anything outside is clamped to the end colour.
 *
 *  THE SCALE HAS TO END WHERE INDOOR AIR ENDS. Reserving red for 36 °C meant
 *  nothing in a heating task was ever red: measured on the winter home, the
 *  hottest air in the house — the heater's own — is 26.5 °C, which on a 12–36
 *  ramp is a mild orange. The air was doing the right thing and the picture
 *  refused to say so. Room air in these tasks runs from a cold pane at ~8 °C to
 *  a heatwave studio at ~31 °C, so that is what the ramp now spends its colour
 *  on, and 32 °C+ clamps to the deepest red. */
export const TEMP_MIN_C = 10;
export const TEMP_MAX_C = 32;
/** Middle of the comfort band — where the ramp is neutral. */
export const TEMP_NEUTRAL_C = 22;

export interface RGB {
  r: number;
  g: number;
  b: number;
}

const STOPS: Array<{ c: number; rgb: RGB }> = [
  // THERMOGRAPHIC, like a thermal camera: blue is cold, red is hot, and cyan,
  // green and yellow fill the middle. The earlier ramp faded to a pale grey in
  // the comfort band, which read as "blank floor" and could not share a legend
  // with the streamlines. Asked for by Igarashi so the airflow and temperature
  // views speak one colour language; comfortable air (22 °C) is now green.
  { c: 10, rgb: { r: 0.05, g: 0.05, b: 0.55 } }, // deep blue — a freezing pane
  { c: 14, rgb: { r: 0.0, g: 0.3, b: 1.0 } }, // blue — a cold room
  { c: 18, rgb: { r: 0.0, g: 0.78, b: 1.0 } }, // cyan — too cool to sit in
  { c: 22, rgb: { r: 0.2, g: 0.85, b: 0.25 } }, // green — comfortable
  { c: 25, rgb: { r: 1.0, g: 0.9, b: 0.1 } }, // yellow — warm
  { c: 28, rgb: { r: 1.0, g: 0.5, b: 0.0 } }, // orange — a heater's own air
  { c: 32, rgb: { r: 0.85, g: 0.05, b: 0.05 } }, // red — a heatwave room
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
  // The same thermographic family as the Temperature view (see STOPS): the
  // coldest air in this home is blue, the warmest red, and the mixing between
  // them passes through cyan, green and yellow rather than fading to grey.
  { u: 0.0, rgb: { r: 0.0, g: 0.25, b: 1.0 } }, // blue — the coldest air here
  { u: 0.25, rgb: { r: 0.0, g: 0.78, b: 1.0 } }, // cyan
  { u: 0.5, rgb: { r: 0.2, g: 0.85, b: 0.25 } }, // green — mixed room air
  { u: 0.75, rgb: { r: 1.0, g: 0.88, b: 0.1 } }, // yellow
  { u: 1.0, rgb: { r: 0.9, g: 0.08, b: 0.05 } }, // red — the warmest air here
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
