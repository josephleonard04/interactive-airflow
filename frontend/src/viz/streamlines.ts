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

/** Trilinear world-space velocity sampler over the sim's cell-centred field.
 *
 *  Two rules matter for walls, and both were wrong before:
 *
 *  1. Solidity is decided by the cell the point is ACTUALLY in, not by the
 *     interpolated solid fraction. An interior wall is one cell thick, so a
 *     point genuinely inside a wall blends to a fraction well under 1 — with a
 *     `> 0.5` test it was reported as open air, and every downstream wall check
 *     (including the anti-tunnelling span test) silently passed through it.
 *
 *  2. The velocity blend skips solid cells and renormalises over the rest.
 *     Including them mixed the air on BOTH sides of a one-cell wall into one
 *     vector, which is precisely a velocity that points through the wall — the
 *     tracer then followed it into the next room. Their zeros also dragged
 *     near-wall speeds down, making the air look slacker than it is.
 */
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
  opts: { maxSeeds?: number; color?: string; roofY?: number; rooms?: Rect[]; spacing?: number } = {},
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
  // Seed generously: the spacing rule below decides the final density, so extra
  // seeds cost a little tracing and buy coverage in the quiet rooms rather than
  // piling more lines into the fast ones.
  const seeds = seedPoints(built, sample, opts.maxSeeds ?? 40, opts.rooms ?? [], 0.02);

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

  // Evenly-spaced streamlines (after Jobard & Lefer 1997). Without this, seeds
  // cluster wherever the air is fastest — right in front of the fan — and each
  // line then orbits the same recirculation, drawing a scribble that reads as
  // "lots of airflow here" when it is really one eddy traced fourteen times.
  //
  // Two rules, both enforced on a coarse occupancy grid of cell size D_SEP:
  //   1. a line stops when it crowds a cell an ACCEPTED line already occupies;
  //   2. a line stops when it revisits its OWN cells, i.e. it is closing a loop.
  // Lines are grown in seed order, and seeds are ordered fastest-first, so the
  // structurally important lines claim their space before the rest.
  // Spacing is enforced in PLAN (x,z), deliberately ignoring height. Indoor
  // airflow is close to horizontal and the camera looks down at the house, so
  // two lines a metre apart vertically still land on top of each other on
  // screen. Keying the grid in 3D let them each claim their own cell and the
  // view stayed crowded even though the rule "worked".
  //
  // Measured on the example home at display resolution (dx 0.24), 40 seeds:
  //   before any spacing   2562 segments   up to 7 lines per 0.5 m cell
  //   D_SEP 0.55 (plan)     962 segments   up to 4, all four rooms covered
  const D_SEP = opts.spacing ?? Math.max(dx * 2, 0.55);
  const MAX_SHARED = 1; // lines an accepted cell may already hold before we stop
  const MAX_SELF = 2; // times a line may RE-ENTER one of its own cells
  const occupancy = new Map<string, number>();
  const key = (v: THREE.Vector3) => `${Math.floor(v.x / D_SEP)},${Math.floor(v.z / D_SEP)}`;

  for (const seed of seeds) {
    const p = seed.clone();
    if ((occupancy.get(key(p)) ?? 0) > MAX_SHARED) continue; // already covered
    const raw: THREE.Vector3[] = [p.clone()];
    const own = new Map<string, number>();
    let lastKey = key(p);
    own.set(lastKey, 1);
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
      // A step (0.75 cells) can be longer than a wall is thick (0.1 m), so the
      // endpoints can straddle a wall with neither one inside it — the line then
      // tunnels into the next room. Sample across the span, not just its ends.
      let tunnelled = false;
      for (let t = 1; t <= 3; t++) {
        mid.copy(p).addScaledVector(s2, t / 4);
        if (sample(mid.x, mid.y, mid.z).solid) { tunnelled = true; break; }
      }
      if (tunnelled) break;
      const k = key(next);
      if ((occupancy.get(k) ?? 0) > MAX_SHARED) break; // too close to another line
      // Count a cell only when the line ENTERS it. A step is a fraction of a
      // cell, so consecutive steps sit in the same cell — counting those would
      // trip the orbit detector after three steps and kill every line.
      // A revisit means the line left this cell and came back: an orbit.
      if (k !== lastKey) {
        const seen = (own.get(k) ?? 0) + 1;
        if (seen > MAX_SELF) break; // closing an orbit — stop before it scribbles
        own.set(k, seen);
        lastKey = k;
      }
      lastDir.copy(s2);
      raw.push(next);
      p.copy(next);
    }
    // meaningful only: a real path that carries real air along most of itself
    if (raw.length < MIN_POINTS || peak < MIN_SPEED) continue;
    if (speedN === 0 || speedSum / speedN < MIN_MEAN_SPEED) continue;

    for (const k of own.keys()) occupancy.set(k, (occupancy.get(k) ?? 0) + 1);

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
