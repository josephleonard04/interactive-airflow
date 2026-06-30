import { compileLfmScene, type Box } from "../bc/lfm";
import type { FloorPlan, PlacedItem, Rect } from "../floorplan/types";
import { Euler3D } from "./euler3d";

// Voxelise the editor's home into a full 3D Euler simulation:
//   - walls + furniture            -> solids (furniture only blocks its real height)
//   - AC / supply vent             -> ducted inflow boundary + directed jet
//                                     (AC blows horizontally; a ceiling vent blows down)
//   - fan                          -> two-sided momentum jet (recirculating indoor air)
//   - open exterior windows/doors  -> free boundary cells (air leaves/enters)
//   - heater (hot) / AC (cold)     -> temperature sources; buoyancy lifts warm air
//   - a chosen room                -> contaminant source (full height)
//
// Coarsened to stay real-time in single-thread JS.

export interface Sim3DOptions {
  targetCells?: number;
  iterations?: number;
}

export interface Sim3D {
  sim: Euler3D;
  nx: number;
  ny: number;
  nz: number;
  dx: number;
  origin: [number, number, number];
  worldToCell: (wx: number, wy: number, wz: number) => [number, number, number];
  cellCenter: (i: number, j: number, k: number) => [number, number, number];
  setSource: (rect: Rect | null) => void;
  /** Exterior-opening cells (open windows/doors) — ambient sinks for the fill. */
  ambient: Uint8Array;
  hasTemperature: boolean;
  /** Points just in front of vents/AC/fans — where to seed airflow particles. */
  seeds: Array<[number, number, number]>;
  /** Heat (red) / cold (blue) source locations, to anchor the temperature view. */
  markers: Array<{ pos: [number, number, number]; kind: "hot" | "cold" }>;
}

const clampi = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const clampf = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

const HEATER_T = 10; // heater (warm) and AC (cool) use equal magnitude
const AC_T = -10;
const POWER: Record<number, number> = { 1: 0.5, 2: 1.0, 3: 1.6 };

