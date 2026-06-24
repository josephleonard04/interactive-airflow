import type { RoomType } from "./types";

// Colours for room floors and items, used by the 3D view and the panel.

export const ROOM_COLOR: Record<RoomType, string> = {
  living: "#d6e8dc",
  bedroom: "#d4e1f4",
  kitchen: "#f4e6c8",
  bathroom: "#cdeef0",
};

export const ROOM_ACCENT: Record<RoomType, string> = {
  living: "#7fae90",
  bedroom: "#7e9dcf",
  kitchen: "#cfae6a",
  bathroom: "#6fb9c0",
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
  toilet: "#eef3f6",
  bathtub: "#e4eef3",
  supply: "#3b82f6",
  ac: "#aab6c4",
  fan: "#7b8794",
  heater: "#c47a55",
};

export function itemColor(type: string): string {
  return ITEM_COLOR[type] ?? "#a7adb6";
}
