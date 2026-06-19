import { useSceneStore } from "./store";
import type { ObjectKind, SceneObject, Vec3 } from "./types";
import { exportBoundaryConditions } from "../bc/exportBoundaryConditions";

// Programmatic control surface for the scene.
//
// This is the second of the two control paths the advisor asked for: the user
// can move objects with the mouse, AND a function call can translate/add/remove
// objects. Both go through the same store, so they can never disagree.
//
// The intent->physics layer (and scripts / tests) will eventually drive the
// scene through THIS api rather than through the UI.

export const sceneApi = {
  /** List all objects (snapshot copy). */
  list(): SceneObject[] {
    return useSceneStore.getState().objects.map((o) => ({ ...o }));
  },

  get(id: string): SceneObject | undefined {
    const o = useSceneStore.getState().objects.find((x) => x.id === id);
    return o ? { ...o } : undefined;
  },

  /** Find the first object whose name matches (case-insensitive). */
  find(name: string): SceneObject | undefined {
    const n = name.toLowerCase();
    const o = useSceneStore.getState().objects.find((x) => x.name.toLowerCase() === n);
    return o ? { ...o } : undefined;
  },

  add(spec: Partial<SceneObject> & { kind: ObjectKind }): string {
    return useSceneStore.getState().addObject(spec);
  },

  remove(id: string): void {
    useSceneStore.getState().removeObject(id);
  },

  /** Move an object by a delta (the "translate object in the scene" call). */
  translate(id: string, delta: Vec3): void {
    useSceneStore.getState().translate(id, delta);
  },

  /** Set an object's absolute position. */
  setPosition(id: string, position: Vec3): void {
    useSceneStore.getState().setPosition(id, position);
  },

  update(id: string, patch: Partial<SceneObject>): void {
    useSceneStore.getState().updateObject(id, patch);
  },

  select(id: string | null): void {
    useSceneStore.getState().select(id);
  },

  reset(): void {
    useSceneStore.getState().reset();
  },

  /** Export the current scene as boundary conditions for the fluid solver. */
  exportBoundaryConditions() {
    const { room, objects } = useSceneStore.getState();
    return exportBoundaryConditions(room, objects);
  },
};

export type SceneApi = typeof sceneApi;

// Expose on window so it can be driven from the browser console, scripts, or
// the future intent layer. e.g.  airflow.translate("bed-1", [0.5, 0, 0])
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
