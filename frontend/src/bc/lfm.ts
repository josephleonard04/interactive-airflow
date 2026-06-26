import { WALL_THICKNESS, wallPieces } from "../floorplan/geometry";
import type { FloorPlan, Opening, PlacedItem } from "../floorplan/types";

// Compile the editor's home into an LFM-ready scene description.
//
// This is the real simulator seam (cf. the solver-neutral exportBoundaryConditions).
// It maps the metric room into LFM's grid, turns walls + furniture into solid
// boxes, and turns vents / AC / open windows & doors into inlet / outlet velocity
// patches — with the **incompressibility constraint enforced**: total inlet flux
// must equal total outlet flux (confirmed with Yuchen Sun, 2026-06). LFM's grid:
// the domain is tile_dim*8 cells per axis and dx = len_y / (8 * tile_dim.y); see
// simulator/lfm/src/lfm/lfm_init.cu and config.h (LFMConfiguration).
//
// The numeric arrays LFM ingests (solid SDF npy, init velocity npy, the staggered
// is_bc / bc_val faces) are produced by bridge/lfm_bridge.py from this JSON — the
// browser stays in pure-data land so the whole pipeline is testable without a GPU.

export type V3 = [number, number, number];

export interface Box {
  min: V3;
  max: V3;
}

/** A solid obstacle (no-slip): wall piece, filled-in closed opening, or furniture. */
export interface SolidBox {
  id: string;
  kind: "wall" | "closed-opening" | "furniture";
  world: Box;
}

/** An inlet/outlet velocity patch on the grid: a thin box plus a flow vector. */
export interface FlowPatch {
  id: string;
  source: string; // originating item / opening id
  kind: string; // ac | supply | window | door
  role: "inlet" | "outlet";
  world: Box;
  normal: V3; // unit, axis-aligned; points the way air flows (into domain / out)
  area: number; // m^2 of the emitting/exhausting face
  flux: number; // m^3/s, non-negative
  speed: number; // m/s = flux / area
  velocity: V3; // normal * speed
}

/** A fan: internal momentum source, mass-neutral (NOT part of the flux balance). */
export interface FanSource {
  id: string;
  world: Box;
  normal: V3;
  flux: number; // m^3/s it pushes (recirculation)
}

/** A heat source (heater): box region held above ambient, drives buoyancy. */
export interface HeatSource {
  id: string;
  world: Box;
  deltaT: number; // K above ambient
}

export interface FluxBalance {
  inflow: number; // m^3/s supplied
  outflow: number; // m^3/s exhausted
  balanced: boolean;
  note?: string;
}

export interface LfmDomain {
  tileDim: V3; // LFM tiles (8 cells each)
  gridDim: V3; // 8 * tileDim — actual cell counts
  dx: number; // metres / cell
  lenY: number; // physical height that pins dx = lenY / gridDim.y
  gridOrigin: V3; // world coords of cell (0,0,0)'s min corner
  cellCount: number;
}

/** The LFMConfiguration block (config.h). *_path fields are filled by the bridge. */
export interface LfmConfig {
  reinit_every: number;
  len_y: number;
  tile_dim: V3;
  grid_origin: V3;
  inlet_norm: number;
  inlet_angle: number;
  rk_order: number;
  num_smoke: number;
  use_bfecc_clamp: boolean;
  use_static_solid: boolean;
}

export interface LfmScene {
  name: string;
  ambientT: number; // K, reference temperature for buoyancy
  domain: LfmDomain;
  solids: SolidBox[];
  inlets: FlowPatch[];
  outlets: FlowPatch[];
  fans: FanSource[];
  heatSources: HeatSource[];
  balance: FluxBalance;
  lfmConfig: LfmConfig;
}

// ---- tunables ----

const TARGET_DX = 0.08; // ~8 cm cells: a good real-time/accuracy trade-off
const MAX_CELLS = 6_000_000; // keep the grid runnable; dx grows if exceeded
const AMBIENT_T = 293.15; // 20 °C
const HEATER_DELTA_T = 15; // K above ambient for a heater region
const DEFAULT_FAN_FLUX = 0.3; // m^3/s if a fan has no flow set

// ---- small vector helpers ----

const prod3 = (v: V3): number => v[0] * v[1] * v[2];

/** Axis-aligned world AABB of an item, honouring 90° yaw (swaps x/z extents). */
function worldAABB(it: PlacedItem): Box {
  const [cx, cy, cz] = it.position;
  const [sw, sh, sd] = it.size;
  const quarter = ((Math.round(it.rotationY / (Math.PI / 2)) % 4) + 4) % 4;
  const ex = quarter === 1 || quarter === 3 ? sd : sw;
  const ez = quarter === 1 || quarter === 3 ? sw : sd;
  return {
    min: [cx - ex / 2, cy - sh / 2, cz - ez / 2],
    max: [cx + ex / 2, cy + sh / 2, cz + ez / 2],
  };
}

const boxExtents = (b: Box): V3 => [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];

