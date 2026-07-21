// A compact real-time incompressible Euler solver (3D, MAC grid).
//
// The 3D generalisation of euler2d: semi-Lagrangian advection + pressure
// projection (Gauss–Seidel/SOR) on a staggered grid, with solids, directed jets,
// open (free) boundary cells, advected contaminant + temperature scalars, and —
// the reason to go 3D — **thermal buoyancy** (warm air rises along +y), which a
// top-down 2D slice cannot represent.
//
// Axes: x = width, y = up, z = depth. u on x-faces (nx+1,ny,nz), v on y-faces
// (nx,ny+1,nz), w on z-faces (nx,ny,nz+1); pressure/scalars at cell centres.

export interface Euler3DOptions {
  nx: number;
  ny: number;
  nz: number;
  dx: number;
  iterations?: number;
  overRelax?: number;
  buoyancy?: number; // upward force per unit temperature
  diffusion?: number;
}

export class Euler3D {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly dx: number;
  iterations: number;
  overRelax: number;
  buoyancy: number;
  diffusion: number;

  u: Float32Array; // (nx+1)*ny*nz
  v: Float32Array; // nx*(ny+1)*nz
  w: Float32Array; // nx*ny*(nz+1)
  private u0: Float32Array;
  private v0: Float32Array;
  private w0: Float32Array;
  p: Float32Array;
  s: Float32Array;
  temp: Float32Array;
  private scratch: Float32Array;

  solid: Uint8Array;
  open: Uint8Array;
  uFixed: Uint8Array; uVal: Float32Array;
  vFixed: Uint8Array; vVal: Float32Array;
  wFixed: Uint8Array; wVal: Float32Array;
  sFixed: Uint8Array; sVal: Float32Array;
  tempFixed: Uint8Array; tempVal: Float32Array;

  // Body forces on the faces (m/s per second). Unlike the *Fixed arrays these do
  // not PRESCRIBE a velocity — they accelerate whatever air is there and are
  // then subject to the pressure projection like everything else. That is the
  // difference between a fan and a vent: a vent supplies air at a set speed, a
  // fan can only push the air already in the room, and it slows down when the
  // flow it is pushing into resists.
  uForce: Float32Array;
  vForce: Float32Array;
  wForce: Float32Array;

  constructor(o: Euler3DOptions) {
    this.nx = o.nx; this.ny = o.ny; this.nz = o.nz; this.dx = o.dx;
    this.iterations = o.iterations ?? 30;
    this.overRelax = o.overRelax ?? 1.8;
    this.buoyancy = o.buoyancy ?? 0.8;
    this.diffusion = o.diffusion ?? 0.05;

    const c = o.nx * o.ny * o.nz;
    this.u = new Float32Array((o.nx + 1) * o.ny * o.nz);
    this.v = new Float32Array(o.nx * (o.ny + 1) * o.nz);
    this.w = new Float32Array(o.nx * o.ny * (o.nz + 1));
    this.u0 = new Float32Array(this.u.length);
    this.v0 = new Float32Array(this.v.length);
    this.w0 = new Float32Array(this.w.length);
    this.p = new Float32Array(c);
    this.s = new Float32Array(c);
    this.temp = new Float32Array(c);
    this.scratch = new Float32Array(c);
    this.solid = new Uint8Array(c);
    this.open = new Uint8Array(c);
    this.uFixed = new Uint8Array(this.u.length); this.uVal = new Float32Array(this.u.length);
    this.vFixed = new Uint8Array(this.v.length); this.vVal = new Float32Array(this.v.length);
    this.wFixed = new Uint8Array(this.w.length); this.wVal = new Float32Array(this.w.length);
    this.sFixed = new Uint8Array(c); this.sVal = new Float32Array(c);
    this.tempFixed = new Uint8Array(c); this.tempVal = new Float32Array(c);
    this.uForce = new Float32Array(this.u.length);
    this.vForce = new Float32Array(this.v.length);
    this.wForce = new Float32Array(this.w.length);
  }

  cIdx(i: number, j: number, k: number): number { return i + this.nx * (j + this.ny * k); }
  uIdx(i: number, j: number, k: number): number { return i + (this.nx + 1) * (j + this.ny * k); }
  vIdx(i: number, j: number, k: number): number { return i + this.nx * (j + (this.ny + 1) * k); }
  wIdx(i: number, j: number, k: number): number { return i + this.nx * (j + this.ny * k); }

  isSolid(i: number, j: number, k: number): boolean {
    if (i < 0 || j < 0 || k < 0 || i >= this.nx || j >= this.ny || k >= this.nz) return true;
    return this.solid[this.cIdx(i, j, k)] === 1;
  }

