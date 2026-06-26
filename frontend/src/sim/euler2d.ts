// A compact real-time incompressible Euler solver (2D, top-down x–z slice).
//
// Standard "Stable Fluids" scheme on a MAC grid: semi-Lagrangian advection +
// pressure projection (Gauss–Seidel/SOR), with vorticity confinement to keep the
// recirculation that advection would otherwise smear away. Drivers:
//   - solids        : walls + furniture (no-slip / no-through)
//   - directed jets  : AC / fan / supply blow momentum in a direction (uFixed/vFixed)
//   - open cells     : open exterior windows/doors are free boundaries (p = 0) where
//                      air leaves or enters as the flow demands — NOT forced sinks
//   - scalars        : contaminant (s) and temperature (temp) are advected + diffused
//
// This is the simple Euler solver the advisors recommended over LFM; indoor
// comfort airflow doesn't need LFM's vortical fidelity and this runs real-time in
// the browser with no GPU. Buoyancy (vertical) is out-of-plane in a top-down slice
// and is deferred to the 3D version.

export interface Euler2DOptions {
  nx: number;
  ny: number;
  dx: number;
  iterations?: number; // pressure iterations per step
  overRelax?: number; // SOR factor (1..2)
  vorticity?: number; // vorticity-confinement strength (0 = off)
  diffusion?: number; // scalar diffusion per step (0..0.24)
}

export class Euler2D {
  readonly nx: number;
  readonly ny: number;
  readonly dx: number;
  iterations: number;
  overRelax: number;
  vorticity: number;
  diffusion: number;

  u: Float32Array; // (nx+1)*ny
  v: Float32Array; // nx*(ny+1)
  private u0: Float32Array;
  private v0: Float32Array;
  p: Float32Array; // nx*ny
  s: Float32Array; // contaminant, nx*ny
  temp: Float32Array; // temperature deviation from ambient, nx*ny
  private scratch: Float32Array;

  solid: Uint8Array; // nx*ny, 1 = obstacle
  open: Uint8Array; // nx*ny, 1 = free boundary cell (p = 0, air may leave/enter)
  uFixed: Uint8Array; // (nx+1)*ny, 1 = jet face
  uVal: Float32Array;
  vFixed: Uint8Array; // nx*(ny+1)
  vVal: Float32Array;
  sFixed: Uint8Array; // nx*ny, contaminant source held at sVal
  sVal: Float32Array;
  tempFixed: Uint8Array; // nx*ny, temperature source held at tempVal
  tempVal: Float32Array;

  constructor(o: Euler2DOptions) {
    this.nx = o.nx;
    this.ny = o.ny;
    this.dx = o.dx;
    this.iterations = o.iterations ?? 50;
    this.overRelax = o.overRelax ?? 1.8;
    this.vorticity = o.vorticity ?? 2.0;
    this.diffusion = o.diffusion ?? 0.06;

    const c = o.nx * o.ny;
    this.u = new Float32Array((o.nx + 1) * o.ny);
    this.v = new Float32Array(o.nx * (o.ny + 1));
    this.u0 = new Float32Array(this.u.length);
    this.v0 = new Float32Array(this.v.length);
    this.p = new Float32Array(c);
    this.s = new Float32Array(c);
    this.temp = new Float32Array(c);
    this.scratch = new Float32Array(c);
    this.solid = new Uint8Array(c);
    this.open = new Uint8Array(c);
    this.uFixed = new Uint8Array(this.u.length);
    this.uVal = new Float32Array(this.u.length);
    this.vFixed = new Uint8Array(this.v.length);
    this.vVal = new Float32Array(this.v.length);
    this.sFixed = new Uint8Array(c);
    this.sVal = new Float32Array(c);
    this.tempFixed = new Uint8Array(c);
    this.tempVal = new Float32Array(c);
  }

  // ---- indexing ----
  cIdx(i: number, j: number): number {
    return i + this.nx * j;
  }
  uIdx(i: number, j: number): number {
    return i + (this.nx + 1) * j;
  }
  vIdx(i: number, j: number): number {
    return i + this.nx * j;
  }

