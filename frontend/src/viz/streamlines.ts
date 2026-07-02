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
 * Seed points across the WHOLE house: the vents/AC outlets (where air is born),
 * a sparse grid of moving cells, AND the fastest cells of EVERY room — so each
 * room shows its air motion, however gentle, not just the room with the AC.
 */
function seedPoints(
  built: Sim3D,
  sample: (x: number, y: number, z: number) => Vel,
  maxSeeds: number,
  rooms: Rect[] = [],
): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const s of built.seeds) out.push(new THREE.Vector3(s[0], s[1], s[2]));

  const { nx, ny, nz, cellCenter } = built;
  const stride = Math.max(1, Math.round(Math.cbrt((nx * ny * nz) / (maxSeeds * 2))));
  for (let k = 1; k < nz - 1; k += stride)
    for (let j = 1; j < ny - 1; j += stride)
      for (let i = 1; i < nx - 1; i += stride) {
        const [x, y, z] = cellCenter(i, j, k);
        const v = sample(x, y, z);
        if (!v.solid && v.speed > 0.03) out.push(new THREE.Vector3(x, y, z));
      }

  // Guarantee per-room coverage: the ~6 fastest air cells of each room become
  // seeds even when the whole room is slow (air still moves everywhere).
  for (const r of rooms) {
    const cands: Array<{ p: THREE.Vector3; s: number }> = [];
    for (let k = 1; k < nz - 1; k += 1)
      for (let j = 1; j < ny - 1; j += 2)
        for (let i = 1; i < nx - 1; i += 1) {
          const [x, y, z] = cellCenter(i, j, k);
          if (x < r.x || x > r.x + r.w || z < r.z || z > r.z + r.d) continue;
          const v = sample(x, y, z);
          if (!v.solid && v.speed > 0.004) cands.push({ p: new THREE.Vector3(x, y, z), s: v.speed });
        }
    cands.sort((a, b) => b.s - a.s);
    for (const c of cands.slice(0, 6)) out.push(c.p);
  }
  // Cap, keeping an even spread.
  if (out.length > maxSeeds) {
    const step = out.length / maxSeeds;
    const kept: THREE.Vector3[] = [];
    for (let i = 0; i < maxSeeds; i++) kept.push(out[Math.floor(i * step)]);
    return kept;
  }
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
  const inBounds = (p: THREE.Vector3) =>
    p.x > x0 && p.x < x1 && p.y > y0 && p.y < y1 && p.z > z0 && p.z < z1;

  const base = new THREE.Color(opts.color ?? "#38bdf8");
  const hot = new THREE.Color("#f3fbff");
  const SPEED_REF = 0.8;
  const step = dx * 0.75;
  const maxSteps = 170;
  const seeds = seedPoints(built, sample, opts.maxSeeds ?? 46, opts.rooms ?? []);

  const s1 = new THREE.Vector3();
  const s2 = new THREE.Vector3();
  const mid = new THREE.Vector3();
  const lastDir = new THREE.Vector3();
  // Weak air still moves: when the sampled velocity is tiny, coast along the
  // previous direction at reduced pace (a stall budget per line) so lines keep
  // flowing across slow rooms instead of stopping dead at the doorway.
  const stepVec = (p: THREE.Vector3, out: THREE.Vector3): "ok" | "weak" | "dead" => {
    const v = sample(p.x, p.y, p.z);
    out.set(v.vx, v.vy, v.vz);
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

  for (const seed of seeds) {
    const p = seed.clone();
    const raw: THREE.Vector3[] = [p.clone()];
    lastDir.set(0, 0, 0);
    let stallBudget = 14;
    for (let n = 0; n < maxSteps; n++) {
      if (!inBounds(p) || sample(p.x, p.y, p.z).solid) break;
      const q1 = stepVec(p, s1); // RK2 midpoint
      if (q1 === "dead") break;
      mid.copy(p).addScaledVector(s1, 0.5);
      const q2 = stepVec(mid, s2);
      if (q2 === "dead") break;
      if (q1 === "weak" || q2 === "weak") {
        if (--stallBudget <= 0) break;
      }
      const next = p.clone().add(s2);
      if (sample(next.x, next.y, next.z).solid) break;
      lastDir.copy(s2);
      raw.push(next);
      p.copy(next);
    }
    if (raw.length < 3) continue;

    const curve = new THREE.CatmullRomCurve3(raw, false, "centripetal");
    const divisions = Math.min(80, raw.length * 3);
    const smooth = curve.getPoints(divisions);
    const c0 = new THREE.Color();
    const c1 = new THREE.Color();
    const colorAt = (q: THREE.Vector3, out: THREE.Color) => {
      const norm = Math.min(1, sample(q.x, q.y, q.z).speed / SPEED_REF);
      return out.copy(base).lerp(hot, norm * 0.78);
    };
    for (let i = 0; i < smooth.length - 1; i++) {
      points.push(smooth[i], smooth[i + 1]);
      colors.push(colorAt(smooth[i], c0).clone(), colorAt(smooth[i + 1], c1).clone());
    }
  }

  return { points, colors };
}
