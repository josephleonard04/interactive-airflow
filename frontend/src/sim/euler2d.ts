// A compact real-time incompressible Euler solver (2D, top-down x–z slice).
//
// Standard "Stable Fluids" scheme on a MAC grid: semi-Lagrangian advection +
// pressure projection (Gauss–Seidel), with solid obstacles and fixed-velocity
// inlet/outlet faces, plus a passively-advected scalar (contaminant / fresh-air
// tracer). This is the simple Euler solver the advisors recommended over LFM —
// indoor comfort airflow doesn't need LFM's vortical fidelity, and this runs
// real-time in the browser with no GPU. Buoyancy (vertical) is out-of-plane in a
// top-down slice and is deferred to the 3D version.
//
// Grid: nx × ny cells (x = width, y = depth of the room footprint), spacing dx.
// MAC layout: u on vertical faces (nx+1)×ny, v on horizontal faces nx×(ny+1),
// pressure/scalar at cell centres nx×ny.

export interface Euler2DOptions {
  nx: number;
  ny: number;
  dx: number;
  iterations?: number; // pressure iterations per step
  overRelax?: number; // SOR factor (1..2)
}

export class Euler2D {
  readonly nx: number;
  readonly ny: number;
  readonly dx: number;
  iterations: number;
  overRelax: number;

  u: Float32Array; // (nx+1)*ny
  v: Float32Array; // nx*(ny+1)
  private u0: Float32Array;
  private v0: Float32Array;
  p: Float32Array; // nx*ny
  s: Float32Array; // scalar, nx*ny
  private s0: Float32Array;

  solid: Uint8Array; // nx*ny, 1 = obstacle
  divTarget: Float32Array; // nx*ny, prescribed net divergence: +source (inlet) / -sink (outlet)
  uFixed: Uint8Array; // (nx+1)*ny, 1 = velocity prescribed (inlet/outlet)
  uVal: Float32Array; // (nx+1)*ny
  vFixed: Uint8Array; // nx*(ny+1)
  vVal: Float32Array; // nx*(ny+1)
  sFixed: Uint8Array; // nx*ny, 1 = scalar held at sVal (e.g. source / clean inflow)
  sVal: Float32Array; // nx*ny

  constructor(o: Euler2DOptions) {
    this.nx = o.nx;
    this.ny = o.ny;
    this.dx = o.dx;
    this.iterations = o.iterations ?? 40;
    this.overRelax = o.overRelax ?? 1.9;

    const c = o.nx * o.ny;
    this.u = new Float32Array((o.nx + 1) * o.ny);
    this.v = new Float32Array(o.nx * (o.ny + 1));
    this.u0 = new Float32Array(this.u.length);
    this.v0 = new Float32Array(this.v.length);
    this.p = new Float32Array(c);
    this.s = new Float32Array(c);
    this.s0 = new Float32Array(c);
    this.solid = new Uint8Array(c);
    this.divTarget = new Float32Array(c);
    this.uFixed = new Uint8Array(this.u.length);
    this.uVal = new Float32Array(this.u.length);
    this.vFixed = new Uint8Array(this.v.length);
    this.vVal = new Float32Array(this.v.length);
    this.sFixed = new Uint8Array(c);
    this.sVal = new Float32Array(c);
  }

  // ---- indexing ----
  cIdx(i: number, j: number): number {
    return i + this.nx * j;
  }
  uIdx(i: number, j: number): number {
    return i + (this.nx + 1) * j;
  } // i in [0..nx]
  vIdx(i: number, j: number): number {
    return i + this.nx * j;
  } // j in [0..ny]

  isSolid(i: number, j: number): boolean {
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return true; // domain walls
    return this.solid[this.cIdx(i, j)] === 1;
  }

