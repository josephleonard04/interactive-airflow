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

export const CATALOG: Record<string, ItemSpec> = {
  bed: { size: [1.5, 0.5, 2.0], category: "furniture", mount: "floor", label: "Bed" },
  desk: { size: [1.2, 0.75, 0.6], category: "furniture", mount: "floor", label: "Desk" },
  closet: { size: [1.0, 2.0, 0.6], category: "furniture", mount: "floor", label: "Closet" },
  table: { size: [1.1, 0.45, 0.7], category: "furniture", mount: "floor", label: "Table" },
  couch: { size: [1.8, 0.8, 0.85], category: "furniture", mount: "floor", label: "Couch" },
  tv: { size: [1.4, 0.8, 0.1], category: "furniture", mount: "wall", label: "TV" },
  fridge: { size: [0.7, 1.8, 0.7], category: "furniture", mount: "floor", label: "Fridge" },
  sink: { size: [0.7, 0.9, 0.55], category: "furniture", mount: "floor", label: "Sink" },
  ac: { size: [0.85, 0.32, 0.22], category: "hvac", mount: "wall", flow: 0.25, label: "AC unit" },
  heater: { size: [0.8, 0.5, 0.18], category: "hvac", mount: "floor", flow: 0, label: "Heater" },
  fan: { size: [0.9, 0.16, 0.9], category: "hvac", mount: "ceiling", flow: 0, label: "Fan" },
  supply: { size: [0.5, 0.14, 0.5], category: "hvac", mount: "ceiling", flow: 0.12, label: "Vent" },
};

/** Items offered in the "add" palette, grouped. */
export const PALETTE: Array<{ group: string; types: string[] }> = [
  { group: "Furniture", types: ["bed", "desk", "closet", "table", "couch", "tv", "fridge", "sink"] },
  { group: "Heating, cooling & air", types: ["ac", "heater", "fan", "supply"] },
];
