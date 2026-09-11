import type { RoomType } from "./types";

// Colours for room floors and items, used by the 3D view and the panel.

// NEUTRAL FLOORS. Airflow is drawn in a blue-to-red thermographic ramp, so a
// green bedroom or a blue bathroom competed with the very colours the lines
// use to say "cold" and "comfortable". Rooms are told apart by light, warm
// greys and pale wood tones instead — nothing on the floor can be mistaken
// for air.
export const ROOM_COLOR: Record<RoomType, string> = {
  living: "#e6e1d8",
  bedroom: "#ddd8d0",
  kitchen: "#e9e5de",
  bathroom: "#d9d9d6",
};

export const ROOM_ACCENT: Record<RoomType, string> = {
  living: "#9c9284",
  bedroom: "#8f887e",
  kitchen: "#a39b8d",
  bathroom: "#8d8d88",
};

const ITEM_COLOR: Record<string, string> = {
  bed: "#c2a37e",
  desk: "#b08a63",
  closet: "#9d8466",
  table: "#bb9a6b",
  couch: "#7c8aa0",
  tv: "#1b2430",
  fridge: "#e6ebf0",
  sink: "#dfe9ef",
  kitchen_sink: "#c9d3da",
  toilet: "#eef3f6",
  bathtub: "#e4eef3",
  supply: "#3b82f6",
  return: "#14b8a6",
  ac: "#aab6c4",
  fan: "#7b8794",
  heater: "#c47a55",
  smell: "#a855f7",
};

export function itemColor(type: string): string {
  return ITEM_COLOR[type] ?? "#a7adb6";
}