export function buildSim3D(plan: FloorPlan, opts: Sim3DOptions = {}): Sim3D {
  const scene = compileLfmScene(plan);
  const g = scene.domain.gridDim;
  let nx = g[0];
  let ny = g[1]; // vertical
  let nz = g[2];
  let dx = scene.domain.dx;
  const target = opts.targetCells ?? 27000; // ~18k cells: accurate yet real-time
  if (nx * ny * nz > target) {
    const f = Math.ceil(Math.cbrt((nx * ny * nz) / target));
    nx = Math.ceil(nx / f);
    ny = Math.ceil(ny / f);
    nz = Math.ceil(nz / f);
    dx = scene.domain.dx * f;
  }
  const origin = scene.domain.gridOrigin as [number, number, number];

  const sim = new Euler3D({ nx, ny, nz, dx, iterations: opts.iterations ?? 40 });

  const worldToCell = (wx: number, wy: number, wz: number): [number, number, number] => [
    clampi(Math.floor((wx - origin[0]) / dx), 0, nx - 1),
    clampi(Math.floor((wy - origin[1]) / dx), 0, ny - 1),
    clampi(Math.floor((wz - origin[2]) / dx), 0, nz - 1),
  ];
  const cellCenter = (i: number, j: number, k: number): [number, number, number] => [
    origin[0] + (i + 0.5) * dx,
    origin[1] + (j + 0.5) * dx,
    origin[2] + (k + 0.5) * dx,
  ];
  const cellsOf = (b: Box): Array<[number, number, number]> => {
    const [i0, j0, k0] = worldToCell(b.min[0], b.min[1], b.min[2]);
    const [i1, j1, k1] = worldToCell(b.max[0], b.max[1], b.max[2]);
    const out: Array<[number, number, number]> = [];
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) out.push([i, j, k]);
    return out;
  };

  for (const s of scene.solids) for (const [i, j, k] of cellsOf(s.world)) sim.solid[sim.cIdx(i, j, k)] = 1;

  // solid ceiling at the roof line so air stays inside the house (no escaping
  // above the roof; warm air pools under the ceiling, which is correct)
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        if (origin[1] + (j + 0.5) * dx > plan.wallHeight) sim.solid[sim.cIdx(i, j, k)] = 1;
      }

  const ambient = new Uint8Array(nx * ny * nz);
  for (const p of scene.outlets)
    for (const [i, j, k] of cellsOf(p.world)) {
      const c = sim.cIdx(i, j, k);
      sim.solid[c] = 0;
      sim.open[c] = 1;
      ambient[c] = 1; // exterior opening = ambient sink for the scalar fill
    }

  const itemAabb = (it: PlacedItem): Box => {
    const [cx, cy, cz] = it.position;
    const [sw, sh, sd] = it.size;
    const q = ((Math.round(it.rotationY / (Math.PI / 2)) % 4) + 4) % 4;
    const ex = q === 1 || q === 3 ? sd : sw;
    const ez = q === 1 || q === 3 ? sw : sd;
    return { min: [cx - ex / 2, cy - sh / 2, cz - ez / 2], max: [cx + ex / 2, cy + sh / 2, cz + ez / 2] };
  };
  const horizDir = (rotY: number): [number, number, number] => {
    const q = ((Math.round(rotY / (Math.PI / 2)) % 4) + 4) % 4;
    return ([[0, 0, 1], [1, 0, 0], [0, 0, -1], [-1, 0, 0]] as [number, number, number][])[q];
  };
  const setFace = (i: number, j: number, k: number, dir: [number, number, number], speed: number) => {
    if (dir[0] !== 0) {
      const f = dir[0] > 0 ? sim.uIdx(i + 1, j, k) : sim.uIdx(i, j, k);
      sim.uFixed[f] = 1; sim.uVal[f] = dir[0] * speed;
    } else if (dir[1] !== 0) {
      const f = dir[1] > 0 ? sim.vIdx(i, j + 1, k) : sim.vIdx(i, j, k);
      sim.vFixed[f] = 1; sim.vVal[f] = dir[1] * speed;
    } else {
      const f = dir[2] > 0 ? sim.wIdx(i, j, k + 1) : sim.wIdx(i, j, k);
      sim.wFixed[f] = 1; sim.wVal[f] = dir[2] * speed;
    }
  };

  let hasTemperature = false;
  const seeds: Array<[number, number, number]> = [];
  const markers: Array<{ pos: [number, number, number]; kind: "hot" | "cold" }> = [];
  for (const it of plan.items) {
    const isAC = it.type === "ac";
    const isSupply = it.type === "supply";
    const isFan = it.type === "fan";
    const isHeater = it.type === "heater";
    if (!isAC && !isSupply && !isFan && !isHeater) continue;
    if (it.on === false) continue;
    const mult = POWER[it.power ?? 2] ?? 1;
    const cells = cellsOf(itemAabb(it));
    if (isAC) markers.push({ pos: [...it.position] as [number, number, number], kind: "cold" });
    if (isHeater) markers.push({ pos: [...it.position] as [number, number, number], kind: "hot" });

    if (isAC || isSupply || isFan) {
      const dir: [number, number, number] = isSupply ? [0, -1, 0] : horizDir(it.rotationY); // ceiling vent blows down
      const speed = (isFan ? 1.0 : clampf((it.flow ?? 0) / 0.3, 0.4, 1.5)) * mult;
      for (const [i, j, k] of cells) {
        const c = sim.cIdx(i, j, k);
        if (sim.solid[c]) sim.solid[c] = 0;
        // only AC / supply generate air → seed airflow particles here; a fan only
        // pushes existing air, so it is not a particle source
        if (isAC || isSupply) seeds.push(cellCenter(i, j, k));
        if (isFan) {
          // recirculating: two opposite faces (net-zero mass)
          if (dir[0] !== 0) { const a = sim.uIdx(i, j, k), b = sim.uIdx(i + 1, j, k); sim.uFixed[a] = sim.uFixed[b] = 1; sim.uVal[a] = sim.uVal[b] = dir[0] * speed; }
          else { const a = sim.wIdx(i, j, k), b = sim.wIdx(i, j, k + 1); sim.wFixed[a] = sim.wFixed[b] = 1; sim.wVal[a] = sim.wVal[b] = dir[2] * speed; }
          // an oscillating fan sweeps side-to-side: also push air out laterally so
          // it covers a wide arc instead of a single direction (more room coverage)
          if (it.oscillate) {
            const lat = speed * 0.55;
            if (dir[0] !== 0) {
              const f = sim.wIdx(i, j, k + 1), b = sim.wIdx(i, j, k);
              sim.wFixed[f] = 1; sim.wVal[f] = lat;
              sim.wFixed[b] = 1; sim.wVal[b] = -lat;
            } else {
              const f = sim.uIdx(i + 1, j, k), b = sim.uIdx(i, j, k);
              sim.uFixed[f] = 1; sim.uVal[f] = lat;
              sim.uFixed[b] = 1; sim.uVal[b] = -lat;
            }
          }
        } else {
          // ducted vent: free boundary cell + directed jet face. Inflow vents
          // inject clean air, so they also dilute odour locally (smell sink).
          sim.open[c] = 1;
          ambient[c] = 1;
          setFace(i, j, k, dir, speed);
        }
      }
    }
    if (isAC || isHeater) {
      const dT = (isAC ? AC_T : HEATER_T) * mult;
      for (const [i, j, k] of cells) {
        const c = sim.cIdx(i, j, k);
        if (sim.solid[c]) continue;
        sim.tempFixed[c] = 1;
        sim.tempVal[c] = dT;
        hasTemperature = true;
      }
    }
  }

  // Smell sources the user placed in the scene (drag-and-drop icons). These are
  // the base smell sources; setSource can add a whole-room source on top.
  const baseSmell: number[] = [];
  for (const it of plan.items) {
    if (it.type !== "smell" || it.on === false) continue;
    for (const [i, j, k] of cellsOf(itemAabb(it))) {
      const c = sim.cIdx(i, j, k);
      if (!sim.solid[c]) baseSmell.push(c);
    }
  }
  const applyBaseSmell = () => {
    for (const c of baseSmell) { sim.sFixed[c] = 1; sim.sVal[c] = 1; }
  };
  applyBaseSmell();

  const setSource = (rect: Rect | null) => {
    sim.sFixed.fill(0);
    sim.sVal.fill(0);
    applyBaseSmell(); // keep the placed smell sources
    if (!rect) return;
    const [i0, , k0] = worldToCell(rect.x, 0, rect.z);
    const [i1, , k1] = worldToCell(rect.x + rect.w, 0, rect.z + rect.d);
    for (let k = k0; k <= k1; k++)
      for (let j = 0; j < ny; j++)
        for (let i = i0; i <= i1; i++) {
          const c = sim.cIdx(i, j, k);
          if (sim.solid[c] || sim.open[c]) continue;
          sim.sFixed[c] = 1;
          sim.sVal[c] = 1;
        }
  };

  return { sim, nx, ny, nz, dx, origin, worldToCell, cellCenter, setSource, ambient, hasTemperature, seeds, markers };
}

