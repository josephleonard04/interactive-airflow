import type { ItemCategory, Mount, Vec3 } from "./types";

// Items the user can add from the palette. Sizes are [width-along-wall, height,
// depth-into-room]. Drives the add-furniture UI and the defaults used when an
// item is created.

export interface ItemSpec {
  size: Vec3;
  category: ItemCategory;
  mount: Mount;
  flow?: number;
  label: string;
}

/** Ventilation louvre: ~150 mm grille in its wall recess. Shared by the palette
 *  and the example home so both create the same unit. */
export const VENT_SIZE: Vec3 = [0.3, 0.3, 0.12];
/** Default per-vent flux (m³/s). The example home overrides this with a value
 *  derived from the actual house volume; this is the standalone-drop default. */
export const VENT_FLOW = 0.012;
/** Vents sit just under the ceiling, like a real 給気口. */
export const ventMountY = (wallHeight: number) => wallHeight - 0.35;

/** What a thermostat arrives set to, and the range the panel offers. An air
 *  conditioner and a heater are both set to a TEMPERATURE rather than to a
 *  power level — see PlacedItem.setpoint. The study scenarios fix their units
 *  deliberately and carry no setpoint, so none of this reaches them.
 *
 *  The AC default sits just under the free-play outdoor temperature (see
 *  FREE_PLAY_OUTDOOR_C): at 24 on a 22-degree day the unit that arrives running
 *  would have nothing to do, the Temperature view would read flat, and the home
 *  would look broken before anyone touched it. */
/** The weather a free-play home starts in: a mild day, not a heatwave.
 *
 *  It used to start at 30, which is the day the study's cooling scenarios are
 *  set on -- and that is the point: those tasks are ABOUT a hot day, and they
 *  set their own weather when they start (see startScenario). The example home
 *  is where someone tries things out, and on a 30-degree day every question
 *  there has the same answer, which is more cooling. At 22 both directions are
 *  live: a room can want warming or cooling, and the difference between a
 *  setting of 19 and one of 25 is something a person can feel. */
export const FREE_PLAY_OUTDOOR_C = 22;

export const DEFAULT_AC_SETPOINT = 21;
export const DEFAULT_HEATER_SETPOINT = 23;
export const SETPOINT_MIN = 16;
export const SETPOINT_MAX = 30;

/** The temperatures the optimizer OFFERS for a cooling or a warming request.
 *
 *  Not the whole dial. Asked to make a room cooler the search used to reach for
 *  the coldest setting it could justify, because colder scores better on every
 *  proxy it has -- and it answered "a bit warm in here" with a room at 16, or
 *  with a heater driven to 41. Nobody asking for a warmer room means 41; they
 *  mean comfortable. A request for comfort is a request for a comfortable
 *  temperature, so these are the bands a person would actually set, coolest and
 *  warmest first so the gallery leads with the strongest of the sensible ones.
 *
 *  Free play only. The study scenarios fix their units and never reach here. */
export const COOL_SETPOINTS = [19, 20, 21];
export const WARM_SETPOINTS = [25, 24, 23];

export const CATALOG: Record<string, ItemSpec> = {
  bed: { size: [1.5, 0.5, 2.0], category: "furniture", mount: "floor", label: "Bed" },
  desk: { size: [1.2, 0.75, 0.6], category: "furniture", mount: "floor", label: "Desk" },
  closet: { size: [1.0, 2.0, 0.6], category: "furniture", mount: "floor", label: "Closet" },
  table: { size: [1.1, 0.45, 0.7], category: "furniture", mount: "floor", label: "Table" },
  couch: { size: [1.8, 0.8, 0.85], category: "furniture", mount: "floor", label: "Couch" },
  tv: { size: [1.4, 0.8, 0.1], category: "furniture", mount: "wall", label: "TV" },
  fridge: { size: [0.7, 1.8, 0.7], category: "furniture", mount: "floor", label: "Fridge" },
  sink: { size: [0.7, 0.9, 0.55], category: "furniture", mount: "floor", label: "Sink" },
  kitchen_sink: { size: [1.0, 0.9, 0.6], category: "furniture", mount: "floor", label: "Kitchen sink" },
  toilet: { size: [0.55, 0.75, 0.7], category: "furniture", mount: "floor", label: "Toilet" },
  bathtub: { size: [1.6, 0.6, 0.75], category: "furniture", mount: "floor", label: "Bathtub" },
  shower: { size: [0.9, 2.0, 0.9], category: "furniture", mount: "floor", label: "Shower" },
  ac: { size: [0.85, 0.32, 0.22], category: "hvac", mount: "wall", flow: 0.25, label: "AC unit" },
  heater: { size: [0.8, 0.5, 0.18], category: "hvac", mount: "floor", flow: 0, label: "Heater" },
  fan: { size: [0.45, 1.3, 0.45], category: "hvac", mount: "floor", flow: 0, label: "Fan" },
  // 24-hour ventilation, Japanese "Type 3" (see floorplan/home.ts): supply and
  // extract are separate units, both mounted high on a WALL — which is where the
  // example home puts them, so the palette must create the same thing rather
  // than the old mid-ceiling diffuser.
  supply: { size: VENT_SIZE, category: "hvac", mount: "wall", flow: VENT_FLOW, label: "Fresh-air vent" },
  return: { size: VENT_SIZE, category: "hvac", mount: "wall", flow: VENT_FLOW, label: "Exhaust vent" },
  bin: { size: [0.4, 0.7, 0.4], category: "furniture", mount: "floor", label: "Kitchen bin" },
  smell: { size: [0.34, 0.5, 0.34], category: "hvac", mount: "floor", label: "Smell source" },
  // "Damp patch" described the old flat-on-the-floor drawing. It is the same
  // orb the smell source uses now, and it names the same kind of thing.
  damp: { size: [0.5, 0.5, 0.5], category: "hvac", mount: "floor", label: "Moisture source" },
};

/** Items offered in the "add" palette, grouped. */
export const PALETTE: Array<{ group: string; types: string[] }> = [
  { group: "Furniture", types: ["bed", "desk", "closet", "table", "couch", "tv"] },
  { group: "Kitchen", types: ["fridge", "kitchen_sink", "bin"] },
  { group: "Bathroom", types: ["sink", "toilet", "bathtub", "shower"] },
  { group: "Heating, cooling & air", types: ["ac", "heater", "fan", "supply", "return"] },
  { group: "Simulation", types: ["smell"] },
];
