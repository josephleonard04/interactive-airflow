import type { ScenarioId } from "../floorplan/scenarios";
import type { FloorPlan, Rect } from "../floorplan/types";
import {
  DRY_UNVENTILATED,
  REPORT_FIDELITY,
  buildSim3D,
  geodesicFields,
  roomMeans,
  slowestDry,
  zoneMean,
  zoneSpeed,
} from "../sim/sim3d";
import { itemZone } from "./goals";

// WHAT THE PARTICIPANT ACTUALLY CHANGED, measured on the home as delivered and
// again on the home as submitted.
//
// This replaces the hidden tick-list. A scored goal answers "did they pass?",
// which is a question about a threshold somebody chose — move the threshold and
// the same session flips from success to failure. It also flattens everything
// interesting: a participant who takes a freezing bedroom from 9 °C to 17 °C
// and one who leaves it at 9 °C both "fail" an 18 °C box, and the file cannot
// tell them apart.
//
// An improvement has no threshold in it. Initial 9 °C, final 17 °C, +8 °C is
// the finding, and it stays the finding whatever anyone later decides "warm
// enough" means.
//
// EACH TASK IS A DIFFERENT PHYSICAL QUANTITY, so there is no single number
// across all four and this file does not invent one. Winter is degrees; the
// apartment is degrees AND air speed at the bed, because cooling the rooms by
// blasting the sleeper is not success; the studio is odour at the bed; the
// bathroom is how long the slowest corner stays wet.
//
// Measured with the same solve, grid and transport the Temp and air-quality
// views draw (REPORT_FIDELITY), so a reported improvement and the picture the
// participant was looking at cannot disagree.

/** Which direction counts as better. `improvement` is always positive-is-better. */
export type BetterWhen = "higher" | "lower";

export interface OutcomeMeasure {
  id: string;
  /** For a person reading the file, not for the participant — never shown. */
  label: string;
  unit: string;
  betterWhen: BetterWhen;
  /**
   * Whether a percentage change is meaningful.
   *
   * FALSE FOR TEMPERATURE IN °C. Celsius is an interval scale with an arbitrary
   * zero, so "40% warmer" is not a statement about the world — 10 °C to 14 °C
   * and −5 °C to −1 °C are the same physical change and would report wildly
   * different percentages. Odour, air speed and minutes are ratio scales with a
   * real zero, where a percentage does mean something.
   */
  ratioScale: boolean;
  /**
   * A reading at or above this is CENSORED: the quantity ran off the end of
   * what the model resolves. The value is CLAMPED here and flagged, so what the
   * file carries is a bound you can subtract rather than either a sentinel or a
   * hole. Carried rather than discarded, because the bathroom as delivered is
   * exactly that case — the slowest corner never dries — and dropping it would
   * leave the one task whose baseline matters most with no baseline at all.
   */
  censoredAtOrAbove?: number;
  read: (ctx: MeasureContext) => number | null;
}

interface MeasureContext {
  plan: FloorPlan;
  outdoorTemp: number;
  built: ReturnType<typeof buildSim3D>;
  fields: ReturnType<typeof geodesicFields>;
}

export interface OutcomeReading {
  id: string;
  label: string;
  unit: string;
  betterWhen: BetterWhen;
  ratioScale: boolean;
  /** null when the home no longer contains what the measure reads. */
  value: number | null;
  /** True when the reading is a bound rather than a measurement — see
   *  `censoredAtOrAbove`. */
  censored: boolean;
}

export interface OutcomeDelta extends Omit<OutcomeReading, "value"> {
  initial: number | null;
  final: number | null;
  /** Positive means better, whichever direction this measure runs in. */
  improvement: number | null;
  /** Only on ratio scales — see `ratioScale`. */
  percentImprovement: number | null;
  /** True when either end was censored, so the improvement is a LOWER BOUND:
   *  the participant did at least this much, possibly more. */
  improvementIsLowerBound: boolean;
}

// --- the measures ----------------------------------------------------------

