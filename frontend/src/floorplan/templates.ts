import type { ConnectionSpec, HousingType, RoomDef } from "./types";

// Curated floor-plan templates. Rooms are authored as a non-overlapping tiling
// of axis-aligned rectangles that share edges, so walls / doors are derived
// reliably. Everything downstream (walls, windows, furniture, HVAC, room grid)
// is generated from these by generate.ts.

export interface FloorPlanTemplate {
  housingType: HousingType;
  name: string;
  wallHeight: number;
  fans: boolean;
  rooms: RoomDef[];
  connections: ConnectionSpec[];
}

const r = (
  id: string,
  type: RoomDef["type"],
  name: string,
  x: number,
  z: number,
  w: number,
  d: number,
  program?: RoomDef["program"],
): RoomDef => ({ id, type, name, rect: { x, z, w, d }, program });

export const TEMPLATES: Record<HousingType, FloorPlanTemplate> = {
  // 1. Studio — one open living/kitchen/sleep space + bathroom + entry.
  studio: {
    housingType: "studio",
    name: "Studio Apartment",
    wallHeight: 2.7,
    fans: true,
    rooms: [
      r("main", "living", "Studio", 0, 0, 4.5, 5.0, "studio"),
      r("bathroom", "bathroom", "Bathroom", 4.5, 0, 1.5, 2.4),
      r("entryway", "entryway", "Entry", 4.5, 2.4, 1.5, 2.6),
    ],
    connections: [
      { a: "main", b: "entryway" },
      { a: "entryway", b: "bathroom" },
      { a: "entryway", b: "outside" },
    ],
  },

  // 2. One-bedroom — living + kitchen/dining + bedroom + bath + entry.
  one_bedroom: {
    housingType: "one_bedroom",
    name: "One-Bedroom Apartment",
    wallHeight: 2.7,
    fans: true,
    rooms: [
      r("living", "living", "Living Room", 0, 0, 5.0, 3.5),
      r("kitchen", "kitchen", "Kitchen", 5.0, 0, 3.0, 3.5, "kitchen_dining"),
      r("bedroom", "bedroom", "Bedroom", 0, 3.5, 3.5, 2.5),
      r("bathroom", "bathroom", "Bathroom", 3.5, 3.5, 2.0, 2.5),
      r("entryway", "entryway", "Entry", 5.5, 3.5, 2.5, 2.5),
    ],
    connections: [
      { a: "living", b: "kitchen" },
      { a: "living", b: "bedroom" },
      { a: "entryway", b: "kitchen" },
      { a: "entryway", b: "bathroom" },
      { a: "entryway", b: "outside" },
    ],
  },

  // 3. Two-bedroom — living + kitchen/dining, hallway to two bedrooms + bath.
  two_bedroom: {
    housingType: "two_bedroom",
    name: "Two-Bedroom Apartment",
    wallHeight: 2.7,
    fans: true,
    rooms: [
      r("living", "living", "Living Room", 0, 0, 5.0, 4.5),
      r("kitchen", "kitchen", "Kitchen", 5.0, 0, 4.0, 4.5, "kitchen_dining"),
      r("hallway", "hallway", "Hallway", 0, 4.5, 9.0, 1.2),
      r("master_bed", "bedroom", "Master Bedroom", 0, 5.7, 4.0, 2.3),
      r("second_bed", "bedroom", "Bedroom 2", 4.0, 5.7, 3.0, 2.3),
      r("bathroom", "bathroom", "Bathroom", 7.0, 5.7, 2.0, 2.3),
    ],
    connections: [
      { a: "living", b: "kitchen" },
      { a: "living", b: "hallway" },
      { a: "hallway", b: "master_bed" },
      { a: "hallway", b: "second_bed" },
      { a: "hallway", b: "bathroom" },
      { a: "living", b: "outside" },
    ],
  },

  // 4. Small family house — living/dining/kitchen, hallway to bedrooms, bath,
  //    laundry, plus a dedicated entry.
  small_family_house: {
    housingType: "small_family_house",
    name: "Small Family House",
    wallHeight: 2.8,
    fans: true,
    rooms: [
      r("entryway", "entryway", "Entry", 0, 0, 1.6, 4.5),
      r("living", "living", "Living Room", 1.6, 0, 3.4, 4.5),
      r("dining", "dining", "Dining Room", 5.0, 0, 3.0, 4.5),
      r("kitchen", "kitchen", "Kitchen", 8.0, 0, 3.0, 4.5),
      r("hallway", "hallway", "Hallway", 0, 4.5, 11.0, 1.3),
      r("master_bed", "bedroom", "Master Bedroom", 0, 5.8, 4.0, 3.2),
      r("child_bed", "bedroom", "Child Bedroom", 4.0, 5.8, 3.0, 3.2),
      r("bathroom", "bathroom", "Bathroom", 7.0, 5.8, 2.0, 3.2),
      r("laundry", "laundry", "Laundry", 9.0, 5.8, 2.0, 3.2),
    ],
    connections: [
      { a: "entryway", b: "living" },
      { a: "living", b: "dining" },
      { a: "dining", b: "kitchen" },
      { a: "living", b: "hallway" },
      { a: "hallway", b: "master_bed" },
      { a: "hallway", b: "child_bed" },
      { a: "hallway", b: "bathroom" },
      { a: "hallway", b: "laundry" },
      { a: "entryway", b: "outside" },
    ],
  },

  // 5. Shared student apartment — shared living + kitchen, hallway to three
  //    bedrooms + bath.
  shared_student: {
    housingType: "shared_student",
    name: "Shared Student Apartment",
    wallHeight: 2.7,
    fans: true,
    rooms: [
      r("living", "living", "Shared Living", 0, 0, 5.0, 4.5),
      r("kitchen", "kitchen", "Shared Kitchen", 5.0, 0, 4.0, 4.5, "kitchen_dining"),
      r("hallway", "hallway", "Hallway", 0, 4.5, 9.0, 1.2),
      r("bed1", "bedroom", "Bedroom 1", 0, 5.7, 2.5, 2.3),
      r("bed2", "bedroom", "Bedroom 2", 2.5, 5.7, 2.5, 2.3),
      r("bed3", "bedroom", "Bedroom 3", 5.0, 5.7, 2.5, 2.3),
      r("bathroom", "bathroom", "Bathroom", 7.5, 5.7, 1.5, 2.3),
    ],
    connections: [
      { a: "living", b: "kitchen" },
      { a: "living", b: "hallway" },
      { a: "hallway", b: "bed1" },
      { a: "hallway", b: "bed2" },
      { a: "hallway", b: "bed3" },
      { a: "hallway", b: "bathroom" },
      { a: "living", b: "outside" },
    ],
  },
};

export const HOUSING_TYPES: HousingType[] = [
  "studio",
  "one_bedroom",
  "two_bedroom",
  "small_family_house",
  "shared_student",
];
