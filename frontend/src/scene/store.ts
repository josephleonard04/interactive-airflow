import { create } from "zustand";
import { CATALOG, ventMountY } from "../floorplan/catalog";
import {
  DOOR_WIDTH,
  WALL_THICKNESS,
  WINDOW_WIDTH,
  carveOpening,
  makeOpening,
  openingSpan,
  rectContains,
} from "../floorplan/geometry";
import { generateEmpty, generateHome } from "../floorplan/home";
import { FREE_TOOLS, SCENARIOS, type ScenarioId, type ScenarioTools } from "../floorplan/scenarios";
import { autoNameRooms, recomputeRooms } from "../floorplan/detectRooms";
import {
  checkBackendHealth,
  runAccurate as runAccurateEngine,
  type AccurateResult,
  type BackendHealth,
} from "../engine/accurate";
import { type OptimizeGoal } from "../intent/optimize";
import { searchOptimize } from "../intent/searchOptimize";
import { findSolutions, type Solution } from "../intent/solutions";
import { parseGoal } from "../intent/objectives";
import type {
  FloorPlan,
  HomeSize,
  Opening,
  OpeningKind,
  PlacedItem,
  Rect,
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

  /** Active study scenario, or null for the normal unrestricted app. */
  scenarioId: ScenarioId | null;
  /** Which controls the active scenario allows (all of them when null). */
  tools: ScenarioTools;
  startScenario: (id: ScenarioId) => void;
  exitScenario: () => void;
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
  /** Move an opening to whichever wall of its own room is nearest (x, z). */
  moveOpeningToPoint: (id: string, x: number, z: number) => void;
  setPosition: (id: string, position: Vec3, rotationY?: number) => void;
  translate: (id: string, delta: Vec3) => void;
  updateItem: (id: string, patch: Partial<PlacedItem>) => void;
  rotateItem: (id: string, deltaRad: number) => void;

  addItem: (type: string, position?: Vec3) => string | null;
  removeItem: (id: string) => void;
  /** User rename of a room — sticks (auto-naming won't override it). */
  renameRoom: (id: string, name: string) => void;
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
  /** Airflow visual style: drifting dots (default) or streamlines. */
  airflowStyle: AirflowStyle;
  toggleSim: () => void;
  setSimMode: (m: SimMode) => void;
  setAirflowStyle: (s: AirflowStyle) => void;
  toggleSimPause: () => void;
  setSimSource: (id: string | null) => void;
  setSimReady: (v: boolean) => void;

  /** Outdoor air temperature (°C). The house sits at this baseline and the
   *  HVAC pushes it up or down, so it decides what "cool the bedroom" even
   *  means — 22 °C outside needs no AC, 35 °C outside needs a lot. */
  outdoorTemp: number;
  setOutdoorTemp: (c: number) => void;
  /** Room whose temperature the readout is pinned to (null = whole house). */
  tempRoomId: string | null;
  setTempRoom: (id: string | null) => void;
  /** Per-room temperature as a DELTA from outdoor (°C), published by the solver.
   *  Kept as a delta so changing the outdoor temperature is instant — the
   *  readout and the colour ramp just re-add the new baseline, no re-solve. */
  roomTempDeltas: Map<string, number>;
  setRoomTemps: (m: Map<string, number>) => void;

  // Two engines: "realtime" = the in-browser Euler solver (live), "openfoam" =
  // an accurate CFD pass run on the local backend on demand.
  engine: SimEngine;
  accurate: AccurateResult | null;
  accurateRunning: boolean;
  accurateHealth: BackendHealth | null;
  setEngine: (e: SimEngine) => void;
  runAccurate: () => Promise<void>;
  refreshAccurateHealth: () => Promise<void>;

  /** One-click device presets (set on/power + relocate devices + open/close doors). */
  applyAirflowPreset: (preset: AirflowPreset) => void;
  /** Search a plain-language goal for SEVERAL good configurations to choose from. */
  applyBestSolution: (goalText: string) => boolean;
  /** Candidate solutions from the last search, best first (empty = none yet). */
  solutionOptions: Solution[];
  /** The goal text those options answer, for the option-panel heading. */
  solutionGoal: string | null;
  /** Rooms the goal asked about, so the option cards can show their temperature. */
  solutionTargets: string[];
  /** Apply one of the offered solutions (index into solutionOptions). */
  chooseSolution: (index: number) => void;
  dismissSolutions: () => void;
  /** true while the placement search is running the simulator. */
  optimizing: boolean;
  /** User-sketched target region (world coords) for "this area" goals. */
  sketchRegion: Rect | null;
  setSketchRegion: (r: Rect | null) => void;

  /** Study session log (§6.5 of the study protocol): every utterance, parse,
   *  review decision and plan change, timestamped, downloadable as JSON. */
  sessionLog: LogEvent[];
  logEvent: (kind: LogEvent["kind"], data: Record<string, unknown>) => void;

  /** Summary of the last change, pending Accept/Cancel. */
  pendingChange: PendingChange | null;
  acceptChange: () => void;
  cancelChange: () => void;
}