  // trilinear sample of a field with grid dims (w,h,d) and cell offsets (ox,oy,oz)
  private sample(f: Float32Array, x: number, y: number, z: number, ox: number, oy: number, oz: number, w: number, h: number, d: number): number {
    const gx = clamp(x - ox, 0, w - 1.001);
    const gy = clamp(y - oy, 0, h - 1.001);
    const gz = clamp(z - oz, 0, d - 1.001);
    const i0 = Math.floor(gx), j0 = Math.floor(gy), k0 = Math.floor(gz);
    const tx = gx - i0, ty = gy - j0, tz = gz - k0;
    const idx = (i: number, j: number, k: number) => i + w * (j + h * k);
    const c000 = f[idx(i0, j0, k0)], c100 = f[idx(i0 + 1, j0, k0)];
    const c010 = f[idx(i0, j0 + 1, k0)], c110 = f[idx(i0 + 1, j0 + 1, k0)];
    const c001 = f[idx(i0, j0, k0 + 1)], c101 = f[idx(i0 + 1, j0, k0 + 1)];
    const c011 = f[idx(i0, j0 + 1, k0 + 1)], c111 = f[idx(i0 + 1, j0 + 1, k0 + 1)];
    const c00 = lerp(c000, c100, tx), c10 = lerp(c010, c110, tx);
    const c01 = lerp(c001, c101, tx), c11 = lerp(c011, c111, tx);
    return lerp(lerp(c00, c10, ty), lerp(c01, c11, ty), tz);
  }
  private sU(f: Float32Array, x: number, y: number, z: number) { return this.sample(f, x, y, z, 0, 0.5, 0.5, this.nx + 1, this.ny, this.nz); }
  private sV(f: Float32Array, x: number, y: number, z: number) { return this.sample(f, x, y, z, 0.5, 0, 0.5, this.nx, this.ny + 1, this.nz); }
  private sW(f: Float32Array, x: number, y: number, z: number) { return this.sample(f, x, y, z, 0.5, 0.5, 0, this.nx, this.ny, this.nz + 1); }
  private sC(f: Float32Array, x: number, y: number, z: number) { return this.sample(f, x, y, z, 0.5, 0.5, 0.5, this.nx, this.ny, this.nz); }

  step(dt: number): void {
    this.applyBC();
    this.advectVelocity(dt);
    this.addBuoyancy(dt);
    this.addForces(dt);
    this.applyBC();
    this.project();
    this.advectScalar(this.s, this.sFixed, this.sVal, dt, true);
    this.advectScalar(this.temp, this.tempFixed, this.tempVal, dt, false);
    if (this.diffusion > 0) {
      this.diffuse(this.s, this.sFixed);
      this.diffuse(this.temp, this.tempFixed);
    }
  }

