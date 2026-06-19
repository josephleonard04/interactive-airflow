import { create } from "zustand";
import { generateFloorPlan } from "../floorplan/generate";
import type { FloorPlan, HousingType, PlacedItem, Vec3 } from "../floorplan/types";

// Single source of truth: the current floor plan plus selection. BOTH the mouse
// gizmo and the programmatic api (sceneApi.ts) mutate this store, so the two
// control paths stay in sync. Structural geometry (rooms/walls/openings) is
// regenerated wholesale when the housing type changes; furniture and HVAC items
// are individually movable.

const DEFAULT_TYPE: HousingType = "one_bedroom";

export interface SceneState {
  plan: FloorPlan;
  housingType: HousingType;
  selectedId: string | null;

  generate: (type: HousingType) => void;
  select: (id: string | null) => void;
  setPosition: (id: string, position: Vec3) => void;
  translate: (id: string, delta: Vec3) => void;
  updateItem: (id: string, patch: Partial<PlacedItem>) => void;
}

function mapItems(plan: FloorPlan, fn: (it: PlacedItem) => PlacedItem): FloorPlan {
  return { ...plan, items: plan.items.map(fn) };
}

export const useSceneStore = create<SceneState>((set) => ({
  plan: generateFloorPlan(DEFAULT_TYPE),
  housingType: DEFAULT_TYPE,
  selectedId: null,

  generate: (type) =>
    set({ plan: generateFloorPlan(type), housingType: type, selectedId: null }),

  select: (id) => set({ selectedId: id }),

  setPosition: (id, position) =>
    set((s) => ({ plan: mapItems(s.plan, (it) => (it.id === id ? { ...it, position } : it)) })),

  translate: (id, delta) =>
    set((s) => ({
      plan: mapItems(s.plan, (it) =>
        it.id === id
          ? {
              ...it,
              position: [
                it.position[0] + delta[0],
                it.position[1] + delta[1],
                it.position[2] + delta[2],
              ],
            }
          : it,
      ),
    })),

  updateItem: (id, patch) =>
    set((s) => ({ plan: mapItems(s.plan, (it) => (it.id === id ? { ...it, ...patch } : it)) })),
}));
