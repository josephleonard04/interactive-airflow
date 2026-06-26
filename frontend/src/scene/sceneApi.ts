import { exportBoundaryConditions } from "../bc/exportBoundaryConditions";
import { compileLfmScene } from "../bc/lfm";
import type { FloorPlan, HomeSize, PlacedItem, RoomDef, StartMode, Vec2, Vec3 } from "../floorplan/types";
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
//   airflow.exportBoundaryConditions()   // solver-neutral geometry
//   airflow.exportLfm()                  // LFM-ready scene + flux balance

export const sceneApi = {
  /** Regenerate the home for the given dimensions (metres). */
  generate(size: HomeSize, mode: StartMode = "example"): void {
    useSceneStore.getState().generate(size, mode);
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

  rotate(id: string, deltaRad = Math.PI / 2): void {
    useSceneStore.getState().rotateItem(id, deltaRad);
  },

  undo(): void {
    useSceneStore.getState().undo();
  },

  redo(): void {
    useSceneStore.getState().redo();
  },

  addWall(a: Vec2, b: Vec2): void {
    useSceneStore.getState().addWall(a, b);
  },

  removeWall(id: string): void {
    useSceneStore.getState().removeWall(id);
  },

  /** Add a door/window to a wall by id; returns the opening id or null if no room. */
  addOpening(wallId: string, kind: "door" | "window"): string | null {
    return useSceneStore.getState().addOpening(wallId, kind);
  },

  toggleOpening(id: string): void {
    useSceneStore.getState().toggleOpening(id);
  },

  /** Slide a door/window along its wall to the given centre coordinate. */
  moveOpening(id: string, alongCenter: number): void {
    useSceneStore.getState().moveOpeningAlong(id, alongCenter);
  },

  removeOpening(id: string): void {
    useSceneStore.getState().removeOpening(id);
  },

  select(id: string | null): void {
    useSceneStore.getState().selectItem(id);
  },

  exportBoundaryConditions() {
    return exportBoundaryConditions(useSceneStore.getState().plan);
  },

  /** Compile the home into an LFM-ready scene (domain + solids + flux-balanced
   *  inlets/outlets). Feed the JSON to bridge/lfm_bridge.py on the GPU machine. */
  exportLfm() {
    return compileLfmScene(useSceneStore.getState().plan);
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