  private applyBC(): void {
    const { nx, ny, nz } = this;
    for (let kk = 0; kk < this.u.length; kk++) if (this.uFixed[kk]) this.u[kk] = this.uVal[kk];
    for (let kk = 0; kk < this.v.length; kk++) if (this.vFixed[kk]) this.v[kk] = this.vVal[kk];
    for (let kk = 0; kk < this.w.length; kk++) if (this.wFixed[kk]) this.w[kk] = this.wVal[kk];
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i <= nx; i++) {
      const id = this.uIdx(i, j, k);
      if (!this.uFixed[id] && (this.isSolid(i - 1, j, k) || this.isSolid(i, j, k))) this.u[id] = 0;
    }
    for (let k = 0; k < nz; k++) for (let j = 0; j <= ny; j++) for (let i = 0; i < nx; i++) {
      const id = this.vIdx(i, j, k);
      if (!this.vFixed[id] && (this.isSolid(i, j - 1, k) || this.isSolid(i, j, k))) this.v[id] = 0;
    }
    for (let k = 0; k <= nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const id = this.wIdx(i, j, k);
      if (!this.wFixed[id] && (this.isSolid(i, j, k - 1) || this.isSolid(i, j, k))) this.w[id] = 0;
    }
  }

  /** Apply body forces (fans). Accelerates the air that is present; the
   *  projection immediately afterwards conserves mass, so no air is created —
   *  a fan pushes, it does not supply. Faces against a solid stay at rest, and
   *  the speed is capped so a fan cannot spin the air up without limit. */
  private addForces(dt: number): void {
    const { nx, ny, nz } = this;
    const CAP = 3.0; // m/s — a domestic fan's jet, not a wind tunnel
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i <= nx; i++) {
      const id = this.uIdx(i, j, k);
      const f = this.uForce[id];
      if (f === 0 || this.uFixed[id]) continue;
      if (this.isSolid(i - 1, j, k) || this.isSolid(i, j, k)) continue;
      this.u[id] = clamp(this.u[id] + f * dt, -CAP, CAP);
    }
    for (let k = 0; k < nz; k++) for (let j = 0; j <= ny; j++) for (let i = 0; i < nx; i++) {
      const id = this.vIdx(i, j, k);
      const f = this.vForce[id];
      if (f === 0 || this.vFixed[id]) continue;
      if (this.isSolid(i, j - 1, k) || this.isSolid(i, j, k)) continue;
      this.v[id] = clamp(this.v[id] + f * dt, -CAP, CAP);
    }
    for (let k = 0; k <= nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const id = this.wIdx(i, j, k);
      const f = this.wForce[id];
      if (f === 0 || this.wFixed[id]) continue;
      if (this.isSolid(i, j, k - 1) || this.isSolid(i, j, k)) continue;
      this.w[id] = clamp(this.w[id] + f * dt, -CAP, CAP);
    }
  }

  private addBuoyancy(dt: number): void {
    const { nx, ny, nz } = this;
    const b = this.buoyancy * dt;
    if (b === 0) return;
    for (let k = 0; k < nz; k++) for (let j = 1; j < ny; j++) for (let i = 0; i < nx; i++) {
      const id = this.vIdx(i, j, k);
      if (this.vFixed[id] || this.isSolid(i, j - 1, k) || this.isSolid(i, j, k)) continue;
      const tFace = 0.5 * (this.temp[this.cIdx(i, j - 1, k)] + this.temp[this.cIdx(i, j, k)]);
      this.v[id] += b * tFace; // warm (t>0) rises
    }
  }

  private advectVelocity(dt: number): void {
    const { nx, ny, nz, dx } = this;
    const sdt = dt / dx;
    this.u0.set(this.u); this.v0.set(this.v); this.w0.set(this.w);
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i <= nx; i++) {
      const id = this.uIdx(i, j, k);
      if (this.uFixed[id]) continue;
      const x = i, y = j + 0.5, z = k + 0.5;
      const uu = this.u0[id], vv = this.sV(this.v0, x, y, z), ww = this.sW(this.w0, x, y, z);
      this.u[id] = this.sU(this.u0, x - sdt * uu, y - sdt * vv, z - sdt * ww);
    }
    for (let k = 0; k < nz; k++) for (let j = 0; j <= ny; j++) for (let i = 0; i < nx; i++) {
      const id = this.vIdx(i, j, k);
      if (this.vFixed[id]) continue;
      const x = i + 0.5, y = j, z = k + 0.5;
      const uu = this.sU(this.u0, x, y, z), vv = this.v0[id], ww = this.sW(this.w0, x, y, z);
      this.v[id] = this.sV(this.v0, x - sdt * uu, y - sdt * vv, z - sdt * ww);
    }
    for (let k = 0; k <= nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const id = this.wIdx(i, j, k);
      if (this.wFixed[id]) continue;
      const x = i + 0.5, y = j + 0.5, z = k;
      const uu = this.sU(this.u0, x, y, z), vv = this.sV(this.v0, x, y, z), ww = this.w0[id];
      this.w[id] = this.sW(this.w0, x - sdt * uu, y - sdt * vv, z - sdt * ww);
    }
  }

  private project(): void {
    const { nx, ny, nz } = this;
    this.p.fill(0);
    for (let it = 0; it < this.iterations; it++) {
      for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const c = this.cIdx(i, j, k);
        if (this.solid[c] || this.open[c]) continue;
        const sL = this.isSolid(i - 1, j, k) ? 0 : 1;
        const sR = this.isSolid(i + 1, j, k) ? 0 : 1;
        const sD = this.isSolid(i, j - 1, k) ? 0 : 1;
        const sU = this.isSolid(i, j + 1, k) ? 0 : 1;
        const sB = this.isSolid(i, j, k - 1) ? 0 : 1;
        const sF = this.isSolid(i, j, k + 1) ? 0 : 1;
        const denom = sL + sR + sD + sU + sB + sF;
        if (denom === 0) continue;
        const div =
          this.u[this.uIdx(i + 1, j, k)] - this.u[this.uIdx(i, j, k)] +
          this.v[this.vIdx(i, j + 1, k)] - this.v[this.vIdx(i, j, k)] +
          this.w[this.wIdx(i, j, k + 1)] - this.w[this.wIdx(i, j, k)];
        const pNew =
          (sL * this.pAt(i - 1, j, k) + sR * this.pAt(i + 1, j, k) +
            sD * this.pAt(i, j - 1, k) + sU * this.pAt(i, j + 1, k) +
            sB * this.pAt(i, j, k - 1) + sF * this.pAt(i, j, k + 1) - div) / denom;
        this.p[c] = this.p[c] + this.overRelax * (pNew - this.p[c]);
      }
    }
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 1; i < nx; i++) {
      const id = this.uIdx(i, j, k);
      if (this.uFixed[id] || this.isSolid(i - 1, j, k) || this.isSolid(i, j, k)) continue;
      this.u[id] -= this.pAt(i, j, k) - this.pAt(i - 1, j, k);
    }
    for (let k = 0; k < nz; k++) for (let j = 1; j < ny; j++) for (let i = 0; i < nx; i++) {
      const id = this.vIdx(i, j, k);
      if (this.vFixed[id] || this.isSolid(i, j - 1, k) || this.isSolid(i, j, k)) continue;
      this.v[id] -= this.pAt(i, j, k) - this.pAt(i, j - 1, k);
    }
    for (let k = 1; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const id = this.wIdx(i, j, k);
      if (this.wFixed[id] || this.isSolid(i, j, k - 1) || this.isSolid(i, j, k)) continue;
      this.w[id] -= this.pAt(i, j, k) - this.pAt(i, j, k - 1);
    }
  }
  private pAt(i: number, j: number, k: number): number {
    if (i < 0 || j < 0 || k < 0 || i >= this.nx || j >= this.ny || k >= this.nz) return 0;
    return this.p[this.cIdx(i, j, k)];
  }

  private advectScalar(field: Float32Array, fixed: Uint8Array, val: Float32Array, dt: number, clearOpen: boolean): void {
    const { nx, ny, nz, dx } = this;
    const sdt = dt / dx;
    this.scratch.set(field);
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const c = this.cIdx(i, j, k);
      if (this.solid[c]) { field[c] = 0; continue; }
      if (fixed[c]) { field[c] = val[c]; continue; }
      if (clearOpen && this.open[c]) { field[c] = 0; continue; }
      const x = i + 0.5, y = j + 0.5, z = k + 0.5;
      const uu = this.sU(this.u, x, y, z), vv = this.sV(this.v, x, y, z), ww = this.sW(this.w, x, y, z);
      field[c] = this.sC(this.scratch, x - sdt * uu, y - sdt * vv, z - sdt * ww);
    }
  }

  private diffuse(field: Float32Array, fixed: Uint8Array): void {
    const { nx, ny, nz } = this;
    const kk = this.diffusion;
    this.scratch.set(field);
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const c = this.cIdx(i, j, k);
      if (this.solid[c] || fixed[c]) continue;
      let sum = 0, n = 0;
      if (!this.isSolid(i - 1, j, k)) { sum += this.scratch[this.cIdx(i - 1, j, k)]; n++; }
      if (!this.isSolid(i + 1, j, k)) { sum += this.scratch[this.cIdx(i + 1, j, k)]; n++; }
      if (!this.isSolid(i, j - 1, k)) { sum += this.scratch[this.cIdx(i, j - 1, k)]; n++; }
      if (!this.isSolid(i, j + 1, k)) { sum += this.scratch[this.cIdx(i, j + 1, k)]; n++; }
      if (!this.isSolid(i, j, k - 1)) { sum += this.scratch[this.cIdx(i, j, k - 1)]; n++; }
      if (!this.isSolid(i, j, k + 1)) { sum += this.scratch[this.cIdx(i, j, k + 1)]; n++; }
      if (n > 0) field[c] = this.scratch[c] + kk * (sum / n - this.scratch[c]);
    }
  }

  maxDivergence(): number {
    let m = 0;
    for (let k = 0; k < this.nz; k++) for (let j = 0; j < this.ny; j++) for (let i = 0; i < this.nx; i++) {
      const c = this.cIdx(i, j, k);
      if (this.solid[c] || this.open[c]) continue;
      const div =
        this.u[this.uIdx(i + 1, j, k)] - this.u[this.uIdx(i, j, k)] +
        this.v[this.vIdx(i, j + 1, k)] - this.v[this.vIdx(i, j, k)] +
        this.w[this.wIdx(i, j, k + 1)] - this.w[this.wIdx(i, j, k)];
      if (Math.abs(div) > m) m = Math.abs(div);
    }
    return m;
  }

  velocityAt(i: number, j: number, k: number): [number, number, number] {
    return [
      0.5 * (this.u[this.uIdx(i, j, k)] + this.u[this.uIdx(i + 1, j, k)]),
      0.5 * (this.v[this.vIdx(i, j, k)] + this.v[this.vIdx(i, j + 1, k)]),
      0.5 * (this.w[this.wIdx(i, j, k)] + this.w[this.wIdx(i, j, k + 1)]),
    ];
  }
}

function clamp(x: number, lo: number, hi: number): number { return x < lo ? lo : x > hi ? hi : x; }
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
