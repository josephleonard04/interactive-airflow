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
  ac: { size: [0.85, 0.32, 0.22], category: "hvac", mount: "wall", flow: 0.25, label: "AC unit" },
  heater: { size: [0.8, 0.5, 0.18], category: "hvac", mount: "floor", flow: 0, label: "Heater" },
  fan: { size: [0.45, 1.3, 0.45], category: "hvac", mount: "floor", flow: 0, label: "Fan" },
  // 24-hour ventilation, Japanese "Type 3" (see floorplan/home.ts): supply and
  // extract are separate units, both mounted high on a WALL — which is where the
  // example home puts them, so the palette must create the same thing rather
  // than the old mid-ceiling diffuser.
  supply: { size: VENT_SIZE, category: "hvac", mount: "wall", flow: VENT_FLOW, label: "Fresh-air inlet" },
  return: { size: VENT_SIZE, category: "hvac", mount: "wall", flow: VENT_FLOW, label: "Extract vent" },
  bin: { size: [0.4, 0.7, 0.4], category: "furniture", mount: "floor", label: "Kitchen bin" },
  smell: { size: [0.34, 0.5, 0.34], category: "hvac", mount: "floor", label: "Smell source" },
};

/** Items offered in the "add" palette, grouped. */
export const PALETTE: Array<{ group: string; types: string[] }> = [
  { group: "Furniture", types: ["bed", "desk", "closet", "table", "couch", "tv"] },
  { group: "Kitchen", types: ["fridge", "kitchen_sink", "bin"] },
  { group: "Bathroom", types: ["sink", "toilet", "bathtub"] },
  { group: "Heating, cooling & air", types: ["ac", "heater", "fan", "supply", "return"] },
  { group: "Simulation", types: ["smell"] },
];
