import { exportBoundaryConditions } from "../bc/exportBoundaryConditions";
import { HOUSING_TYPES } from "../floorplan/templates";
import type { FloorPlan, HousingType, PlacedItem, RoomDef, Vec2, Vec3 } from "../floorplan/types";
import { useSceneStore } from "./store";

// Programmatic control surface — the second of the two control paths the advisor
// asked for. The mouse moves items via the gizmo; this api moves them (and
// switches floor plans) from scripts / the console / the future intent layer.
// Both go through the same store, so they can never disagree.
//
//   airflow.generate("two_bedroom")
//   airflow.list()
//   airflow.find("Bed")                 // first item whose type/name matches
//   airflow.translate("bed-1", [0.5, 0, 0])
//   airflow.exportBoundaryConditions()

export const sceneApi = {
  housingTypes(): HousingType[] {
    return [...HOUSING_TYPES];
  },

  /** Generate (replace) the floor plan for a housing type. */
  generate(type: HousingType): void {
    useSceneStore.getState().generate(type);
  },

  getFloorPlan(): FloorPlan {
    return useSceneStore.getState().plan;
  },

  listRooms(): RoomDef[] {
    return useSceneStore.getState().plan.rooms.map((r) => ({ ...r }));
  },

  /** All movable items (furniture + HVAC). */
  list(): PlacedItem[] {
    return useSceneStore.getState().plan.items.map((it) => ({ ...it }));
  },

  get(id: string): PlacedItem | undefined {
    const it = useSceneStore.getState().plan.items.find((x) => x.id === id);
    return it ? { ...it } : undefined;
  },

  /** First item matching by id, type, or (case-insensitive) — handy for scripting. */
  find(query: string): PlacedItem | undefined {
    const q = query.toLowerCase();
    const it = useSceneStore
      .getState()
      .plan.items.find((x) => x.id === query || x.type.toLowerCase() === q);
    return it ? { ...it } : undefined;
  },

  translate(id: string, delta: Vec3): void {
    useSceneStore.getState().translate(id, delta);
  },

  setPosition(id: string, position: Vec3): void {
    useSceneStore.getState().setPosition(id, position);
  },

  update(id: string, patch: Partial<PlacedItem>): void {
    useSceneStore.getState().updateItem(id, patch);
  },

  /** Add an item (furniture or HVAC) by catalog type, optionally at a position. */
  add(type: string, position?: Vec3): string | null {
    return useSceneStore.getState().addItem(type, position);
  },

  remove(id: string): void {
    useSceneStore.getState().removeItem(id);
  },

  /** Add an axis-aligned wall between two floor points [x, z]. */
  addWall(a: Vec2, b: Vec2): void {
    useSceneStore.getState().addWall(a, b);
  },

  removeWall(id: string): void {
    useSceneStore.getState().removeWall(id);
  },

  select(id: string | null): void {
    useSceneStore.getState().selectItem(id);
  },

  /** Export the current plan as boundary conditions for the fluid solver. */
  exportBoundaryConditions() {
    return exportBoundaryConditions(useSceneStore.getState().plan);
  },
};

export type SceneApi = typeof sceneApi;

declare global {
  interface Window {
    airflow: SceneApi;
  }
}

export function installSceneApi() {
  if (typeof window !== "undefined") {
    window.airflow = sceneApi;
    // eslint-disable-next-line no-console
    console.info("[airflow] programmatic scene API ready: window.airflow", sceneApi);
  }
}
