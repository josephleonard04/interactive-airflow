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

/** The one colour every airflow line is drawn in. */
export const STREAMLINE_BLUE = "#2f7ff0";

/** Trilinear world-space velocity sampler over the sim's cell-centred field.
 *
 *  NOTE — this is the one part of the visualization NOT rolled back with the
 *  rest. The original decided "is this point solid?" from the INTERPOLATED solid
 *  fraction (`sol > 0.5`); an interior wall is one cell thick, so a point
 *  genuinely inside a wall blends to a fraction under 1 and was reported as open
 *  air. It also blended velocity from the cells on BOTH sides of that wall into
 *  one vector, which is a velocity pointing straight through it. Together those
 *  are what let streamlines cross walls. Solidity is now the cell the point is
 *  actually in, and solid cells are excluded from the blend. Invisible when the
 *  air is behaving; the reason lines stay in their room. */
function makeSampler(built: Sim3D) {
  const { sim, nx, ny, nz, dx, origin } = built;
  const cellOf = (x: number, y: number, z: number): number => {
    const i = clamp(Math.floor((x - origin[0]) / dx), 0, nx - 1) | 0;
    const j = clamp(Math.floor((y - origin[1]) / dx), 0, ny - 1) | 0;
    const k = clamp(Math.floor((z - origin[2]) / dx), 0, nz - 1) | 0;
    return sim.cIdx(i, j, k);
  };
  return (x: number, y: number, z: number): Vel => {
    if (sim.solid[cellOf(x, y, z)]) return { vx: 0, vy: 0, vz: 0, speed: 0, solid: true };
    const gx = clamp((x - origin[0]) / dx - 0.5, 0, nx - 1.001);
    const gy = clamp((y - origin[1]) / dx - 0.5, 0, ny - 1.001);
    const gz = clamp((z - origin[2]) / dx - 0.5, 0, nz - 1.001);
    const i0 = Math.floor(gx), j0 = Math.floor(gy), k0 = Math.floor(gz);
    const tx = gx - i0, ty = gy - j0, tz = gz - k0;
    let vx = 0, vy = 0, vz = 0, wSum = 0;
    for (let di = 0; di < 2; di++)
      for (let dj = 0; dj < 2; dj++)
        for (let dk = 0; dk < 2; dk++) {
          const i = Math.min(nx - 1, i0 + di), j = Math.min(ny - 1, j0 + dj), k = Math.min(nz - 1, k0 + dk);
          const c = sim.cIdx(i, j, k);
          if (sim.solid[c]) continue; // never blend air across a wall
          const wgt = (di ? tx : 1 - tx) * (dj ? ty : 1 - ty) * (dk ? tz : 1 - tz);
          const [u, v, w] = sim.velocityAt(i, j, k);
          vx += u * wgt; vy += v * wgt; vz += w * wgt; wSum += wgt;
        }
    if (wSum > 1e-6) { vx /= wSum; vy /= wSum; vz /= wSum; }
    return { vx, vy, vz, speed: Math.hypot(vx, vy, vz), solid: false };
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
  gateways: Array<[number, number, number]> = [],
): THREE.Vector3[] {
  const { nx, ny, nz, cellCenter } = built;
  const out: THREE.Vector3[] = [];
  const sep = Math.max(built.dx * 3, 0.6); // metres between seeds

  // DOORWAYS FIRST. Seeding only inside rooms produced lines that mostly
  // circulated within the room they started in, so the picture answered "what is
  // the air doing in here?" but never "how does air get from here to there?".
  // A doorway is exactly where the between-room flow passes, so a line seeded in
  // one is the whole-house path — and because lines are traced in both
  // directions from their seed, it reaches back into the room the air came from
  // and forward into the one it is going to.
  for (const g of gateways) {
    const p = new THREE.Vector3(g[0], g[1], g[2]);
    const v = sample(p.x, p.y, p.z);
    if (v.solid) continue;
    if (out.every((q) => q.distanceTo(p) > sep * 0.5)) out.push(p);
  }

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
  opts: {
    maxSeeds?: number;
    color?: string;
    roofY?: number;
    rooms?: Rect[];
    /** World points in the open doorways — seeded first so the between-room
     *  paths are always represented, not left to chance. */
    gateways?: Array<[number, number, number]>;
  } = {},
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

  const lineColor = new THREE.Color(opts.color ?? STREAMLINE_BLUE);
  const MIN_SPEED = 0.05; // a line must carry real air somewhere, else it's noise
  const MIN_POINTS = 6; // and trace a real path, not a stub
  const step = dx * 0.75;
  const maxSteps = 170;
  const seeds = seedPoints(built, sample, opts.maxSeeds ?? 30, opts.rooms ?? [], 0.02, opts.gateways ?? []);

  const s1 = new THREE.Vector3();
  const s2 = new THREE.Vector3();
  const mid = new THREE.Vector3();
  const lastDir = new THREE.Vector3();
  // Weak air still moves: when the sampled velocity is tiny, coast along the
  // previous direction at reduced pace (a stall budget per line) so lines keep
  // flowing across slow rooms instead of stopping dead at the doorway.
  const stepVec = (p: THREE.Vector3, out: THREE.Vector3, sign: number): "ok" | "weak" | "dead" => {
    const v = sample(p.x, p.y, p.z);
    out.set(v.vx * sign, v.vy * sign, v.vz * sign);
    if (out.lengthSq() >= 1e-6) {
      out.setLength(step);
      return "ok";
    }
    if (lastDir.lengthSq() > 1e-8) {
      out.copy(lastDir).setLength(step * 0.4);
      return "weak";
    }
    return "dead";
  };

  /** Integrate from a seed, downstream (sign +1) or upstream (sign −1). */
  const trace = (seed: THREE.Vector3, sign: number): { raw: THREE.Vector3[]; peak: number } => {
    const p = seed.clone();
    const raw: THREE.Vector3[] = [p.clone()];
    lastDir.set(0, 0, 0);
    let stallBudget = 10;
    let peak = 0;
    for (let n = 0; n < maxSteps; n++) {
      if (!inBounds(p) || sample(p.x, p.y, p.z).solid) break;
      peak = Math.max(peak, sample(p.x, p.y, p.z).speed);
      const q1 = stepVec(p, s1, sign); // RK2 midpoint
      if (q1 === "dead") break;
      mid.copy(p).addScaledVector(s1, 0.5);
      const q2 = stepVec(mid, s2, sign);
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
    return { raw, peak };
  };

  for (const seed of seeds) {
    // Trace BOTH ways from the seed. Forward alone answers "where does this air
    // go?"; the upstream half answers "where did it come from?", and it is the
    // upstream half that reaches back through the doorway into the previous
    // room. Together one line is a whole path across the home rather than a
    // fragment starting wherever the seed happened to land.
    const fwd = trace(seed, 1);
    const back = trace(seed, -1);
    const raw = [...back.raw.slice(1).reverse(), ...fwd.raw];
    const peak = Math.max(fwd.peak, back.peak);
    // meaningful only: a real path that carries real air somewhere
    if (raw.length < MIN_POINTS || peak < MIN_SPEED) continue;

    const curve = new THREE.CatmullRomCurve3(raw, false, "centripetal");
    const divisions = Math.min(80, raw.length * 3);
    const smooth = curve.getPoints(divisions);
    // single flat colour — no speed gradient, so the view stays clean.
    // The integration never steps into a wall, but Catmull-Rom then interpolates
    // BETWEEN those valid points and can cut the corner on a tight bend, which
    // draws a segment clipping through a wall. Drop any segment whose midpoint
    // is solid: the line simply has a hairline gap there instead of crossing.
    for (let i = 0; i < smooth.length - 1; i++) {
      const a = smooth[i], b = smooth[i + 1];
      let clipped = false;
      for (let t = 1; t <= 3; t++) {
        const f = t / 4;
        mid.set(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, a.z + (b.z - a.z) * f);
        if (sample(mid.x, mid.y, mid.z).solid) { clipped = true; break; }
      }
      if (clipped) continue;
      points.push(a, b);
      colors.push(lineColor.clone(), lineColor.clone());
    }
  }

  return { points, colors };
}
