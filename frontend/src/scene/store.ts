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
import { generateEmpty, generateHome } from "../floorplan/home";
import {
  checkBackendHealth,
  runAccurate as runAccurateEngine,
  type AccurateResult,
  type BackendHealth,
} from "../engine/accurate";
import type {
  FloorPlan,
  HomeSize,
  Opening,
  OpeningKind,
  PlacedItem,
  StartMode,
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
  draggingOpeningId: string | null;
  mode: EditMode;
  past: FloorPlan[];
  future: FloorPlan[];

  generate: (size: HomeSize, mode: StartMode) => void;
  openSetup: () => void;
  setMode: (mode: EditMode) => void;
  undo: () => void;
  redo: () => void;

  selectItem: (id: string | null) => void;
  selectWall: (id: string | null) => void;
  selectOpening: (id: string | null) => void;
  clearSelection: () => void;

  setDragging: (id: string | null) => void;
  setDraggingOpening: (id: string | null) => void;
  moveOpeningAlong: (id: string, alongCenter: number) => void;
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

  // airflow simulation overlay (runs in the 3D scene)
  simActive: boolean;
  simMode: SimMode;
  simPaused: boolean;
  simSourceRoomId: string | null;
  /** false while the steady-state solve is still converging. */
  simReady: boolean;
  toggleSim: () => void;
  setSimMode: (m: SimMode) => void;
  toggleSimPause: () => void;
  setSimSource: (id: string | null) => void;
  setSimReady: (v: boolean) => void;

  // Two engines: "realtime" = the in-browser Euler solver (live), "openfoam" =
  // an accurate CFD pass run on the local backend on demand.
  engine: SimEngine;
  accurate: AccurateResult | null;
  accurateRunning: boolean;
  accurateHealth: BackendHealth | null;
  setEngine: (e: SimEngine) => void;
  runAccurate: () => Promise<void>;
  refreshAccurateHealth: () => Promise<void>;

  /** One-click device presets (set on/power across all HVAC). */
  applyAirflowPreset: (preset: AirflowPreset) => void;
  /** Summary of the last preset's changes, pending Accept/Cancel. */
  pendingChange: PendingChange | null;
  acceptChange: () => void;
  cancelChange: () => void;
}

export interface PendingChange {
  title: string;
  lines: string[];
}

export type SimEngine = "realtime" | "openfoam";
export type AirflowPreset = "comfort" | "cooling" | "freshair" | "warmup" | "circulate";

interface PresetDevice {
  on: boolean;
  power: number;
  oscillate?: boolean;
}
export interface PresetSpec {
  label: string;
  hint: string;
  /** Per-device {on,power,oscillate} keyed by item type. */
  devices: Record<string, PresetDevice>;
  /** Open interior doors so air/heat/odour circulate between rooms. */
  interiorDoors: boolean;
  /** Open exterior windows (& doors) to vent to outside. */
  windows: boolean;
}

// A preset is a whole-home configuration: it sets every HVAC device's on/power
// (and fan oscillation) AND opens/closes doors & windows, since cross-room
// coverage depends on open interior doors and venting depends on open windows.
export const PRESETS: Record<AirflowPreset, PresetSpec> = {
  comfort: {
    label: "Comfort",
    hint: "Balanced cooling, gentle oscillating fan, doors open so the whole home stays even.",
    devices: {
      ac: { on: true, power: 2 },
      fan: { on: true, power: 2, oscillate: true },
      supply: { on: true, power: 2 },
      heater: { on: false, power: 2 },
    },
    interiorDoors: true,
    windows: false,
  },
  cooling: {
    label: "Cool down",
    hint: "AC on high to cool fast; doors open to spread the cool air, windows shut.",
    devices: {
      ac: { on: true, power: 3 },
      fan: { on: true, power: 2, oscillate: true },
      supply: { on: true, power: 2 },
      heater: { on: false, power: 2 },
    },
    interiorDoors: true,
    windows: false,
  },
  freshair: {
    label: "Fresh air",
    hint: "Purge stale air & odours: fan + vent on high, AC off, all windows and doors open.",
    devices: {
      ac: { on: false, power: 2 },
      fan: { on: true, power: 3, oscillate: true },
      supply: { on: true, power: 3 },
      heater: { on: false, power: 2 },
    },
    interiorDoors: true,
    windows: true,
  },
  warmup: {
    label: "Warm up",
    hint: "Heater on, fan circulates the warmth, doors open, windows shut to keep heat in.",
    devices: {
      ac: { on: false, power: 2 },
      fan: { on: true, power: 2, oscillate: true },
      supply: { on: false, power: 2 },
      heater: { on: true, power: 3 },
    },
    interiorDoors: true,
    windows: false,
  },
  circulate: {
    label: "Circulate",
    hint: "Just move air around the whole home: oscillating fan + vent, AC/heater off, doors open.",
    devices: {
      ac: { on: false, power: 2 },
      fan: { on: true, power: 3, oscillate: true },
      supply: { on: true, power: 2 },
      heater: { on: false, power: 2 },
    },
    interiorDoors: true,
    windows: false,
  },
};