/** Face area perpendicular to an axis-aligned normal. */
function areaPerp(b: Box, n: V3): number {
  const [ex, ey, ez] = boxExtents(b);
  if (Math.abs(n[0]) > 0.5) return ey * ez;
  if (Math.abs(n[1]) > 0.5) return ex * ez;
  return ex * ey;
}

/** Inward-facing normal for a wall/ceiling/floor-mounted item (the way it blows). */
function inwardNormal(it: PlacedItem): V3 {
  if (it.mount === "ceiling") return [0, -1, 0];
  if (it.mount === "floor") return [0, 1, 0];
  // wall mount: derive from yaw. rotationY 0→+z, π/2→+x, π→-z, -π/2→-x.
  const quarter = ((Math.round(it.rotationY / (Math.PI / 2)) % 4) + 4) % 4;
  return ([
    [0, 0, 1],
    [1, 0, 0],
    [0, 0, -1],
    [-1, 0, 0],
  ] as V3[])[quarter];
}

// ---- domain ----

function mapDomain(plan: FloorPlan): LfmDomain {
  const { w, d } = plan.bounds;
  const H = plan.wallHeight;
  const pad = WALL_THICKNESS; // keep exterior walls strictly inside the grid
  const extent: V3 = [w + 2 * pad, H + pad, d + 2 * pad];

  let dx = TARGET_DX;
  const tilesFor = (ext: number): number => Math.max(1, Math.ceil(ext / (8 * dx)));
  let tileDim: V3 = [tilesFor(extent[0]), tilesFor(extent[1]), tilesFor(extent[2])];
  // grow dx until the grid fits the cell budget
  while (prod3([8 * tileDim[0], 8 * tileDim[1], 8 * tileDim[2]]) > MAX_CELLS) {
    dx *= 1.25;
    tileDim = [tilesFor(extent[0]), tilesFor(extent[1]), tilesFor(extent[2])];
  }
  const gridDim: V3 = [8 * tileDim[0], 8 * tileDim[1], 8 * tileDim[2]];
  // LFM derives dx = len_y / gridDim.y, so pin len_y to honour our chosen dx.
  const lenY = dx * gridDim[1];
  const gridOrigin: V3 = [plan.bounds.x - pad, 0, plan.bounds.z - pad];
  return { tileDim, gridDim, dx, lenY, gridOrigin, cellCount: prod3(gridDim) };
}

// ---- solids ----

function solidsFromPlan(plan: FloorPlan): SolidBox[] {
  const out: SolidBox[] = [];

  for (const wall of plan.walls) {
    // wallPieces gives the solid runs around openings (it always leaves the
    // opening void). For CLOSED openings we then refill the void as solid.
    for (const [i, p] of wallPieces(wall).entries()) {
      out.push({
        id: `${wall.id}-p${i}`,
        kind: "wall",
        world: {
          min: [p.center[0] - p.size[0] / 2, p.center[1] - p.size[1] / 2, p.center[2] - p.size[2] / 2],
          max: [p.center[0] + p.size[0] / 2, p.center[1] + p.size[1] / 2, p.center[2] + p.size[2] / 2],
        },
      });
    }
    for (const o of wall.openings) {
      if (!o.open) out.push({ id: `${o.id}-shut`, kind: "closed-opening", world: openingBox(o, wall.thickness) });
    }
  }

  for (const it of plan.items) {
    if (it.category === "furniture") out.push({ id: it.id, kind: "furniture", world: worldAABB(it) });
  }
  return out;
}

/** The void box of an opening (the hole it cuts), thickened across the wall. */
function openingBox(o: Opening, thickness: number): Box {
  const vertical = Math.abs(o.a[0] - o.b[0]) < 1e-3; // constant x → spans z
  const t = thickness / 2 + 0.02;
  if (vertical) {
    const x = o.a[0];
    const [z0, z1] = [Math.min(o.a[1], o.b[1]), Math.max(o.a[1], o.b[1])];
    return { min: [x - t, o.sill, z0], max: [x + t, o.sill + o.height, z1] };
  }
  const z = o.a[1];
  const [x0, x1] = [Math.min(o.a[0], o.b[0]), Math.max(o.a[0], o.b[0])];
  return { min: [x0, o.sill, z - t], max: [x1, o.sill + o.height, z + t] };
}

// ---- inlets / outlets / fans / heat ----

function inletsFromItems(plan: FloorPlan): FlowPatch[] {
  const out: FlowPatch[] = [];
  for (const it of plan.items) {
    const isInlet = it.type === "ac" || it.type === "supply";
    const flux = it.flow ?? 0;
    if (!isInlet || flux <= 0) continue;
    const world = worldAABB(it);
    const normal = inwardNormal(it);
    const area = areaPerp(world, normal);
    const speed = area > 0 ? flux / area : 0;
    out.push({
      id: `inlet-${it.id}`,
      source: it.id,
      kind: it.type,
      role: "inlet",
      world,
      normal,
      area,
      flux,
      speed,
      velocity: [normal[0] * speed, normal[1] * speed, normal[2] * speed],
    });
  }
  return out;
}

