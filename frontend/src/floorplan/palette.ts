import type { RoomType } from "./types";

// Shared colours for room floors and placed items, used by the 3D view and the
// panel legend.

export const ROOM_COLOR: Record<RoomType, string> = {
  living: "#cde7d0",
  bedroom: "#cfe0f3",
  kitchen: "#f3e4c4",
  dining: "#ecd9f0",
  bathroom: "#c9eef0",
  laundry: "#e6e6e6",
  hallway: "#e9e2d0",
  entryway: "#f0dcd0",
};

const ITEM_COLOR: Record<string, string> = {
  bed: "#b08968",
  nightstand: "#a98467",
  desk: "#a98467",
  sofa: "#6b7280",
  tv: "#111827",
  coffee_table: "#92400e",
  counter: "#cbd5e1",
  fridge: "#eef2f6",
  dining_table: "#a16207",
  toilet: "#eef6fb",
  sink: "#e3eef5",
  shower: "#d4e9f0",
  washer: "#d8dde3",
  dryer: "#d8dde3",
  supply: "#3b82f6",
  return: "#f59e0b",
  ac: "#94a3b8",
  fan: "#64748b",
};

export function itemColor(type: string): string {
  return ITEM_COLOR[type] ?? "#9aa0a8";
}