/** Room mean temperature in °C. The solver carries a delta from outdoors. */
const roomTemperature = (roomId: string, label: string, betterWhen: BetterWhen): OutcomeMeasure => ({
  id: `${roomId}_temperature`,
  label,
  unit: "°C",
  betterWhen,
  ratioScale: false,
  read: ({ built, fields, outdoorTemp }) => {
    const delta = roomMeans(built, fields.temp).get(roomId);
    return delta === undefined ? null : Number((outdoorTemp + delta).toFixed(2));
  },
});

/** Air speed over an item's footprint — "is it blowing on the bed". */
const itemAirflow = (itemType: string, label: string): OutcomeMeasure => ({
  id: `${itemType}_airflow`,
  label,
  unit: "m/s",
  betterWhen: "lower",
  ratioScale: true,
  read: ({ plan, built }) => {
    const zone = itemZone(plan, itemType);
    const v = zone ? zoneSpeed(built, zone) : null;
    return v === null ? null : Number(v.toFixed(4));
  },
});

/** Contaminant concentration over an item's footprint, 0..1. */
const itemOdor = (itemType: string, label: string): OutcomeMeasure => ({
  id: `${itemType}_odor`,
  label,
  unit: "concentration (0-1)",
  betterWhen: "lower",
  ratioScale: true,
  read: ({ plan, built, fields }) => {
    const zone = itemZone(plan, itemType);
    const v = zone ? zoneMean(built, fields.smell, zone) : null;
    return v === null ? null : Number(v.toFixed(4));
  },
});

/**
 * Minutes for the slowest corner of a room to dry.
 *
 * The brief asks how FAST the bathroom dries, which would ideally be a rate in
 * RH points per minute. The solver does not produce a humidity curve over time
 * — it produces a time-to-dry per cell — so a "% RH / min" figure would be
 * invented units dressed as a measurement. Minutes is the quantity that exists,
 * it answers the same question (lower is faster, and `improvement` is minutes
 * saved), and it is what the bathroom view already draws.
 */
const dryingMinutes = (roomId: string, label: string): OutcomeMeasure => ({
  id: `${roomId}_drying_time`,
  label,
  unit: "min",
  betterWhen: "lower",
  ratioScale: true,
  // The bathroom as delivered does not dry at all: shut, its slowest corner is
  // never reached by fresh air and the solver returns the DRY_NEVER sentinel.
  //
  // CENSOR AT THE LONGEST FINITE TIME, not at the sentinel. Differencing 999
  // gives "at least 901 minutes faster", which reads as though somebody timed a
  // sixteen-hour bathroom — the 999 is a flag, not a duration. Clamped to
  // DRY_UNVENTILATED the same session reports "at least 82 minutes faster",
  // which is both true (the real baseline is worse than 180, so the real saving
  // is larger) and a number that means what it says.
  censoredAtOrAbove: DRY_UNVENTILATED,
  read: ({ plan, built, fields }) => {
    const rect: Rect | undefined = plan.rooms.find((r) => r.id === roomId)?.rect;
    if (!rect) return null;
    return Number(slowestDry(built, fields.dry, rect).toFixed(1));
  },
});

/**
 * What each task is actually about.
 *
 * The scenario ids do not match their subjects and never have: `summer` is the
 * STUDIO ODOUR task and `smell` is the APARTMENT AC/DRAFT task. Renaming them
 * would invalidate every session file already collected, so they are left alone
 * and the mapping is written down here instead.
 */
export const SCENARIO_OUTCOMES: Record<ScenarioId, OutcomeMeasure[]> = {
  // Warm both rooms in winter. Higher is better.
  winter: [
    roomTemperature("living", "Living room temperature", "higher"),
    roomTemperature("bedroom", "Bedroom temperature", "higher"),
  ],

  // Studio, kitchen bin: keep the smell off the bed. The whole-studio mean
  // cannot tell the sleeping end from the cooking end, so the bed's own
  // footprint is the outcome.
  summer: [itemOdor("bed", "Odour at the bed")],

  // Bathroom: dry out quickly after a shower.
  humidity: [dryingMinutes("bathroom", "Time for the slowest corner to dry")],

  // Apartment, AC bolted above the bed: cool both rooms WITHOUT blowing on the
  // sleeper. Two of these three can be satisfied by making the third worse,
  // which is exactly why all three are reported and none is averaged away.
  smell: [
    roomTemperature("living", "Living room temperature", "lower"),
    roomTemperature("bedroom", "Bedroom temperature", "lower"),
    itemAirflow("bed", "Air speed over the bed"),
  ],
};

