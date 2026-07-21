import * as THREE from "three";
import type { Sim3D } from "../sim/sim3d";
import type { Rect } from "../floorplan/types";

// Smooth, speed-coloured streamlines for the home airflow view (Xie-style).
// Paths are integrated through the steady velocity field with a midpoint (RK2)
// step for stability, then resampled along a Catmull-Rom curve so the rendered
// lines read as clean arcs rather than jagged segments.

export interface StreamlinePaths {
  /** Segment endpoint pairs (even length) for a fat-line in segments mode. */
  points: THREE.Vector3[];
  /** Per-vertex colours (speed gradient) matching `points`. */
  colors: THREE.Color[];
}

interface Vel {
  vx: number;
  vy: number;
  vz: number;
  speed: number;
  solid: boolean;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Trilinear world-space velocity sampler over the sim's cell-centred field. */
function makeSampler(built: Sim3D) {
  const { sim, nx, ny, nz, dx, origin } = built;
  const cell = (i: number, j: number, k: number): [number, number, number, number] => {
    const c = sim.cIdx(i, j, k);
    if (sim.solid[c]) return [0, 0, 0, 1];
    const [u, v, w] = sim.velocityAt(i, j, k);
    return [u, v, w, 0];
  };
  return (x: number, y: number, z: number): Vel => {
    const gx = clamp((x - origin[0]) / dx - 0.5, 0, nx - 1.001);
    const gy = clamp((y - origin[1]) / dx - 0.5, 0, ny - 1.001);
    const gz = clamp((z - origin[2]) / dx - 0.5, 0, nz - 1.001);
    const i0 = Math.floor(gx), j0 = Math.floor(gy), k0 = Math.floor(gz);
    const tx = gx - i0, ty = gy - j0, tz = gz - k0;
    let vx = 0, vy = 0, vz = 0, sol = 0;
    for (let di = 0; di < 2; di++)
      for (let dj = 0; dj < 2; dj++)
        for (let dk = 0; dk < 2; dk++) {
          const wgt = (di ? tx : 1 - tx) * (dj ? ty : 1 - ty) * (dk ? tz : 1 - tz);
          const [u, v, w, s] = cell(Math.min(nx - 1, i0 + di), Math.min(ny - 1, j0 + dj), Math.min(nz - 1, k0 + dk));
          vx += u * wgt; vy += v * wgt; vz += w * wgt; sol += s * wgt;
        }
    return { vx, vy, vz, speed: Math.hypot(vx, vy, vz), solid: sol > 0.5 };
  };
}

/**
 * Seed a SMALL, MEANINGFUL set of points: the vents/AC outlets (where air is
 * born) plus the few fastest cells of each room, keeping them spatially spread so
 * lines don't bunch up. Deliberately no dense grid — that was the source of the
 * "too many messy lines". We want a handful of clean streamlines per room that
 * trace where the air actually goes.
 */
function seedPoints(
  built: Sim3D,
  sample: (x: number, y: number, z: number) => Vel,
  maxSeeds: number,
  rooms: Rect[] = [],
  minSpeed: number,
): THREE.Vector3[] {
  const { nx, ny, nz, cellCenter } = built;
  const out: THREE.Vector3[] = [];
  const sep = Math.max(built.dx * 3, 0.6); // metres between seeds
  // Vent seeds cluster on the AC/supply (many cells, one line each) → thin them
  // by spacing so the source room isn't a tangle of lines.
  for (const s of built.seeds) {
    const p = new THREE.Vector3(s[0], s[1], s[2]);
    if (out.every((q) => q.distanceTo(p) > sep * 0.8)) out.push(p);
  }

  // Per-room: pick the strongest-flow cells, but spaced apart (min separation)
  // so we get a few representative lines, not a cluster on one jet.
  const perRoom = rooms.length ? Math.max(2, Math.floor((maxSeeds - out.length) / rooms.length)) : 4;
  const rlist: Rect[] = rooms.length ? rooms : [{ x: built.origin[0], z: built.origin[2], w: nx * built.dx, d: nz * built.dx, y: 0, h: 0 } as unknown as Rect];
  for (const r of rlist) {
    const cands: Array<{ p: THREE.Vector3; s: number }> = [];
    for (let k = 1; k < nz - 1; k++)
      for (let j = 1; j < ny - 1; j += 2)
        for (let i = 1; i < nx - 1; i++) {
          const [x, y, z] = cellCenter(i, j, k);
          if (x < r.x || x > r.x + r.w || z < r.z || z > r.z + r.d) continue;
          const v = sample(x, y, z);
          if (!v.solid && v.speed > minSpeed) cands.push({ p: new THREE.Vector3(x, y, z), s: v.speed });
        }
    cands.sort((a, b) => b.s - a.s);
    const picked: THREE.Vector3[] = [];
    for (const c of cands) {
      if (picked.length >= perRoom) break;
      if (picked.every((q) => q.distanceTo(c.p) > sep)) picked.push(c.p);
    }
    out.push(...picked);
  }
  if (out.length > maxSeeds) return out.slice(0, maxSeeds);
  return out;
}

export function buildStreamlinePaths(
  built: Sim3D,
  opts: { maxSeeds?: number; color?: string; roofY?: number; rooms?: Rect[] } = {},
): StreamlinePaths {
  const points: THREE.Vector3[] = [];
  const colors: THREE.Color[] = [];
  const sample = makeSampler(built);
  const { origin, dx, nx, ny, nz } = built;

  const x0 = origin[0], y0 = origin[1], z0 = origin[2];
  const x1 = x0 + nx * dx, y1 = Math.min(y0 + ny * dx, opts.roofY ?? y0 + ny * dx), z1 = z0 + nz * dx;
  // A line stops at the grid edge AND at the front door: past an open window the
  // air is outdoors, and the tool visualizes the home. Without the `inside` test
  // streamlines shot out of open windows and trailed across the garden.
  const { inside, worldToCell, sim } = built;
  const inHouse = (p: THREE.Vector3) => {
    const [i, j, k] = worldToCell(p.x, p.y, p.z);
    return inside[sim.cIdx(i, j, k)] === 1;
  };
  const inBounds = (p: THREE.Vector3) =>
    p.x > x0 && p.x < x1 && p.y > y0 && p.y < y1 && p.z > z0 && p.z < z1 && inHouse(p);

  const white = new THREE.Color(opts.color ?? "#ffffff");
  // A line has to carry real air along MOST of its length, not just touch one
  // fast cell somewhere. Peak-only was letting through lines that were mostly
  // coasted (see stallBudget below) — they read as confident airflow in rooms
  // where the air is essentially still.
  const MIN_SPEED = 0.06; // fastest point on the line
  const MIN_MEAN_SPEED = 0.03; // and its average, so a lucky cell isn't enough
  const MIN_POINTS = 8; // and trace a real path, not a stub
  const step = dx * 0.75;
  const maxSteps = 120;
  const seeds = seedPoints(built, sample, opts.maxSeeds ?? 14, opts.rooms ?? [], 0.02);

  const s1 = new THREE.Vector3();
  const s2 = new THREE.Vector3();
  const mid = new THREE.Vector3();
  const lastDir = new THREE.Vector3();
  // Weak air still moves: when the sampled velocity is tiny, coast along the
  // previous direction at reduced pace so a line can cross a slow patch (a
  // doorway threshold) instead of stopping dead. But the coast is INVENTED
  // motion — the solver says the air is not moving there — so the allowance is
  // small and the threshold is a real speed, not "numerically zero". Coasting
  // 10 steps below 0.001 m/s is what drew confident streamlines through a still
  // bedroom.
  const COAST_BELOW = 0.02; // m/s — under this the flow is not meaningfully moving
  const stepVec = (p: THREE.Vector3, out: THREE.Vector3): "ok" | "weak" | "dead" => {
    const v = sample(p.x, p.y, p.z);
    out.set(v.vx, v.vy, v.vz);
    if (out.length() >= COAST_BELOW) {
      out.setLength(step);
      return "ok";
    }
    if (lastDir.lengthSq() > 1e-8) {
      out.copy(lastDir).setLength(step * 0.4);
      return "weak";
    }
    return "dead";
  };

  for (const seed of seeds) {
    const p = seed.clone();
    const raw: THREE.Vector3[] = [p.clone()];
    lastDir.set(0, 0, 0);
    let stallBudget = 3;
    let peak = 0;
    let speedSum = 0;
    let speedN = 0;
    for (let n = 0; n < maxSteps; n++) {
      if (!inBounds(p) || sample(p.x, p.y, p.z).solid) break;
      const sp = sample(p.x, p.y, p.z).speed;
      peak = Math.max(peak, sp);
      speedSum += sp;
      speedN++;
      const q1 = stepVec(p, s1); // RK2 midpoint
      if (q1 === "dead") break;
      mid.copy(p).addScaledVector(s1, 0.5);
      const q2 = stepVec(mid, s2);
      if (q2 === "dead") break;
      if (q1 === "weak" || q2 === "weak") {
        if (--stallBudget <= 0) break;
      }
      const next = p.clone().add(s2);
      // test the point we are about to COMMIT, not just the one we came from —
      // otherwise every line overshoots one step past the wall before stopping,
      // which is how streamlines were poking out through open windows
      if (sample(next.x, next.y, next.z).solid || !inBounds(next)) break;
      lastDir.copy(s2);
      raw.push(next);
      p.copy(next);
    }
    // meaningful only: a real path that carries real air along most of itself
    if (raw.length < MIN_POINTS || peak < MIN_SPEED) continue;
    if (speedN === 0 || speedSum / speedN < MIN_MEAN_SPEED) continue;

    const curve = new THREE.CatmullRomCurve3(raw, false, "centripetal");
    const divisions = Math.min(80, raw.length * 3);
    const smooth = curve.getPoints(divisions);
    // single flat colour (white) — no speed gradient, so the view stays clean
    for (let i = 0; i < smooth.length - 1; i++) {
      points.push(smooth[i], smooth[i + 1]);
      colors.push(white.clone(), white.clone());
    }
  }

  return { points, colors };
}
