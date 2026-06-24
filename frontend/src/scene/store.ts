import { create } from "zustand";
import { CATALOG } from "../floorplan/catalog";
import {
  DOOR_WIDTH,
  WALL_THICKNESS,
  WINDOW_WIDTH,
  makeOpening,
  openingSpan,
  rectContains,
} from "../floorplan/geometry";
import { generateHome } from "../floorplan/home";
import type {
  FloorPlan,
  HomeSize,
  Opening,
  OpeningKind,
  PlacedItem,
  Vec2,
  Vec3,
  WallSeg,
} from "../floorplan/types";

// Single source of truth: the current home, selection, and edit mode. BOTH the
// mouse (select + drag + draw) and the programmatic api mutate this store.

const DEFAULT_SIZE: HomeSize = { length: 9, width: 7, height: 2.7 };

export type EditMode = "select" | "draw-wall";

export interface SceneState {
  plan: FloorPlan;
  started: boolean;
  selectedId: string | null;
  selectedWallId: string | null;
  selectedOpeningId: string | null;
  draggingId: string | null;
  mode: EditMode;
  past: FloorPlan[];
  future: FloorPlan[];

  generate: (size: HomeSize) => void;
  openSetup: () => void;
  setMode: (mode: EditMode) => void;
  undo: () => void;
  redo: () => void;

  selectItem: (id: string | null) => void;
  selectWall: (id: string | null) => void;
  selectOpening: (id: string | null) => void;
  clearSelection: () => void;

  setDragging: (id: string | null) => void;
  setPosition: (id: string, position: Vec3, rotationY?: number) => void;
  translate: (id: string, delta: Vec3) => void;
  updateItem: (id: string, patch: Partial<PlacedItem>) => void;
  rotateItem: (id: string, deltaRad: number) => void;

  addItem: (type: string, position?: Vec3) => string | null;
  removeItem: (id: string) => void;
  addWall: (a: Vec2, b: Vec2) => void;
  removeWall: (id: string) => void;

  addOpening: (wallId: string, kind: OpeningKind) => string | null;
  removeOpening: (id: string) => void;
  toggleOpening: (id: string) => void;

  removeSelected: () => void;
}

let customId = 0;
const HISTORY = 50;
let dragSnapshot: FloorPlan | null = null;

/** History patch to prepend to a mutating `set`: pushes the current plan onto the
 *  undo stack and clears the redo stack. */
function snapshot(s: SceneState): { past: FloorPlan[]; future: FloorPlan[] } {
  return { past: [...s.past, s.plan].slice(-HISTORY), future: [] };
}

function mapItems(plan: FloorPlan, fn: (it: PlacedItem) => PlacedItem): FloorPlan {
  return { ...plan, items: plan.items.map(fn) };
}

function roomAt(plan: FloorPlan, x: number, z: number): string {
  const room = plan.rooms.find((r) => rectContains(r.rect, x, z));
  return room ? room.id : plan.rooms[0]?.id ?? "";
}

