import { exportBoundaryConditions } from "../bc/exportBoundaryConditions";
import type { FloorPlan, HomeSize, PlacedItem, RoomDef, Vec2, Vec3 } from "../floorplan/types";
import { useSceneStore } from "./store";

// Programmatic control surface — the second of the two control paths the advisor
// asked for. The mouse moves/edits via the view; this api does the same from
// scripts / the console / the future intent layer. Both go through one store.
//
//   airflow.generate({ length: 9, width: 7, height: 2.7 })
//   airflow.list()
//   airflow.find("bed")
//   airflow.translate("bed-1", [0.5, 0, 0])
//   airflow.add("plant", [2, 0, 2]); airflow.remove("tv-1")
//   airflow.addWall([1, 1], [3, 1])
//   airflow.exportBoundaryConditions()

export const sceneApi = {
  /** Regenerate the home for the given dimensions (metres). */
  generate(size: HomeSize): void {
    useSceneStore.getState().generate(size);
  },

  getFloorPlan(): FloorPlan {
    return useSceneStore.getState().plan;
  },

  listRooms(): RoomDef[] {
    return useSceneStore.getState().plan.rooms.map((r) => ({ ...r }));
  },

  list(): PlacedItem[] {
    return useSceneStore.getState().plan.items.map((it) => ({ ...it }));
  },

  get(id: string): PlacedItem | undefined {
    const it = useSceneStore.getState().plan.items.find((x) => x.id === id);
    return it ? { ...it } : undefined;
  },

  find(query: string): PlacedItem | undefined {
    const q = query.toLowerCase();
    const it = useSceneStore.getState().plan.items.find((x) => x.id === query || x.type.toLowerCase() === q);
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

  add(type: string, position?: Vec3): string | null {
    return useSceneStore.getState().addItem(type, position);
  },

  remove(id: string): void {
    useSceneStore.getState().removeItem(id);
  },

  addWall(a: Vec2, b: Vec2): void {
    useSceneStore.getState().addWall(a, b);
  },

  removeWall(id: string): void {
    useSceneStore.getState().removeWall(id);
  },

  select(id: string | null): void {
    useSceneStore.getState().selectItem(id);
  },

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