export interface LogEvent {
  t: number; // ms since epoch
  kind: "goal" | "check" | "preset" | "review" | "sketch" | "edit" | "engine";
  data: Record<string, unknown>;
}

const PRESET_GOAL: Record<AirflowPreset, OptimizeGoal> = {
  comfort: "balanced",
  cooling: "cool",
  freshair: "ventilate",
  warmup: "warm",
  circulate: "circulate",
};

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

export type SimMode = "airflow" | "temperature" | "contamination" | "noise";
export type AirflowStyle = "dots" | "lines";

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

/** One-per-home appliances in a study task (can't add a second). */
const ADD_LIMIT: Record<string, number> = { heater: 1, fan: 1, ac: 1 };

/** An empty floor position inside a room that doesn't overlap existing floor
 *  items, so a new item never lands on top of the couch. Scans a coarse grid and
 *  falls back to the room centre. Returns [x, 0, z]. */
function freeSpotIn(rect: Rect, items: PlacedItem[], size: Vec3): Vec3 {
  const hw = size[0] / 2, hd = size[2] / 2, m = 0.3;
  const floor = items.filter((it) => it.mount === "floor");
  const hits = (cx: number, cz: number) =>
    floor.some(
      (it) =>
        Math.abs(cx - it.position[0]) < hw + it.size[0] / 2 + 0.15 &&
        Math.abs(cz - it.position[2]) < hd + it.size[2] / 2 + 0.15,
    );
  for (let cz = rect.z + hd + m; cz <= rect.z + rect.d - hd - m + 1e-6; cz += 0.4)
    for (let cx = rect.x + hw + m; cx <= rect.x + rect.w - hw - m + 1e-6; cx += 0.4)
      if (!hits(cx, cz)) return [cx, 0, cz];
  return [rect.x + rect.w / 2, 0, rect.z + rect.d / 2];
}

const DEV_NAME: Record<string, string> = { ac: "AC", fan: "Fan", supply: "Vent", heater: "Heater" };
const POWER_WORD = ["", "low", "medium", "high"];

