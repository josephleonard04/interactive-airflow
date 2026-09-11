import type { Rect } from "../floorplan/types";
import { SMELL_FULL_SCALE } from "../viz/smell";
import type { Sim3D } from "./sim3d";

// RELATIVE HUMIDITY, READ OFF THE MOISTURE FIELD.
//
// The bathroom task used to be scored in minutes-to-dry. The brief it now
// answers is "reduce the humidity", and the quantity a person reads off a
// hygrometer — and the one the study reports — is % RH.
//
// What this is and is not. The solver carries moisture as a steady-state
// concentration field: the shower, the bath and the damp corner emit it, and
// the extract and any open window carry it away (the same field the Humidity
// view draws). It does not solve psychrometrics — there is no water-vapour
// mass balance and no temperature-dependent saturation. So RH here is a
// MAPPING of that field onto the percent scale, anchored at both ends:
//
//   - air the moisture never reaches sits at RH_BACKGROUND, the room's air on
//     a humid summer day before anyone showers;
//   - the more moisture a spot carries, the closer it gets to saturation, and
//     it approaches 100 % without passing it (1 - e^(-m/k)), because air that
//     is already saturated condenses rather than getting wetter.
//
// Measured on the bathroom task, the room mean reads about 92 % as delivered
// (sealed, steam trapped), about 91 % with the window merely opened, and about
// 76 % with the extract across the room from the window. Treat the absolute
// numbers as calibrated estimates; the DIFFERENCES between arrangements are
// what the model resolves, and they are the study's outcome.

/** RH of room air the moisture never reaches — a humid summer day. */
export const RH_BACKGROUND = 55;
/** Saturation. Air past this condenses on the coldest surface instead. */
export const RH_SATURATED = 100;
/** How much moisture (on the Humidity view's own 0–1 scale) takes the air most
 *  of the way to saturation. At the source (≥ 1) a spot reads ~92 %; at a
 *  quarter of that, ~68 %. */
const RH_SCALE = 0.7;

/** % RH for a moisture concentration from the solver's field. */
export function rhOf(moisture: number): number {
  const m = Math.max(0, moisture) / SMELL_FULL_SCALE;
  return RH_BACKGROUND + (RH_SATURATED - RH_BACKGROUND) * (1 - Math.exp(-m / RH_SCALE));
}

/** Mean % RH over the occupied height (floor to 2 m) of one rectangle.
 *
 *  The MEAN, because that is what a hygrometer on the wall reads and what "the
 *  bathroom is at 80 %" means. The ceiling void is excluded for the same reason
 *  it is everywhere else: steam pools up there in every arrangement and nothing
 *  anyone cares about lives in it. Null when the rectangle holds no air. */
export function meanRH(s: Sim3D, moisture: Float32Array, rect: Rect): number | null {
  const { sim, nx, ny, nz, cellCenter, inside } = s;
  let sum = 0;
  let n = 0;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = sim.cIdx(i, j, k);
        if (sim.solid[c] || !inside[c]) continue;
        const [x, y, z] = cellCenter(i, j, k);
        if (y > 2.0) continue;
        if (x < rect.x || x > rect.x + rect.w || z < rect.z || z > rect.z + rect.d) continue;
        sum += rhOf(moisture[c]);
        n++;
      }
  return n ? sum / n : null;
}

/** Swatch colour for an RH reading: dry sand at the background level, through
 *  to a wet blue-grey at saturation — the same direction as the Humidity view. */
export function rhSwatch(rh: number): string {
  const t = Math.min(1, Math.max(0, (rh - RH_BACKGROUND) / (RH_SATURATED - RH_BACKGROUND)));
  const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
  return `rgb(${mix(236, 96)},${mix(214, 130)},${mix(160, 168)})`;
}
