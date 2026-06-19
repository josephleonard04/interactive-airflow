import type { ItemCategory, Mount, Vec3 } from "./types";

// Defaults for items the user can add from the palette. Drives both the
// "add furniture" UI and the size/category/mount used when an item is created.

export interface ItemSpec {
  size: Vec3;
  category: ItemCategory;
  mount: Mount;
  flow?: number;
  label: string;
}

export const CATALOG: Record<string, ItemSpec> = {
  // furniture
  bed: { size: [1.5, 0.5, 2.0], category: "furniture", mount: "floor", label: "Bed" },
  nightstand: { size: [0.45, 0.5, 0.4], category: "furniture", mount: "floor", label: "Nightstand" },
  desk: { size: [1.2, 0.75, 0.6], category: "furniture", mount: "floor", label: "Desk" },
  chair: { size: [0.45, 0.9, 0.45], category: "furniture", mount: "floor", label: "Chair" },
  sofa: { size: [2.0, 0.8, 0.9], category: "furniture", mount: "floor", label: "Sofa" },
  tv: { size: [1.4, 0.8, 0.1], category: "furniture", mount: "wall", label: "TV" },
  coffee_table: { size: [1.0, 0.4, 0.5], category: "furniture", mount: "floor", label: "Coffee table" },
  dining_table: { size: [1.4, 0.75, 0.8], category: "furniture", mount: "floor", label: "Dining table" },
  counter: { size: [1.8, 0.9, 0.6], category: "furniture", mount: "floor", label: "Counter" },
  fridge: { size: [0.7, 1.8, 0.7], category: "furniture", mount: "floor", label: "Refrigerator" },
  bookshelf: { size: [0.9, 1.8, 0.35], category: "furniture", mount: "floor", label: "Bookshelf" },
  plant: { size: [0.4, 1.1, 0.4], category: "furniture", mount: "floor", label: "Plant" },
  toilet: { size: [0.5, 0.6, 0.7], category: "furniture", mount: "floor", label: "Toilet" },
  sink: { size: [0.6, 0.85, 0.45], category: "furniture", mount: "floor", label: "Sink" },
  shower: { size: [0.9, 2.0, 0.9], category: "furniture", mount: "floor", label: "Shower" },
  washer: { size: [0.6, 0.85, 0.6], category: "furniture", mount: "floor", label: "Washer" },
  dryer: { size: [0.6, 0.85, 0.6], category: "furniture", mount: "floor", label: "Dryer" },
  // hvac
  supply: { size: [0.5, 0.14, 0.5], category: "hvac", mount: "ceiling", flow: 0.12, label: "Supply vent" },
  return: { size: [0.7, 0.14, 0.7], category: "hvac", mount: "ceiling", flow: 0.2, label: "Return vent" },
  ac: { size: [0.85, 0.32, 0.22], category: "hvac", mount: "wall", flow: 0.25, label: "AC unit" },
  fan: { size: [0.9, 0.16, 0.9], category: "hvac", mount: "ceiling", flow: 0, label: "Fan" },
};

/** Items offered in the "add" palette, grouped. */
export const PALETTE: Array<{ group: string; types: string[] }> = [
  { group: "Furniture", types: ["bed", "nightstand", "desk", "chair", "sofa", "tv", "coffee_table", "bookshelf", "plant"] },
  { group: "Kitchen & bath", types: ["dining_table", "counter", "fridge", "toilet", "sink", "shower", "washer", "dryer"] },
  { group: "HVAC", types: ["supply", "return", "ac", "fan"] },
];
