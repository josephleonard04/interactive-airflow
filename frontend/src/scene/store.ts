import { create } from "zustand";
import { CATALOG } from "../floorplan/catalog";
import { generateFloorPlan } from "../floorplan/generate";
import { WALL_THICKNESS, rectContains } from "../floorplan/geometry";
import type { FloorPlan, HousingType, PlacedItem, Vec2, Vec3, WallSeg } from "../floorplan/types";

// Single source of truth: the current floor plan, selection, and edit mode. BOTH
// the mouse (select + drag + draw) and the programmatic api mutate this store.

const DEFAULT_TYPE: HousingType = "one_bedroom";

export type EditMode = "select" | "draw-wall";

export interface SceneState {
  plan: FloorPlan;
  housingType: HousingType;
  selectedId: string | null; // selected item
  selectedWallId: string | null; // selected wall
  draggingId: string | null; // item being dragged on the floor
  mode: EditMode;

  generate: (type: HousingType) => void;
  setMode: (mode: EditMode) => void;

  selectItem: (id: string | null) => void;
  selectWall: (id: string | null) => void;
  clearSelection: () => void;

  setDragging: (id: string | null) => void;
  setPosition: (id: string, position: Vec3) => void;
  translate: (id: string, delta: Vec3) => void;
  updateItem: (id: string, patch: Partial<PlacedItem>) => void;

  addItem: (type: string, position?: Vec3) => string | null;
  removeItem: (id: string) => void;
  addWall: (a: Vec2, b: Vec2) => void;
  removeWall: (id: string) => void;
  removeSelected: () => void;
}

let customId = 0;

function mapItems(plan: FloorPlan, fn: (it: PlacedItem) => PlacedItem): FloorPlan {
  return { ...plan, items: plan.items.map(fn) };
}

function roomAt(plan: FloorPlan, x: number, z: number): string {
  const room = plan.rooms.find((r) => rectContains(r.rect, x, z));
  return room ? room.id : plan.rooms[0]?.id ?? "";
}

export const useSceneStore = create<SceneState>((set, get) => ({
  plan: generateFloorPlan(DEFAULT_TYPE),
  housingType: DEFAULT_TYPE,
  selectedId: null,
  selectedWallId: null,
  draggingId: null,
  mode: "select",

  generate: (type) =>
    set({
      plan: generateFloorPlan(type),
      housingType: type,
      selectedId: null,
      selectedWallId: null,
      draggingId: null,
      mode: "select",
    }),

  setMode: (mode) => set({ mode, selectedId: null, selectedWallId: null }),

  selectItem: (id) => set({ selectedId: id, selectedWallId: null }),
  selectWall: (id) => set({ selectedWallId: id, selectedId: null }),
  clearSelection: () => set({ selectedId: null, selectedWallId: null }),

  setDragging: (id) => set({ draggingId: id }),

  setPosition: (id, position) =>
    set((s) => ({ plan: mapItems(s.plan, (it) => (it.id === id ? { ...it, position } : it)) })),

  translate: (id, delta) =>
    set((s) => ({
      plan: mapItems(s.plan, (it) =>
        it.id === id
          ? { ...it, position: [it.position[0] + delta[0], it.position[1] + delta[1], it.position[2] + delta[2]] }
          : it,
      ),
    })),

  updateItem: (id, patch) =>
    set((s) => ({ plan: mapItems(s.plan, (it) => (it.id === id ? { ...it, ...patch } : it)) })),

  addItem: (type, position) => {
    const spec = CATALOG[type];
    if (!spec) return null;
    const { plan } = get();
    const { bounds, wallHeight } = plan;
    const pos: Vec3 = position ?? [bounds.x + bounds.w / 2, 0, bounds.z + bounds.d / 2];
    const y =
      spec.mount === "ceiling" ? wallHeight - 0.09 : spec.mount === "wall" ? 1.1 : spec.size[1] / 2;
    const id = `${type}-add${++customId}`;
    const item: PlacedItem = {
      id,
      category: spec.category,
      type,
      roomId: roomAt(plan, pos[0], pos[2]),
      position: [pos[0], y, pos[2]],
      size: spec.size,
      rotationY: 0,
      mount: spec.mount,
      flow: spec.flow,
      movable: true,
    };
    set((s) => ({ plan: { ...s.plan, items: [...s.plan.items, item] }, selectedId: id, selectedWallId: null }));
    return id;
  },

  removeItem: (id) =>
    set((s) => ({
      plan: { ...s.plan, items: s.plan.items.filter((it) => it.id !== id) },
      selectedId: s.selectedId === id ? null : s.selectedId,
    })),

  addWall: (a, b) => {
    const { plan } = get();
    const dx = Math.abs(b[0] - a[0]);
    const dz = Math.abs(b[1] - a[1]);
    // snap to the dominant axis (axis-aligned walls only)
    const axis: WallSeg["axis"] = dx >= dz ? "x" : "z";
    const wall: WallSeg =
      axis === "x"
        ? {
            id: `wall-custom-${++customId}`,
            axis,
            a: [Math.min(a[0], b[0]), a[1]],
            b: [Math.max(a[0], b[0]), a[1]],
            thickness: WALL_THICKNESS,
            height: plan.wallHeight,
            exterior: false,
            roomId: "custom",
            openings: [],
          }
        : {
            id: `wall-custom-${++customId}`,
            axis,
            a: [a[0], Math.min(a[1], b[1])],
            b: [a[0], Math.max(a[1], b[1])],
            thickness: WALL_THICKNESS,
            height: plan.wallHeight,
            exterior: false,
            roomId: "custom",
            openings: [],
          };
    set((s) => ({ plan: { ...s.plan, walls: [...s.plan.walls, wall] } }));
  },

  removeWall: (id) =>
    set((s) => {
      const target = s.plan.walls.find((w) => w.id === id);
      if (!target) return {};
      const line = target.axis === "z" ? target.a[0] : target.a[1];
      const tStart = target.axis === "z" ? Math.min(target.a[1], target.b[1]) : Math.min(target.a[0], target.b[0]);
      const tEnd = target.axis === "z" ? Math.max(target.a[1], target.b[1]) : Math.max(target.a[0], target.b[0]);
      const eq = (x: number, y: number) => Math.abs(x - y) < 1e-3;
      // remove the wall plus any coincident duplicate (shared interior walls are
      // emitted once per room) so the wall fully disappears.
      const walls = s.plan.walls.filter((w) => {
        if (w.id === id) return false;
        if (w.axis !== target.axis) return true;
        const wl = w.axis === "z" ? w.a[0] : w.a[1];
        if (!eq(wl, line)) return true;
        const ws = w.axis === "z" ? Math.min(w.a[1], w.b[1]) : Math.min(w.a[0], w.b[0]);
        const we = w.axis === "z" ? Math.max(w.a[1], w.b[1]) : Math.max(w.a[0], w.b[0]);
        const overlap = Math.min(tEnd, we) - Math.max(tStart, ws);
        return overlap <= 0.01; // keep walls that don't overlap the target
      });
      return { plan: { ...s.plan, walls }, selectedWallId: null };
    }),

  removeSelected: () => {
    const { selectedId, selectedWallId, removeItem, removeWall } = get();
    if (selectedId) removeItem(selectedId);
    else if (selectedWallId) removeWall(selectedWallId);
  },
}));