  // ---- bilinear samplers in cell-width units (origin at grid corner) ----
  private sampleU(x: number, y: number): number {
    // u stored at (i, j+0.5): x measured in cells from left face
    const { nx, ny } = this;
    const gx = clamp(x, 0, nx);
    const gy = clamp(y - 0.5, 0, ny - 1);
    const i0 = Math.min(Math.floor(gx), nx - 1);
    const j0 = Math.min(Math.floor(gy), ny - 1);
    const tx = gx - i0;
    const ty = gy - j0;
    const i1 = Math.min(i0 + 1, nx);
    const j1 = Math.min(j0 + 1, ny - 1);
    const a = this.u[this.uIdx(i0, j0)];
    const b = this.u[this.uIdx(i1, j0)];
    const c = this.u[this.uIdx(i0, j1)];
    const d = this.u[this.uIdx(i1, j1)];
    return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
  }
  private sampleV(x: number, y: number): number {
    const { nx, ny } = this;
    const gx = clamp(x - 0.5, 0, nx - 1);
    const gy = clamp(y, 0, ny);
    const i0 = Math.min(Math.floor(gx), nx - 1);
    const j0 = Math.min(Math.floor(gy), ny - 1);
    const tx = gx - i0;
    const ty = gy - j0;
    const i1 = Math.min(i0 + 1, nx - 1);
    const j1 = Math.min(j0 + 1, ny);
    const a = this.v[this.vIdx(i0, j0)];
    const b = this.v[this.vIdx(i1, j0)];
    const c = this.v[this.vIdx(i0, j1)];
    const d = this.v[this.vIdx(i1, j1)];
    return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
  }
  private sampleS(field: Float32Array, x: number, y: number): number {
    const { nx, ny } = this;
    const gx = clamp(x - 0.5, 0, nx - 1);
    const gy = clamp(y - 0.5, 0, ny - 1);
    const i0 = Math.floor(gx);
    const j0 = Math.floor(gy);
    const tx = gx - i0;
    const ty = gy - j0;
    const i1 = Math.min(i0 + 1, nx - 1);
    const j1 = Math.min(j0 + 1, ny - 1);
    const a = field[this.cIdx(i0, j0)];
    const b = field[this.cIdx(i1, j0)];
    const c = field[this.cIdx(i0, j1)];
    const d = field[this.cIdx(i1, j1)];
    return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
  }

  // ---- one step ----
  step(dt: number): void {
    this.applyBC();
    this.advectVelocity(dt);
    this.applyBC();
    this.project();
    this.advectScalar(dt);
  }