  isSolid(i: number, j: number): boolean {
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return true; // domain walls
    return this.solid[this.cIdx(i, j)] === 1;
  }
  // ---- bilinear samplers (cell-width units, origin at grid corner) ----
  private sampleField(field: Float32Array, x: number, y: number, ox: number, oy: number, w: number, h: number): number {
    const gx = clamp(x - ox, 0, w - 1.001);
    const gy = clamp(y - oy, 0, h - 1.001);
    const i0 = Math.floor(gx);
    const j0 = Math.floor(gy);
    const tx = gx - i0;
    const ty = gy - j0;
    const a = field[i0 + w * j0];
    const b = field[i0 + 1 + w * j0];
    const c = field[i0 + w * (j0 + 1)];
    const d = field[i0 + 1 + w * (j0 + 1)];
    return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
  }
  private sampleU(f: Float32Array, x: number, y: number): number {
    return this.sampleField(f, x, y, 0, 0.5, this.nx + 1, this.ny);
  }
  private sampleV(f: Float32Array, x: number, y: number): number {
    return this.sampleField(f, x, y, 0.5, 0, this.nx, this.ny + 1);
  }
  private sampleC(f: Float32Array, x: number, y: number): number {
    return this.sampleField(f, x, y, 0.5, 0.5, this.nx, this.ny);
  }

  // ---- one step ----
  step(dt: number): void {
    this.applyBC();
    this.advectVelocity(dt);
    if (this.vorticity > 0) this.confineVorticity(dt);
    this.applyBC();
    this.project();
    this.advectScalar(this.s, this.sFixed, this.sVal, dt, true);
    this.advectScalar(this.temp, this.tempFixed, this.tempVal, dt, false);
    if (this.diffusion > 0) {
      this.diffuse(this.s, this.sFixed, this.sVal);
      this.diffuse(this.temp, this.tempFixed, this.tempVal);
    }
  }