// Steady-state scalar field carried by the AIRFLOW: advection along the converged
// velocity field plus mixing (diffusion), so temperature / smell follow the air
// currents and fill the whole connected house. Sources hold their value, exterior
// openings vent to ambient (0), walls block. One-time relaxation on the frozen
// velocity — this is what "matches the airflow" at steady state.
export function advectDiffuseFill(
  s: Sim3D,
  fixed: Uint8Array,
  val: Float32Array,
  opts?: { iters?: number; kappa?: number; adv?: number },
): Float32Array {
  const { sim, nx, ny, nz, ambient } = s;
  const iters = opts?.iters ?? 320;
  const kappa = opts?.kappa ?? 0.26; // mixing strength (higher = spreads further)
  const adv = opts?.adv ?? 0.95; // cells moved per (m/s) per iteration
  const n3 = nx * ny * nz;
  const f = new Float32Array(n3);
  const tmp = new Float32Array(n3);
  for (let c = 0; c < n3; c++) if (fixed[c]) f[c] = val[c];
  const idx = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

  const sample = (F: Float32Array, x: number, y: number, z: number, fb: number): number => {
    x = clamp(x, 0, nx - 1.001); y = clamp(y, 0, ny - 1.001); z = clamp(z, 0, nz - 1.001);
    const i0 = Math.floor(x), j0 = Math.floor(y), k0 = Math.floor(z);
    const tx = x - i0, ty = y - j0, tz = z - k0;
    const g = (i: number, j: number, k: number) => { const c = idx(i, j, k); return sim.solid[c] ? fb : F[c]; };
    const c00 = g(i0, j0, k0) * (1 - tx) + g(i0 + 1, j0, k0) * tx;
    const c10 = g(i0, j0 + 1, k0) * (1 - tx) + g(i0 + 1, j0 + 1, k0) * tx;
    const c01 = g(i0, j0, k0 + 1) * (1 - tx) + g(i0 + 1, j0, k0 + 1) * tx;
    const c11 = g(i0, j0 + 1, k0 + 1) * (1 - tx) + g(i0 + 1, j0 + 1, k0 + 1) * tx;
    return (c00 * (1 - ty) + c10 * ty) * (1 - tz) + (c01 * (1 - ty) + c11 * ty) * tz;
  };

  for (let it = 0; it < iters; it++) {
    tmp.set(f);
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const c = idx(i, j, k);
          if (sim.solid[c]) continue;
          if (fixed[c]) { f[c] = val[c]; continue; }
          if (ambient[c]) { f[c] = 0; continue; }
          // advect: trace back along the air velocity
          const uc = 0.5 * (sim.u[sim.uIdx(i, j, k)] + sim.u[sim.uIdx(i + 1, j, k)]);
          const vc = 0.5 * (sim.v[sim.vIdx(i, j, k)] + sim.v[sim.vIdx(i, j + 1, k)]);
          const wc = 0.5 * (sim.w[sim.wIdx(i, j, k)] + sim.w[sim.wIdx(i, j, k + 1)]);
          const adVal = sample(tmp, i - uc * adv, j - vc * adv, k - wc * adv, tmp[c]);
          // mix with neighbours (diffusion)
          let sum = 0, cnt = 0;
          if (i > 0 && !sim.solid[idx(i - 1, j, k)]) { sum += tmp[idx(i - 1, j, k)]; cnt++; }
          if (i < nx - 1 && !sim.solid[idx(i + 1, j, k)]) { sum += tmp[idx(i + 1, j, k)]; cnt++; }
          if (j > 0 && !sim.solid[idx(i, j - 1, k)]) { sum += tmp[idx(i, j - 1, k)]; cnt++; }
          if (j < ny - 1 && !sim.solid[idx(i, j + 1, k)]) { sum += tmp[idx(i, j + 1, k)]; cnt++; }
          if (k > 0 && !sim.solid[idx(i, j, k - 1)]) { sum += tmp[idx(i, j, k - 1)]; cnt++; }
          if (k < nz - 1 && !sim.solid[idx(i, j, k + 1)]) { sum += tmp[idx(i, j, k + 1)]; cnt++; }
          const diff = cnt > 0 ? sum / cnt : adVal;
          f[c] = adVal * (1 - kappa) + diff * kappa;
        }
  }
  return f;
}