export const useSceneStore = create<SceneState>((set, get) => ({
  plan: generateHome(DEFAULT_SIZE),
  started: false,
  selectedId: null,
  selectedWallId: null,
  selectedOpeningId: null,
  draggingId: null,
  mode: "select",
  past: [],
  future: [],

  generate: (size) =>
    set({
      plan: generateHome(size),
      started: true,
      selectedId: null,
      selectedWallId: null,
      selectedOpeningId: null,
      draggingId: null,
      mode: "select",
      past: [],
      future: [],
    }),

  openSetup: () => set({ started: false }),

  undo: () =>
    set((s) => {
      if (!s.past.length) return {};
      const prev = s.past[s.past.length - 1];
      return {
        plan: prev,
        past: s.past.slice(0, -1),
        future: [s.plan, ...s.future].slice(0, HISTORY),
        selectedId: null,
        selectedWallId: null,
        selectedOpeningId: null,
      };
    }),

  redo: () =>
    set((s) => {
      if (!s.future.length) return {};
      const next = s.future[0];
      return {
        plan: next,
        future: s.future.slice(1),
        past: [...s.past, s.plan].slice(-HISTORY),
        selectedId: null,
        selectedWallId: null,
        selectedOpeningId: null,
      };
    }),

  setMode: (mode) => set({ mode, selectedId: null, selectedWallId: null, selectedOpeningId: null }),

  selectItem: (id) => set({ selectedId: id, selectedWallId: null, selectedOpeningId: null }),
  selectWall: (id) => set({ selectedWallId: id, selectedId: null, selectedOpeningId: null }),
  selectOpening: (id) => set({ selectedOpeningId: id, selectedId: null, selectedWallId: null }),
  clearSelection: () => set({ selectedId: null, selectedWallId: null, selectedOpeningId: null }),

  setDragging: (id) => {
    if (id) {
      dragSnapshot = get().plan; // remember pre-drag plan for a single undo step
    } else if (dragSnapshot) {
      const moved = dragSnapshot !== get().plan;
      const snap = dragSnapshot;
      dragSnapshot = null;
      if (moved) set((s) => ({ past: [...s.past, snap].slice(-HISTORY), future: [] }));
    }
    set({ draggingId: id });
  },

  setPosition: (id, position, rotationY) =>
    set((s) => ({
      plan: mapItems(s.plan, (it) =>
        it.id === id ? { ...it, position, ...(rotationY !== undefined ? { rotationY } : {}) } : it,
      ),
    })),

  translate: (id, delta) =>
    set((s) => ({
      plan: mapItems(s.plan, (it) =>
        it.id === id
          ? { ...it, position: [it.position[0] + delta[0], it.position[1] + delta[1], it.position[2] + delta[2]] }
          : it,
      ),
    })),

  updateItem: (id, patch) =>
    set((s) => ({
      ...snapshot(s),
      plan: mapItems(s.plan, (it) => (it.id === id ? { ...it, ...patch } : it)),
    })),

  rotateItem: (id, deltaRad) =>
    set((s) => ({
      ...snapshot(s),
      plan: mapItems(s.plan, (it) => (it.id === id ? { ...it, rotationY: it.rotationY + deltaRad } : it)),
    })),

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
    set((s) => ({
      ...snapshot(s),
      plan: { ...s.plan, items: [...s.plan.items, item] },
      selectedId: id,
      selectedWallId: null,
    }));
    return id;
  },

  removeItem: (id) =>
    set((s) => ({
      ...snapshot(s),
      plan: { ...s.plan, items: s.plan.items.filter((it) => it.id !== id) },
      selectedId: s.selectedId === id ? null : s.selectedId,
    })),

  addWall: (a, b) => {
    const { plan } = get();
    const dx = Math.abs(b[0] - a[0]);
    const dz = Math.abs(b[1] - a[1]);
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
    set((s) => ({ ...snapshot(s), plan: { ...s.plan, walls: [...s.plan.walls, wall] } }));
  },

  removeWall: (id) =>
    set((s) => {
      const target = s.plan.walls.find((w) => w.id === id);
      if (!target) return {};
      const line = target.axis === "z" ? target.a[0] : target.a[1];
      const tS = target.axis === "z" ? Math.min(target.a[1], target.b[1]) : Math.min(target.a[0], target.b[0]);
      const tE = target.axis === "z" ? Math.max(target.a[1], target.b[1]) : Math.max(target.a[0], target.b[0]);
      const eq = (x: number, y: number) => Math.abs(x - y) < 1e-3;
      const walls = s.plan.walls.filter((w) => {
        if (w.id === id) return false;
        if (w.axis !== target.axis) return true;
        const wl = w.axis === "z" ? w.a[0] : w.a[1];
        if (!eq(wl, line)) return true;
        const ws = w.axis === "z" ? Math.min(w.a[1], w.b[1]) : Math.min(w.a[0], w.b[0]);
        const we = w.axis === "z" ? Math.max(w.a[1], w.b[1]) : Math.max(w.a[0], w.b[0]);
        return Math.min(tE, we) - Math.max(tS, ws) <= 0.01;
      });
      return { ...snapshot(s), plan: { ...s.plan, walls }, selectedWallId: null };
    }),

  addOpening: (wallId, kind) => {
    const { plan } = get();
    const wall = plan.walls.find((w) => w.id === wallId);
    if (!wall) return null;
    const axis = wall.axis;
    const line = axis === "z" ? wall.a[0] : wall.a[1];
    const start = axis === "z" ? Math.min(wall.a[1], wall.b[1]) : Math.min(wall.a[0], wall.b[0]);
    const end = axis === "z" ? Math.max(wall.a[1], wall.b[1]) : Math.max(wall.a[0], wall.b[0]);

    // widest free run on this wall
    const taken = wall.openings
      .map((o) => {
        const sp = openingSpan(o);
        return [sp.s, sp.e] as [number, number];
      })
      .sort((p, q) => p[0] - q[0]);
    let cursor = start;
    let best: [number, number] = [start, start];
    const consider = (s: number, e: number) => {
      if (e - s > best[1] - best[0]) best = [s, e];
    };
    for (const [s, e] of taken) {
      if (s > cursor) consider(cursor, s);
      cursor = Math.max(cursor, e);
    }
    if (cursor < end) consider(cursor, end);

    const need = kind === "door" ? DOOR_WIDTH : WINDOW_WIDTH;
    if (best[1] - best[0] < need + 0.2) return null;
    const mid = (best[0] + best[1]) / 2;
    const s = mid - need / 2;
    const e = mid + need / 2;

    // identify the room on the far side (for labelling / BC connectivity)
    const probe = (sign: number): string | "outside" => {
      const px = axis === "z" ? line + sign * 0.12 : mid;
      const pz = axis === "z" ? mid : line + sign * 0.12;
      const r = plan.rooms.find((rm) => rectContains(rm.rect, px, pz));
      return r ? r.id : "outside";
    };
    const here = wall.roomId;
    const other = probe(1) !== here ? probe(1) : probe(-1);

    const opening = makeOpening(`${kind}-add${++customId}`, kind, axis, line, s, e, [here, other]);
    const eq = (x: number, y: number) => Math.abs(x - y) < 1e-3;
    const covers = (w: WallSeg) => {
      if (w.axis !== axis) return false;
      const wl = w.axis === "z" ? w.a[0] : w.a[1];
      if (!eq(wl, line)) return false;
      const ws = w.axis === "z" ? Math.min(w.a[1], w.b[1]) : Math.min(w.a[0], w.b[0]);
      const we = w.axis === "z" ? Math.max(w.a[1], w.b[1]) : Math.max(w.a[0], w.b[0]);
      return s >= ws - 1e-3 && e <= we + 1e-3;
    };
    const walls = plan.walls.map((w) => (covers(w) ? { ...w, openings: [...w.openings, opening] } : w));
    set((st) => {
      const base = { ...st.plan, walls };
      const next =
        kind === "door"
          ? { ...base, doors: [...st.plan.doors, opening] }
          : { ...base, windows: [...st.plan.windows, opening] };
      return { ...snapshot(st), plan: next, selectedOpeningId: opening.id, selectedWallId: null, selectedId: null };
    });
    return opening.id;
  },

  removeOpening: (id) =>
    set((s) => ({
      ...snapshot(s),
      plan: {
        ...s.plan,
        walls: s.plan.walls.map((w) => ({ ...w, openings: w.openings.filter((o) => o.id !== id) })),
        doors: s.plan.doors.filter((o) => o.id !== id),
        windows: s.plan.windows.filter((o) => o.id !== id),
      },
      selectedOpeningId: s.selectedOpeningId === id ? null : s.selectedOpeningId,
    })),

  toggleOpening: (id) =>
    set((s) => {
      const flip = (o: Opening) => (o.id === id ? { ...o, open: !o.open } : o);
      return {
        ...snapshot(s),
        plan: {
          ...s.plan,
          walls: s.plan.walls.map((w) => ({ ...w, openings: w.openings.map(flip) })),
          doors: s.plan.doors.map(flip),
          windows: s.plan.windows.map(flip),
        },
      };
    }),

  removeSelected: () => {
    const { selectedId, selectedWallId, selectedOpeningId, removeItem, removeWall, removeOpening } = get();
    if (selectedId) removeItem(selectedId);
    else if (selectedWallId) removeWall(selectedWallId);
    else if (selectedOpeningId) removeOpening(selectedOpeningId);
  },
}));
