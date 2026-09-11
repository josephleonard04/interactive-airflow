import type { RoomType } from "./types";

// Colours for room floors and items, used by the 3D view and the panel.

// NEUTRAL, MID-GREY FLOORS. Airflow is drawn in a blue-to-red thermographic
// ramp, so a coloured floor competes with the colours the lines use to say
// "cold" and "comfortable" — and a pale floor swallows the yellow and cyan in
// the middle of that ramp (the first neutral set was light beige, and yellow
// lines on it were hard to see). A mid grey with no hue gives every colour in
// the ramp contrast, light and dark ends alike. Rooms are told apart by small
// steps in lightness only.
export const ROOM_COLOR: Record<RoomType, string> = {
  living: "#8b9096",
  bedroom: "#7f848a",
  kitchen: "#959a9f",
  bathroom: "#777c82",
};

export const ROOM_ACCENT: Record<RoomType, string> = {
  living: "#5f646a",
  bedroom: "#55595f",
  kitchen: "#696e73",
  bathroom: "#4f5359",
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