  private applyBC(): void {
    const { nx, ny } = this;
    // prescribed inlet/outlet faces
    for (let k = 0; k < this.u.length; k++) if (this.uFixed[k]) this.u[k] = this.uVal[k];
    for (let k = 0; k < this.v.length; k++) if (this.vFixed[k]) this.v[k] = this.vVal[k];
    // no-through at solid faces: a face between a fluid and a solid cell is zero
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i <= nx; i++) {
        const left = this.isSolid(i - 1, j);
        const right = this.isSolid(i, j);
        if ((left || right) && !this.uFixed[this.uIdx(i, j)]) this.u[this.uIdx(i, j)] = 0;
      }
    }
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i < nx; i++) {
        const down = this.isSolid(i, j - 1);
        const up = this.isSolid(i, j);
        if ((down || up) && !this.vFixed[this.vIdx(i, j)]) this.v[this.vIdx(i, j)] = 0;
      }
    }
  }

  private advectVelocity(dt: number): void {
    const { nx, ny, dx } = this;
    const sdt = dt / dx; // backtrace distance in cell units
    this.u0.set(this.u);
    this.v0.set(this.v);
    // u faces at (i, j+0.5)
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i <= nx; i++) {
        const id = this.uIdx(i, j);
        if (this.uFixed[id]) continue;
        const x = i;
        const y = j + 0.5;
        const uu = this.u0[id];
        const vv = this.sampleVFrom(this.v0, x, y);
        this.u[id] = this.sampleUFrom(this.u0, x - sdt * uu, y - sdt * vv);
      }
    }
    // v faces at (i+0.5, j)
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i < nx; i++) {
        const id = this.vIdx(i, j);
        if (this.vFixed[id]) continue;
        const x = i + 0.5;
        const y = j;
        const uu = this.sampleUFrom(this.u0, x, y);
        const vv = this.v0[id];
        this.v[id] = this.sampleVFrom(this.v0, x - sdt * uu, y - sdt * vv);
      }
    }
  }

  // samplers bound to an explicit source field (for advection from the snapshot)
  private sampleUFrom(field: Float32Array, x: number, y: number): number {
    const save = this.u;
    this.u = field;
    const r = this.sampleU(x, y);
    this.u = save;
    return r;
  }
  private sampleVFrom(field: Float32Array, x: number, y: number): number {
    const save = this.v;
    this.v = field;
    const r = this.sampleV(x, y);
    this.v = save;
    return r;
  }

  private project(): void {
    const { nx, ny } = this;
    this.p.fill(0);
    for (let it = 0; it < this.iterations; it++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          if (this.solid[this.cIdx(i, j)]) continue;
          // count open (fluid) faces
          const sL = this.isSolid(i - 1, j) ? 0 : 1;
          const sR = this.isSolid(i + 1, j) ? 0 : 1;
          const sD = this.isSolid(i, j - 1) ? 0 : 1;
          const sU = this.isSolid(i, j + 1) ? 0 : 1;
          const denom = sL + sR + sD + sU;
          if (denom === 0) continue;
          const div =
            this.u[this.uIdx(i + 1, j)] - this.u[this.uIdx(i, j)] +
            this.v[this.vIdx(i, j + 1)] - this.v[this.vIdx(i, j)] -
            this.divTarget[this.cIdx(i, j)];
          let pNew =
            (sL * this.pAt(i - 1, j) + sR * this.pAt(i + 1, j) + sD * this.pAt(i, j - 1) + sU * this.pAt(i, j + 1) - div) /
            denom;
          pNew = this.pAt(i, j) + this.overRelax * (pNew - this.pAt(i, j));
          this.p[this.cIdx(i, j)] = pNew;
        }
      }
    }
    // subtract pressure gradient from non-fixed, non-solid faces
    for (let j = 0; j < ny; j++) {
      for (let i = 1; i < nx; i++) {
        const id = this.uIdx(i, j);
        if (this.uFixed[id] || this.isSolid(i - 1, j) || this.isSolid(i, j)) continue;
        this.u[id] -= this.pAt(i, j) - this.pAt(i - 1, j);
      }
    }
    for (let j = 1; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const id = this.vIdx(i, j);
        if (this.vFixed[id] || this.isSolid(i, j - 1) || this.isSolid(i, j)) continue;
        this.v[id] -= this.pAt(i, j) - this.pAt(i, j - 1);
      }
    }
  }
  private pAt(i: number, j: number): number {
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return 0;
    return this.p[this.cIdx(i, j)];
  }

  private advectScalar(dt: number): void {
    const { nx, ny, dx } = this;
    const sdt = dt / dx;
    this.s0.set(this.s);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const id = this.cIdx(i, j);
        if (this.solid[id]) {
          this.s[id] = 0;
          continue;
        }
        if (this.sFixed[id]) {
          this.s[id] = this.sVal[id];
          continue;
        }
        const x = i + 0.5;
        const y = j + 0.5;
        const uu = this.sampleU(x, y);
        const vv = this.sampleV(x, y);
        this.s[id] = this.sampleS(this.s0, x - sdt * uu, y - sdt * vv);
      }
    }
  }

  /** Max |divergence| over fluid cells — diagnostic for the projection. */
  maxDivergence(): number {
    let m = 0;
    for (let j = 0; j < this.ny; j++) {
      for (let i = 0; i < this.nx; i++) {
        if (this.solid[this.cIdx(i, j)]) continue;
        const div =
          this.u[this.uIdx(i + 1, j)] - this.u[this.uIdx(i, j)] +
          this.v[this.vIdx(i, j + 1)] - this.v[this.vIdx(i, j)] -
          this.divTarget[this.cIdx(i, j)];
        m = Math.max(m, Math.abs(div));
      }
    }
    return m;
  }

  /** Cell-centre speed field (m/s) for visualization. */
  speedField(): Float32Array {
    const out = new Float32Array(this.nx * this.ny);
    for (let j = 0; j < this.ny; j++) {
      for (let i = 0; i < this.nx; i++) {
        const uc = 0.5 * (this.u[this.uIdx(i, j)] + this.u[this.uIdx(i + 1, j)]);
        const vc = 0.5 * (this.v[this.vIdx(i, j)] + this.v[this.vIdx(i, j + 1)]);
        out[this.cIdx(i, j)] = Math.hypot(uc, vc);
      }
    }
    return out;
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