// --- measuring --------------------------------------------------------------

/** One solve serves every measure in the task, exactly as checkGoals does. */
export function measureOutcomes(scenarioId: ScenarioId, plan: FloorPlan, outdoorTemp: number): OutcomeReading[] {
  const measures = SCENARIO_OUTCOMES[scenarioId] ?? [];
  if (!measures.length) return [];

  const built = buildSim3D(plan, {
    targetCells: REPORT_FIDELITY.targetCells,
    iterations: REPORT_FIDELITY.iterations,
    openingDriveDT: Math.abs(outdoorTemp - 21),
  });
  for (let s = 0; s < REPORT_FIDELITY.steps; s++) built.sim.step(0.05);
  const fields = geodesicFields(built);
  const ctx: MeasureContext = { plan, outdoorTemp, built, fields };

  return measures.map((m) => {
    const raw = m.read(ctx);
    const censored = raw !== null && m.censoredAtOrAbove !== undefined && raw >= m.censoredAtOrAbove;
    return {
      id: m.id,
      label: m.label,
      unit: m.unit,
      betterWhen: m.betterWhen,
      ratioScale: m.ratioScale,
      // Clamped, so nothing downstream ever subtracts a sentinel.
      value: censored ? m.censoredAtOrAbove! : raw,
      censored,
    };
  });
}

/** Pair the two passes up. Anything unmeasurable in either pass stays null. */
export function compareOutcomes(initial: OutcomeReading[], final: OutcomeReading[]): OutcomeDelta[] {
  const finals = new Map(final.map((r) => [r.id, r]));

  return initial.map((before) => {
    const after = finals.get(before.id);
    const a = before.value;
    const b = after?.value ?? null;
    const improvement =
      a === null || b === null ? null : Number((before.betterWhen === "higher" ? b - a : a - b).toFixed(3));
    const improvementIsLowerBound = Boolean(before.censored || after?.censored);
    // A percentage of zero is not a percentage, a percentage of degrees is not
    // a quantity (see `ratioScale`), and a percentage of a censored bound is
    // not a percentage of anything.
    const percentImprovement =
      improvement === null || !before.ratioScale || a === null || a === 0 || improvementIsLowerBound
        ? null
        : Number(((improvement / Math.abs(a)) * 100).toFixed(1));

    return { ...before, initial: a, final: b, improvement, percentImprovement, improvementIsLowerBound };
  });
}

/**
 * One line per task, for a spreadsheet column — the summary the brief asks for
 * where there is an honest one, and null where there is not.
 *
 * Winter averages its two rooms because the task is "both rooms warm" and the
 * two are the same quantity in the same direction. The apartment does NOT get a
 * mean: averaging degrees with metres per second is arithmetic on unlike units,
 * and averaging away the draft is averaging away the point of the task.
 */
export function summarizeOutcomes(
  scenarioId: ScenarioId,
  deltas: OutcomeDelta[],
): { label: string; value: number; unit: string } | null {
  const got = (id: string) => deltas.find((d) => d.id === id)?.improvement ?? null;

  if (scenarioId === "winter") {
    const living = got("living_temperature");
    const bedroom = got("bedroom_temperature");
    if (living === null || bedroom === null) return null;
    return { label: "Mean warming across both rooms", value: Number(((living + bedroom) / 2).toFixed(2)), unit: "°C" };
  }

  if (scenarioId === "summer") {
    const pct = deltas.find((d) => d.id === "bed_odor")?.percentImprovement ?? null;
    return pct === null ? null : { label: "Odour reduction at the bed", value: pct, unit: "%" };
  }

  if (scenarioId === "humidity") {
    const d = deltas.find((x) => x.id === "bathroom_drying_time");
    if (!d || d.improvement === null) return null;
    return {
      // The delivered bathroom does not dry, so this is almost always a lower
      // bound, and the label says so rather than leaving it in a flag someone
      // reading a spreadsheet column will not see.
      label: d.improvementIsLowerBound ? "Dries faster by (at least)" : "Dries faster by",
      value: d.improvement,
      unit: "min",
    };
  }

  return null;
}