/** Outward normal of an exterior opening (points away from the room, outside). */
function outwardNormal(plan: FloorPlan, o: Opening): V3 {
  const vertical = Math.abs(o.a[0] - o.b[0]) < 1e-3;
  const mid = vertical
    ? [o.a[0], (o.a[1] + o.b[1]) / 2]
    : [(o.a[0] + o.b[0]) / 2, o.a[1]];
  const inAnyRoom = (x: number, z: number): boolean =>
    plan.rooms.some((r) => x > r.rect.x + 1e-3 && x < r.rect.x + r.rect.w - 1e-3 && z > r.rect.z + 1e-3 && z < r.rect.z + r.rect.d - 1e-3);
  const probe = 0.1;
  if (vertical) {
    return inAnyRoom(mid[0] + probe, mid[1]) ? [-1, 0, 0] : [1, 0, 0];
  }
  return inAnyRoom(mid[0], mid[1] + probe) ? [0, 0, -1] : [0, 0, 1];
}

function openExteriorOutlets(plan: FloorPlan): Array<{ o: Opening; normal: V3; area: number; world: Box }> {
  const res: Array<{ o: Opening; normal: V3; area: number; world: Box }> = [];
  for (const o of [...plan.doors, ...plan.windows]) {
    const exterior = o.rooms.includes("outside");
    if (!exterior || !o.open) continue;
    const normal = outwardNormal(plan, o);
    const world = openingBox(o, WALL_THICKNESS);
    res.push({ o, normal, area: o.width * o.height, world });
  }
  return res;
}

/** Build flux-balanced outlets from the open exterior openings. */
function balancedOutlets(plan: FloorPlan, inflow: number): { outlets: FlowPatch[]; balance: FluxBalance } {
  const candidates = openExteriorOutlets(plan);
  const totalArea = candidates.reduce((s, c) => s + c.area, 0);

  if (inflow <= 1e-9) {
    return {
      outlets: candidates.map((c) => mkOutlet(c, 0)),
      balance: { inflow: 0, outflow: 0, balanced: true, note: "No forced inflow — flow is buoyancy-driven only." },
    };
  }
  if (totalArea <= 1e-9) {
    return {
      outlets: [],
      balance: {
        inflow,
        outflow: 0,
        balanced: false,
        note: `${inflow.toFixed(3)} m³/s supplied but no open exterior window/door to exhaust it — open one so the air can leave (the solver is incompressible).`,
      },
    };
  }
  // uniform outflow speed; flux split by area so Σ outlet = inflow
  const speed = inflow / totalArea;
  const outlets = candidates.map((c) => mkOutlet(c, c.area * speed));
  return { outlets, balance: { inflow, outflow: inflow, balanced: true } };
}

function mkOutlet(c: { o: Opening; normal: V3; area: number; world: Box }, flux: number): FlowPatch {
  const speed = c.area > 0 ? flux / c.area : 0;
  return {
    id: `outlet-${c.o.id}`,
    source: c.o.id,
    kind: c.o.kind,
    role: "outlet",
    world: c.world,
    normal: c.normal,
    area: c.area,
    flux,
    speed,
    velocity: [c.normal[0] * speed, c.normal[1] * speed, c.normal[2] * speed],
  };
}

function fansFromItems(plan: FloorPlan): FanSource[] {
  return plan.items
    .filter((it) => it.type === "fan")
    .map((it) => {
      const normal = inwardNormal(it);
      return { id: it.id, world: worldAABB(it), normal, flux: it.flow && it.flow > 0 ? it.flow : DEFAULT_FAN_FLUX };
    });
}

function heatSourcesFromItems(plan: FloorPlan): HeatSource[] {
  return plan.items
    .filter((it) => it.type === "heater")
    .map((it) => ({ id: it.id, world: worldAABB(it), deltaT: HEATER_DELTA_T }));
}

// ---- top level ----

export function compileLfmScene(plan: FloorPlan): LfmScene {
  const domain = mapDomain(plan);
  const solids = solidsFromPlan(plan);
  const inlets = inletsFromItems(plan);
  const inflow = inlets.reduce((s, p) => s + p.flux, 0);
  const { outlets, balance } = balancedOutlets(plan, inflow);
  const fans = fansFromItems(plan);
  const heatSources = heatSourcesFromItems(plan);

  const lfmConfig: LfmConfig = {
    reinit_every: 5,
    len_y: domain.lenY,
    tile_dim: domain.tileDim,
    grid_origin: domain.gridOrigin,
    inlet_norm: 0, // per-face BCs are used instead of the uniform boundary inflow
    inlet_angle: 0,
    rk_order: 4,
    num_smoke: 0,
    use_bfecc_clamp: true,
    use_static_solid: true,
  };

  return { name: plan.name, ambientT: AMBIENT_T, domain, solids, inlets, outlets, fans, heatSources, balance, lfmConfig };
}