export type SimMode = "airflow" | "temperature" | "contamination";

let customId = 0;
const HISTORY = 50;
let dragSnapshot: FloorPlan | null = null;
let openingDragSnapshot: FloorPlan | null = null;

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
  draggingOpeningId: null,
  mode: "select",
  past: [],
  future: [],
  simActive: false,
  simMode: "airflow",
  simPaused: false,
  simSourceRoomId: null,
  simReady: false,

  toggleSim: () => set((s) => ({ simActive: !s.simActive, simReady: false })),
  setSimMode: (m) => set({ simMode: m }),
  toggleSimPause: () => set((s) => ({ simPaused: !s.simPaused })),
  setSimSource: (id) => set({ simSourceRoomId: id, simReady: false }),
  setSimReady: (v) => set({ simReady: v }),

  engine: "realtime",
  accurate: null,
  accurateRunning: false,
  accurateHealth: null,
  setEngine: (engine) => set({ engine }),
  refreshAccurateHealth: async () => {
    const accurateHealth = await checkBackendHealth();
    set({ accurateHealth });
  },
  runAccurate: async () => {
    if (get().accurateRunning) return;
    set({ accurateRunning: true, engine: "openfoam" });
    try {
      const accurateHealth = await checkBackendHealth();
      set({ accurateHealth });
      const accurate = await runAccurateEngine(get().plan);
      set({ accurate });
    } finally {
      set({ accurateRunning: false });
    }
  },

  applyAirflowPreset: (preset) =>
    set((s) => {
      const spec = PRESETS[preset];
      const before = s.plan;
      const items = before.items.map((it) => {
        const d = spec.devices[it.type];
        if (!d) return it;
        return { ...it, on: d.on, power: d.power, ...(it.type === "fan" ? { oscillate: !!d.oscillate } : {}) };
      });
      const exterior = (o: Opening) => o.rooms.includes("outside");
      const setOpen = (o: Opening): Opening => {
        // Interior doors follow interiorDoors; exterior openings follow windows.
        const open = exterior(o) ? spec.windows : o.kind === "door" ? spec.interiorDoors : spec.windows;
        return open === o.open ? o : { ...o, open };
      };
      const after = {
        ...before,
        items,
        doors: before.doors.map(setOpen),
        windows: before.windows.map(setOpen),
        walls: before.walls.map((w) => ({ ...w, openings: w.openings.map(setOpen) })),
      };

      // Human-readable diff for the Accept/Cancel review.
      const lines: string[] = [];
      const names: Record<string, string> = { ac: "AC", fan: "Fan", supply: "Vent", heater: "Heater" };
      const powerWord = ["", "low", "medium", "high"];
      for (const it of after.items) {
        const b = before.items.find((x) => x.id === it.id);
        if (!b || !names[it.type]) continue;
        if (b.on === it.on && b.power === it.power && b.oscillate === it.oscillate) continue;
        const on = it.on !== false;
        const osc = it.type === "fan" && it.oscillate ? ", oscillating" : "";
        lines.push(`${names[it.type]} → ${on ? `on · ${powerWord[it.power ?? 2]}${osc}` : "off"}`);
      }
      const cnt = (arr: Opening[], base: Opening[], open: boolean) =>
        arr.filter((o, i) => o.open === open && base[i]?.open !== open).length;
      const dOpen = cnt(after.doors, before.doors, true);
      const dShut = cnt(after.doors, before.doors, false);
      const wOpen = cnt(after.windows, before.windows, true);
      const wShut = cnt(after.windows, before.windows, false);
      if (dOpen) lines.push(`Opened ${dOpen} interior door${dOpen > 1 ? "s" : ""}`);
      if (dShut) lines.push(`Closed ${dShut} door${dShut > 1 ? "s" : ""}`);
      if (wOpen) lines.push(`Opened ${wOpen} window${wOpen > 1 ? "s" : ""}`);
      if (wShut) lines.push(`Closed ${wShut} window${wShut > 1 ? "s" : ""}`);

      return {
        ...snapshot(s),
        plan: after,
        pendingChange: { title: spec.label, lines: lines.length ? lines : ["Already set — no change."] },
      };
    }),

  pendingChange: null,
  acceptChange: () => set({ pendingChange: null }),
  cancelChange: () => {
    get().undo();
    set({ pendingChange: null });
  },

  generate: (size, mode) =>
    set({
      plan: mode === "blank" ? generateEmpty(size) : generateHome(size),
      started: true,
      selectedId: null,
      selectedWallId: null,
      selectedOpeningId: null,
      draggingId: null,
      draggingOpeningId: null,
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

  setDraggingOpening: (id) => {
    if (id) {
      openingDragSnapshot = get().plan;
    } else if (openingDragSnapshot) {
      const moved = openingDragSnapshot !== get().plan;
      const snap = openingDragSnapshot;
      openingDragSnapshot = null;
      if (moved) set((s) => ({ past: [...s.past, snap].slice(-HISTORY), future: [] }));
    }
    set({ draggingOpeningId: id });
  },

  // Slide a door/window along its wall (it stays on the same wall line), clamped
  // to the wall extent. Updates the opening in doors/windows and in the carved
  // wall copies. No history here — handled by setDraggingOpening start/end.
  moveOpeningAlong: (id, alongCenter) =>
    set((s) => {
      const o = [...s.plan.doors, ...s.plan.windows].find((x) => x.id === id);
      if (!o) return {};
      const vertical = Math.abs(o.a[0] - o.b[0]) < 1e-3;
      const line = vertical ? o.a[0] : o.a[1];
      const width = o.width;
      const M = 0.06; // clearance from wall ends and from neighbouring openings
      const span = (p: Vec2, q: Vec2): [number, number] =>
        vertical ? [Math.min(p[1], q[1]), Math.max(p[1], q[1])] : [Math.min(p[0], q[0]), Math.max(p[0], q[0])];
      const curCenter = (() => {
        const [s0, e0] = span(o.a, o.b);
        return (s0 + e0) / 2;
      })();

      // contiguous wall runs on this line (so an opening can't drift into a gap
      // between walls or onto a corner)
      const segs: Array<[number, number]> = [];
      for (const w of s.plan.walls) {
        const wl = w.axis === "z" ? w.a[0] : w.a[1];
        const matches = (vertical && w.axis === "z") || (!vertical && w.axis === "x");
        if (matches && Math.abs(wl - line) < 1e-3) segs.push(span(w.a, w.b));
      }
      if (!segs.length) return {};
      segs.sort((p, q) => p[0] - q[0]);
      const runs: Array<[number, number]> = [];
      for (const sg of segs) {
        const last = runs[runs.length - 1];
        if (last && sg[0] <= last[1] + 1e-3) last[1] = Math.max(last[1], sg[1]);
        else runs.push([sg[0], sg[1]]);
      }
      let run = runs.find((r) => curCenter >= r[0] - 1e-3 && curCenter <= r[1] + 1e-3);
      if (!run) run = runs.reduce((b, r) => (Math.abs((r[0] + r[1]) / 2 - curCenter) < Math.abs((b[0] + b[1]) / 2 - curCenter) ? r : b), runs[0]);

      // occupied intervals from OTHER openings on the same line (so they can't share space)
      const occ: Array<[number, number]> = [];
      for (const op of [...s.plan.doors, ...s.plan.windows]) {
        if (op.id === id) continue;
        const ov = Math.abs(op.a[0] - op.b[0]) < 1e-3;
        const ol = ov ? op.a[0] : op.a[1];
        if (ov !== vertical || Math.abs(ol - line) >= 1e-3) continue;
        const [os, oe] = span(op.a, op.b);
        occ.push([os - M, oe + M]);
      }
      occ.sort((p, q) => p[0] - q[0]);

      // free sub-intervals within the run, then pick the one holding the opening
      const free: Array<[number, number]> = [];
      let cursor = run[0] + M;
      for (const [os, oe] of occ) {
        if (os > cursor) free.push([cursor, Math.min(os, run[1] - M)]);
        cursor = Math.max(cursor, oe);
      }
      if (cursor < run[1] - M) free.push([cursor, run[1] - M]);
      const fits = free.filter((f) => f[1] - f[0] >= width);
      let target: [number, number] | null =
        fits.find((f) => curCenter >= f[0] - 1e-3 && curCenter <= f[1] + 1e-3) ?? null;
      if (!target)
        target = fits.reduce<[number, number] | null>(
          (b, f) => (!b || Math.abs((f[0] + f[1]) / 2 - curCenter) < Math.abs((b[0] + b[1]) / 2 - curCenter) ? f : b),
          null,
        );
      if (!target) return {}; // nowhere valid to move — leave it put

      const c = Math.min(target[1] - width / 2, Math.max(target[0] + width / 2, alongCenter));
      const ns = c - width / 2;
      const ne = c + width / 2;
      const na: Vec2 = vertical ? [line, ns] : [ns, line];
      const nb: Vec2 = vertical ? [line, ne] : [ne, line];
      const upd = <T extends { id: string; a: Vec2; b: Vec2 }>(x: T): T =>
        x.id === id ? { ...x, a: na, b: nb } : x;
      return {
        plan: {
          ...s.plan,
          doors: s.plan.doors.map(upd),
          windows: s.plan.windows.map(upd),
          walls: s.plan.walls.map((w) => ({ ...w, openings: w.openings.map(upd) })),
        },
      };
    }),

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