  private applyBC(): void {
    const { nx, ny } = this;
    for (let k = 0; k < this.u.length; k++) if (this.uFixed[k]) this.u[k] = this.uVal[k];
    for (let k = 0; k < this.v.length; k++) if (this.vFixed[k]) this.v[k] = this.vVal[k];
    // no-through across solid faces (open cells are not solid → flow passes)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i <= nx; i++) {
        if (this.uFixed[this.uIdx(i, j)]) continue;
        if (this.isSolid(i - 1, j) || this.isSolid(i, j)) this.u[this.uIdx(i, j)] = 0;
      }
    for (let j = 0; j <= ny; j++)
      for (let i = 0; i < nx; i++) {
        if (this.vFixed[this.vIdx(i, j)]) continue;
        if (this.isSolid(i, j - 1) || this.isSolid(i, j)) this.v[this.vIdx(i, j)] = 0;
      }
  }

  private advectVelocity(dt: number): void {
    const { nx, ny, dx } = this;
    const sdt = dt / dx;
    this.u0.set(this.u);
    this.v0.set(this.v);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i <= nx; i++) {
        const id = this.uIdx(i, j);
        if (this.uFixed[id]) continue;
        const uu = this.u0[id];
        const vv = this.sampleV(this.v0, i, j + 0.5);
        this.u[id] = this.sampleU(this.u0, i - sdt * uu, j + 0.5 - sdt * vv);
      }
    for (let j = 0; j <= ny; j++)
      for (let i = 0; i < nx; i++) {
        const id = this.vIdx(i, j);
        if (this.vFixed[id]) continue;
        const uu = this.sampleU(this.u0, i + 0.5, j);
        const vv = this.v0[id];
        this.v[id] = this.sampleV(this.v0, i + 0.5 - sdt * uu, j - sdt * vv);
      }
  }

  // Fedkiw-style vorticity confinement: push velocity back toward vortex cores so
  // semi-Lagrangian damping doesn't kill recirculation.
  private confineVorticity(dt: number): void {
    const { nx, ny } = this;
    const w = this.scratch; // reuse as vorticity buffer
    const uc = (i: number, j: number) => 0.5 * (this.u[this.uIdx(i, j)] + this.u[this.uIdx(i + 1, j)]);
    const vc = (i: number, j: number) => 0.5 * (this.v[this.vIdx(i, j)] + this.v[this.vIdx(i, j + 1)]);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        if (this.solid[this.cIdx(i, j)]) {
          w[this.cIdx(i, j)] = 0;
          continue;
        }
        const dvdx = (cell(i + 1) ? vc(i + 1, j) : vc(i, j)) - (cell(i - 1) ? vc(i - 1, j) : vc(i, j));
        const dudy = (cellY(j + 1) ? uc(i, j + 1) : uc(i, j)) - (cellY(j - 1) ? uc(i, j - 1) : uc(i, j));
        w[this.cIdx(i, j)] = 0.5 * (dvdx - dudy);
      }
    function cell(i: number) {
      return i >= 0 && i < nx;
    }
    function cellY(j: number) {
      return j >= 0 && j < ny;
    }
    const eps = this.vorticity * dt;
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        if (this.solid[this.cIdx(i, j)]) continue;
        const gx = Math.abs(w[this.cIdx(i + 1, j)]) - Math.abs(w[this.cIdx(i - 1, j)]);
        const gy = Math.abs(w[this.cIdx(i, j + 1)]) - Math.abs(w[this.cIdx(i, j - 1)]);
        const len = Math.hypot(gx, gy) + 1e-6;
        const nxc = gx / len;
        const nyc = gy / len;
        const wij = w[this.cIdx(i, j)];
        // f = eps * (N x w) ; add to the two faces around this cell
        const fx = eps * nyc * wij;
        const fy = eps * -nxc * wij;
        if (!this.uFixed[this.uIdx(i, j)] && !this.isSolid(i - 1, j)) this.u[this.uIdx(i, j)] += fx;
        if (!this.uFixed[this.uIdx(i + 1, j)] && !this.isSolid(i + 1, j)) this.u[this.uIdx(i + 1, j)] += fx;
        if (!this.vFixed[this.vIdx(i, j)] && !this.isSolid(i, j - 1)) this.v[this.vIdx(i, j)] += fy;
        if (!this.vFixed[this.vIdx(i, j + 1)] && !this.isSolid(i, j + 1)) this.v[this.vIdx(i, j + 1)] += fy;
      }
  }

  private project(): void {
    const { nx, ny } = this;
    this.p.fill(0); // open cells stay 0 (Dirichlet free boundary)
    for (let it = 0; it < this.iterations; it++) {
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const c = this.cIdx(i, j);
          if (this.solid[c] || this.open[c]) continue;
          const sL = this.isSolid(i - 1, j) ? 0 : 1;
          const sR = this.isSolid(i + 1, j) ? 0 : 1;
          const sD = this.isSolid(i, j - 1) ? 0 : 1;
          const sU = this.isSolid(i, j + 1) ? 0 : 1;
          const denom = sL + sR + sD + sU;
          if (denom === 0) continue;
          const div =
            this.u[this.uIdx(i + 1, j)] - this.u[this.uIdx(i, j)] +
            this.v[this.vIdx(i, j + 1)] - this.v[this.vIdx(i, j)];
          const pNew =
            (sL * this.pAt(i - 1, j) + sR * this.pAt(i + 1, j) + sD * this.pAt(i, j - 1) + sU * this.pAt(i, j + 1) - div) /
            denom;
          this.p[c] = this.p[c] + this.overRelax * (pNew - this.p[c]);
        }
    }
    for (let j = 0; j < ny; j++)
      for (let i = 1; i < nx; i++) {
        const id = this.uIdx(i, j);
        if (this.uFixed[id] || this.isSolid(i - 1, j) || this.isSolid(i, j)) continue;
        this.u[id] -= this.pAt(i, j) - this.pAt(i - 1, j);
      }
    for (let j = 1; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const id = this.vIdx(i, j);
        if (this.vFixed[id] || this.isSolid(i, j - 1) || this.isSolid(i, j)) continue;
        this.v[id] -= this.pAt(i, j) - this.pAt(i, j - 1);
      }
  }
  private pAt(i: number, j: number): number {
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return 0;
    return this.p[this.cIdx(i, j)];
  }

  private advectScalar(field: Float32Array, fixed: Uint8Array, val: Float32Array, dt: number, clearOpen: boolean): void {
    const { nx, ny, dx } = this;
    const sdt = dt / dx;
    this.scratch.set(field);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = this.cIdx(i, j);
        if (this.solid[c]) {
          field[c] = 0;
          continue;
        }
        if (fixed[c]) {
          field[c] = val[c];
          continue;
        }
        if (clearOpen && this.open[c]) {
          field[c] = 0; // contaminant leaves at open boundaries
          continue;
        }
        const x = i + 0.5;
        const y = j + 0.5;
        const uu = this.sampleU(this.u, x, y);
        const vv = this.sampleV(this.v, x, y);
        field[c] = this.sampleC(this.scratch, x - sdt * uu, y - sdt * vv);
      }
  }

  private diffuse(field: Float32Array, fixed: Uint8Array, val: Float32Array): void {
    const { nx, ny } = this;
    const k = this.diffusion;
    this.scratch.set(field);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = this.cIdx(i, j);
        if (this.solid[c] || fixed[c]) continue;
        let sum = 0;
        let n = 0;
        if (!this.isSolid(i - 1, j)) { sum += this.scratch[this.cIdx(i - 1, j)]; n++; }
        if (!this.isSolid(i + 1, j)) { sum += this.scratch[this.cIdx(i + 1, j)]; n++; }
        if (!this.isSolid(i, j - 1)) { sum += this.scratch[this.cIdx(i, j - 1)]; n++; }
        if (!this.isSolid(i, j + 1)) { sum += this.scratch[this.cIdx(i, j + 1)]; n++; }
        if (n > 0) field[c] = this.scratch[c] + k * (sum / n - this.scratch[c]);
      }
    for (let c = 0; c < nx * ny; c++) if (fixed[c]) field[c] = val[c];
  }

  /** Max |divergence| over interior fluid cells — projection diagnostic. */
  maxDivergence(): number {
    let m = 0;
    for (let j = 0; j < this.ny; j++)
      for (let i = 0; i < this.nx; i++) {
        const c = this.cIdx(i, j);
        if (this.solid[c] || this.open[c]) continue;
        const div =
          this.u[this.uIdx(i + 1, j)] - this.u[this.uIdx(i, j)] +
          this.v[this.vIdx(i, j + 1)] - this.v[this.vIdx(i, j)];
        m = Math.max(m, Math.abs(div));
      }
    return m;
  }

  /** Cell-centre speed magnitude (m/s). */
  speedField(): Float32Array {
    const out = new Float32Array(this.nx * this.ny);
    for (let j = 0; j < this.ny; j++)
      for (let i = 0; i < this.nx; i++) {
        const uc = 0.5 * (this.u[this.uIdx(i, j)] + this.u[this.uIdx(i + 1, j)]);
        const vc = 0.5 * (this.v[this.vIdx(i, j)] + this.v[this.vIdx(i, j + 1)]);
        out[this.cIdx(i, j)] = Math.hypot(uc, vc);
      }
    return out;
  }

  /** Cell-centre velocity (u, v) for arrow rendering. */
  velocityAt(i: number, j: number): [number, number] {
    return [
      0.5 * (this.u[this.uIdx(i, j)] + this.u[this.uIdx(i + 1, j)]),
      0.5 * (this.v[this.vIdx(i, j)] + this.v[this.vIdx(i, j + 1)]),
    ];
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
