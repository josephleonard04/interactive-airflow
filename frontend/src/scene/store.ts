import { create } from "zustand";
import type { ObjectKind, Room, SceneObject, Vec3 } from "./types";

// Single source of truth for the scene. BOTH the mouse interactions and the
// programmatic API (see sceneApi.ts) mutate this store, so the two control
// paths stay in sync — a requirement from the advisor meeting.

let idCounter = 0;
const nextId = (kind: string) => `${kind}-${++idCounter}`;

export interface SceneState {
  room: Room;
  objects: SceneObject[];
  selectedId: string | null;

  // --- mutations ---
  addObject: (spec: Partial<SceneObject> & { kind: ObjectKind }) => string;
  removeObject: (id: string) => void;
  setPosition: (id: string, position: Vec3) => void;
  translate: (id: string, delta: Vec3) => void;
  updateObject: (id: string, patch: Partial<SceneObject>) => void;
  select: (id: string | null) => void;
  reset: () => void;
}

const DEFAULT_ROOM: Room = { size: [5, 2.7, 4] };

// A small default bedroom-ish scene so there is something to manipulate.
function defaultObjects(): SceneObject[] {
  idCounter = 0;
  return [
    {
      id: nextId("bed"),
      name: "Bed",
      kind: "furniture",
      position: [-1.4, 0.3, -1.0],
      size: [1.4, 0.6, 2.0],
      rotationY: 0,
    },
    {
      id: nextId("desk"),
      name: "Desk",
      kind: "furniture",
      position: [1.6, 0.4, 1.2],
      size: [1.2, 0.75, 0.6],
      rotationY: 0,
    },
    {
      id: nextId("supply"),
      name: "AC supply",
      kind: "supply",
      position: [0, 2.5, -1.8],
      size: [0.6, 0.2, 0.4],
      rotationY: 0,
      flow: 0.15,
    },
    {
      id: nextId("return"),
      name: "Return vent",
      kind: "return",
      position: [2.2, 0.2, -1.8],
      size: [0.4, 0.4, 0.1],
      rotationY: 0,
      flow: 0.15,
    },
  ];
}

const DEFAULT_SIZE: Record<ObjectKind, Vec3> = {
  furniture: [1, 0.8, 1],
  supply: [0.6, 0.2, 0.4],
  return: [0.4, 0.4, 0.1],
};

export const useSceneStore = create<SceneState>((set) => ({
  room: DEFAULT_ROOM,
  objects: defaultObjects(),
  selectedId: null,

  addObject: (spec) => {
    const id = spec.id ?? nextId(spec.kind);
    const obj: SceneObject = {
      id,
      name: spec.name ?? id,
      kind: spec.kind,
      position: spec.position ?? [0, (spec.size?.[1] ?? DEFAULT_SIZE[spec.kind][1]) / 2, 0],
      size: spec.size ?? DEFAULT_SIZE[spec.kind],
      rotationY: spec.rotationY ?? 0,
      flow: spec.flow ?? (spec.kind === "furniture" ? undefined : 0.15),
    };
    set((s) => ({ objects: [...s.objects, obj], selectedId: id }));
    return id;
  },

  removeObject: (id) =>
    set((s) => ({
      objects: s.objects.filter((o) => o.id !== id),
      selectedId: s.selectedId === id ? null : s.selectedId,
    })),

  setPosition: (id, position) =>
    set((s) => ({
      objects: s.objects.map((o) => (o.id === id ? { ...o, position } : o)),
    })),

  translate: (id, delta) =>
    set((s) => ({
      objects: s.objects.map((o) =>
        o.id === id
          ? {
              ...o,
              position: [
                o.position[0] + delta[0],
                o.position[1] + delta[1],
                o.position[2] + delta[2],
              ],
            }
          : o,
      ),
    })),

  updateObject: (id, patch) =>
    set((s) => ({
      objects: s.objects.map((o) => (o.id === id ? { ...o, ...patch } : o)),
    })),

  select: (id) => set({ selectedId: id }),

  reset: () => set({ objects: defaultObjects(), selectedId: null }),
}));