/** Human-readable device + opening changes between two plans (for the review). */
function diffPlan(before: FloorPlan, after: FloorPlan): string[] {
  const lines: string[] = [];
  for (const it of after.items) {
    const b = before.items.find((x) => x.id === it.id);
    if (!b || !DEV_NAME[it.type]) continue;
    if (b.on === it.on && b.power === it.power && b.oscillate === it.oscillate) continue;
    const on = it.on !== false;
    const osc = it.type === "fan" ? (it.oscillate ? " · oscillating" : " · fixed direction") : "";
    lines.push(`${DEV_NAME[it.type]} → ${on ? `on · ${POWER_WORD[it.power ?? 2]} power${osc}` : "off"}`);
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
  return lines;
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
  airflowStyle: "lines",
  sketchRegion: null,
  setSketchRegion: (sketchRegion) => {
    get().logEvent("sketch", { region: sketchRegion });
    set({ sketchRegion });
  },

  sessionLog: [],
  logEvent: (kind, data) =>
    set((s) => ({ sessionLog: [...s.sessionLog, { t: Date.now(), kind, data }] })),

  toggleSim: () => set((s) => ({ simActive: !s.simActive, simReady: false })),
  setSimMode: (m) => set({ simMode: m }),
  setAirflowStyle: (airflowStyle) => set({ airflowStyle }),
  toggleSimPause: () => set((s) => ({ simPaused: !s.simPaused })),
  setSimSource: (id) => set({ simSourceRoomId: id, simReady: false }),
  setSimReady: (v) => set({ simReady: v }),

  outdoorTemp: 30, // a warm summer day — the case the cooling goals are about
  setOutdoorTemp: (c) => set({ outdoorTemp: c }),
  tempRoomId: null,
  setTempRoom: (id) => set({ tempRoomId: id }),
  roomTempDeltas: new Map(),
  setRoomTemps: (m) => set({ roomTempDeltas: m }),

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

  applyAirflowPreset: (preset) => {
    if (get().optimizing) return;
    const spec = PRESETS[preset];
    set({ optimizing: true });
    // Defer the sim-scored search a tick so the "Optimizing…" state paints.
    window.setTimeout(() => {
      try {
        const s = get();
        const before = s.plan;
        const items = before.items.map((it) => {
          const d = spec.devices[it.type];
          if (!d) return it;
          return { ...it, on: d.on, power: d.power, ...(it.type === "fan" ? { oscillate: !!d.oscillate } : {}) };
        });
        const exterior = (o: Opening) => o.rooms.includes("outside");
        const setOpen = (o: Opening): Opening => {
          // The entrance (an exterior door) is never auto-opened — people don't
          // leave their front door wide open. Windows handle exterior venting.
          if (o.kind === "door" && exterior(o)) return o;
          const open = exterior(o) ? spec.windows : o.kind === "door" ? spec.interiorDoors : spec.windows;
          return open === o.open ? o : { ...o, open };
        };
        const withOpenings: FloorPlan = {
          ...before,
          items,
          doors: before.doors.map(setOpen),
          windows: before.windows.map(setOpen),
          walls: before.walls.map((w) => ({ ...w, openings: w.openings.map(setOpen) })),
        };
        // Search the user's actual layout for the best device placement.
        const result = searchOptimize(withOpenings, PRESET_GOAL[preset], null);
        const after: FloorPlan = { ...withOpenings, items: result.items };
        const lines = [...diffPlan(before, after), ...result.changes];
        get().logEvent("preset", { preset, lines });
        set({
          ...snapshot(s),
          plan: after,
          pendingChange: { title: spec.label, lines: lines.length ? lines : ["Already set — no change."] },
          optimizing: false,
        });
      } catch {
        set({ optimizing: false });
      }
    }, 30);
  },

  solutionOptions: [],
  solutionGoal: null,
  solutionTargets: [],
  dismissSolutions: () => set({ solutionOptions: [], solutionGoal: null, solutionTargets: [] }),

  chooseSolution: (index) => {
    const s = get();
    const sol = s.solutionOptions[index];
    if (!sol) return;
    const before = s.plan;
    const lines = [...diffPlan(before, sol.plan), ...sol.detail];
    s.logEvent("goal", { text: s.solutionGoal, chosen: sol.id, option: index, lines });
    set({
      ...snapshot(s),
      plan: sol.plan,
      pendingChange: {
        title: `${sol.label} — for “${(s.solutionGoal ?? "").trim().slice(0, 40)}”`,
        lines: lines.length ? lines : ["Already set — no change."],
      },
      solutionOptions: [],
      solutionGoal: null,
      solutionTargets: [],
    });
  },

  applyBestSolution: (goalText) => {
    if (get().optimizing) return false;
    const objs = parseGoal(goalText, get().plan, get().sketchRegion);
    const obj = objs[0];
    if (!obj) return false;
    // Every room the goal named, not just the first. "Cool the living room and
    // the bedroom" used to keep objs[0] and silently discard the rest, so the
    // optimizer only ever worked on one of the two rooms the user asked about.
    const targetIds = Array.from(
      new Set(objs.filter((o) => o.scalar === obj.scalar && o.regionId).map((o) => o.regionId!)),
    );
    // A calm-air goal ("no draft on the bed") wants LESS air movement — quiet
    // the movers rather than searching for a stronger layout.
    const calm = obj.scalar === "draft" && obj.direction === "low";
    const goal: OptimizeGoal =
      obj.scalar === "temperature"
        ? obj.direction === "low"
          ? "cool"
          : "warm"
        : obj.scalar === "draft"
          ? "circulate"
          : "ventilate";
    set({ optimizing: true });
    window.setTimeout(() => {
      try {
        const s = get();
        const before = s.plan;
        if (calm) {
          // A calm-air goal ("no draft on the bed") wants LESS air movement —
          // quiet the movers rather than searching for a stronger layout.
          const items = before.items.map((it) =>
            it.type === "fan" ? { ...it, on: false } : it.type === "ac" ? { ...it, power: 1 } : it,
          );
          const after: FloorPlan = { ...before, items };
          const lines = [...diffPlan(before, after), `Quieted the air movers so ${obj.regionName ?? "the area"} stays calm`];
          get().logEvent("goal", { text: goalText, objective: obj, lines });
          set({
            ...snapshot(s),
            plan: after,
            pendingChange: { title: `Calm air — “${goalText.trim().slice(0, 40)}”`, lines },
            optimizing: false,
          });
          return;
        }
        const options = findSolutions(before, goal, targetIds, { outdoorTemp: s.outdoorTemp, want: 3 });
        get().logEvent("goal", {
          text: goalText,
          objective: obj,
          targets: targetIds,
          offered: options.map((o) => ({ id: o.id, label: o.label, score: o.score })),
        });
        set({
          solutionOptions: options,
          solutionGoal: goalText,
          solutionTargets: targetIds,
          optimizing: false,
        });
      } catch {
        set({ optimizing: false });
      }
    }, 30);
    return true;
  },

  optimizing: false,
  pendingChange: null,
  acceptChange: () => {
    get().logEvent("review", { decision: "accept", title: get().pendingChange?.title });
    set({ pendingChange: null });
  },
  cancelChange: () => {
    get().logEvent("review", { decision: "cancel", title: get().pendingChange?.title });
    get().undo();
    set({ pendingChange: null });
  },

  generate: (size, mode) =>
    set({
      plan: mode === "blank" ? generateEmpty(size) : generateHome(size),
      sketchRegion: null,
      started: true,
      scenarioId: null,
      tools: FREE_TOOLS,
      selectedId: null,
      selectedWallId: null,
      selectedOpeningId: null,
      draggingId: null,
      draggingOpeningId: null,
      mode: "select",
      past: [],
      future: [],
    }),

  scenarioId: null,
  tools: FREE_TOOLS,

  startScenario: (id) => {
    const sc = SCENARIOS[id];
    set({
      plan: sc.build(),
      scenarioId: id,
      tools: sc.tools,
      outdoorTemp: sc.outdoorTemp, // fixed by the task; the UI locks the control
      sketchRegion: null,
      started: true,
      selectedId: null,
      selectedWallId: null,
      selectedOpeningId: null,
      draggingId: null,
      draggingOpeningId: null,
      mode: "select",
      simActive: false,
      simReady: false,
      solutionOptions: [],
      solutionGoal: null,
      solutionTargets: [],
      pendingChange: null,
      sessionLog: [{ t: Date.now(), kind: "preset", data: { scenario: id, title: sc.title } }],
      past: [],
      future: [],
    });
  },

  exitScenario: () => set({ scenarioId: null, tools: FREE_TOOLS, started: false }),

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
      if (moved) {
        // furniture defines room identity — re-name rooms after a move
        set((s) => ({ past: [...s.past, snap].slice(-HISTORY), future: [], plan: autoNameRooms(s.plan) }));
      }
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
  // Relocate an opening to the nearest wall of the room it belongs to, so a
  // window can travel around ITS room's walls rather than being stuck sliding
  // along the one it was built on.
  moveOpeningToPoint: (id, x, z) =>
    set((s) => {
      const o = [...s.plan.doors, ...s.plan.windows].find((v) => v.id === id);
      if (!o || o.fixed) return {};
      const roomId = o.rooms.find((r) => r !== "outside");
      const room = s.plan.rooms.find((r) => r.id === roomId);
      if (!room) return {};
      const { x: rx, z: rz, w, d } = room.rect;
      const half = o.width / 2;
      const M = 0.12; // keep clear of the corners
      // the four walls of this room, as (axis, line, along-range)
      // A window has to give onto the OUTSIDE, so only walls with nothing behind
      // them qualify — the wall this room shares with the next one would make an
      // interior window looking into the living room.
      const outward = (px: number, pz: number) => !s.plan.rooms.some((r) => rectContains(r.rect, px, pz));
      const mid = { x: rx + w / 2, z: rz + d / 2 };
      const E = 0.12;
      const sides = [
        { axis: "x" as const, line: rz, lo: rx, hi: rx + w, dist: Math.abs(z - rz), out: outward(mid.x, rz - E) },
        { axis: "x" as const, line: rz + d, lo: rx, hi: rx + w, dist: Math.abs(z - (rz + d)), out: outward(mid.x, rz + d + E) },
        { axis: "z" as const, line: rx, lo: rz, hi: rz + d, dist: Math.abs(x - rx), out: outward(rx - E, mid.z) },
        { axis: "z" as const, line: rx + w, lo: rz, hi: rz + d, dist: Math.abs(x - (rx + w)), out: outward(rx + w + E, mid.z) },
      ].filter((sd) => sd.hi - sd.lo >= o.width + 2 * M && (o.kind !== "window" || sd.out));
      if (!sides.length) return {};
      const side = sides.reduce((b, sd) => (sd.dist < b.dist ? sd : b), sides[0]);
      const want = side.axis === "x" ? x : z;
      const centre = Math.min(side.hi - M - half, Math.max(side.lo + M + half, want));
      // don't land on top of another opening on that same line
      const clash = [...s.plan.doors, ...s.plan.windows].some((v) => {
        if (v.id === id) return false;
        const sp = openingSpan(v);
        if (sp.axis !== side.axis || Math.abs(sp.line - side.line) > 1e-3) return false;
        return centre + half > sp.s - 0.06 && centre - half < sp.e + 0.06;
      });
      if (clash) return {};
      const moved: Opening = {
        ...o,
        a: side.axis === "z" ? [side.line, centre - half] : [centre - half, side.line],
        b: side.axis === "z" ? [side.line, centre + half] : [centre + half, side.line],
      };
      // re-carve: drop it from every wall, then cut it into the new one
      const walls = s.plan.walls.map((wl) => ({ ...wl, openings: wl.openings.filter((v) => v.id !== id) }));
      carveOpening(walls, moved);
      const swap = (arr: Opening[]) => arr.map((v) => (v.id === id ? moved : v));
      return {
        ...snapshot(s),
        plan: { ...s.plan, walls, doors: swap(s.plan.doors), windows: swap(s.plan.windows) },
      };
    }),

  moveOpeningAlong: (id, alongCenter) =>
    set((s) => {
      const o = [...s.plan.doors, ...s.plan.windows].find((x) => x.id === id);
      if (!o || o.fixed) return {};
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
    const { plan, scenarioId } = get();
    const { bounds, wallHeight } = plan;
    // In a study task, some appliances are one-per-home — refuse to add a second.
    if (scenarioId && ADD_LIMIT[type] && plan.items.filter((it) => it.type === type).length >= ADD_LIMIT[type]) {
      return null;
    }
    // Drop new items into an EMPTY spot in the largest room — not the bounding-box
    // centre (empty non-room space in an L-shaped home) and not on top of existing
    // furniture (e.g. the couch in the middle).
    const home = plan.rooms.reduce(
      (a, b) => (b.rect.w * b.rect.d > a.rect.w * a.rect.d ? b : a),
      plan.rooms[0],
    );
    const pos: Vec3 = position ??
      (home
        ? freeSpotIn(home.rect, plan.items, spec.size)
        : ([bounds.x + bounds.w / 2, 0, bounds.z + bounds.d / 2] as Vec3));
    const isVent = type === "supply" || type === "return";
    const y =
      spec.mount === "ceiling"
        ? wallHeight - 0.09
        : spec.mount === "wall"
          ? isVent ? ventMountY(wallHeight) : 1.1 // vents sit high, like a real louvre
          : spec.size[1] / 2;
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
      plan: autoNameRooms({ ...s.plan, items: [...s.plan.items, item] }),
      selectedId: id,
      selectedWallId: null,
    }));
    return id;
  },

  renameRoom: (id, name) =>
    set((s) => ({
      ...snapshot(s),
      plan: {
        ...s.plan,
        rooms: s.plan.rooms.map((r) => (r.id === id ? { ...r, name: name.trim() || r.name, renamed: true } : r)),
      },
    })),

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
    // walls changed → re-derive rooms (a from-scratch home gains real rooms)
    set((s) => ({ ...snapshot(s), plan: recomputeRooms({ ...s.plan, walls: [...s.plan.walls, wall] }) }));
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
      return { ...snapshot(s), plan: recomputeRooms({ ...s.plan, walls }), selectedWallId: null };
    }),

  addOpening: (wallId, kind) => {
    const { plan, scenarioId, tools } = get();
    if (scenarioId && tools.editOpeningSet === false) return null;
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
    set((s) => {
      const o = [...s.plan.doors, ...s.plan.windows].find((x) => x.id === id);
      // structural openings, and every opening in a task that fixes the set, stay
      if (o?.fixed || (s.scenarioId && s.tools.editOpeningSet === false)) return {};
      return {
      ...snapshot(s),
      plan: {
        ...s.plan,
        walls: s.plan.walls.map((w) => ({ ...w, openings: w.openings.filter((o) => o.id !== id) })),
        doors: s.plan.doors.filter((o) => o.id !== id),
        windows: s.plan.windows.filter((o) => o.id !== id),
      },
      selectedOpeningId: s.selectedOpeningId === id ? null : s.selectedOpeningId,
      };
    }),

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
