import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { buildSim3D } from "../sim/sim3d";
import { useSceneStore } from "../scene/store";

// Steady-state airflow visualization, rendered inside the 3D house. We run the
// Euler solver to equilibrium ONCE (then freeze) and show the final result —
// not a live animation:
//   - airflow       → streamlines (smooth curves tracing the air's path) with
//                     arrowheads for direction (fluid-like, not flying dots)
//   - temperature   → red (warm) / blue (cool) haze + a per-room indicator so
//                     every room shows its result
//   - contamination → violet haze + per-room indicator
// Re-solves automatically when the home, source room, or settings change.

const MAX_HAZE = 14000;
const MAX_LINEV = 18000; // streamline line vertices
const MAX_ARROWS = 200;
const TARGET_STEPS = 200; // steps to reach steady state
const BATCH = 5;
const UP = new THREE.Vector3(0, 1, 0);

function makeSoftTexture(): THREE.Texture {
  const s = 64;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.45, "rgba(255,255,255,0.55)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(c);
}

interface Indicator { pos: [number, number, number]; color: string }

export function FlowField3D() {
  const plan = useSceneStore((s) => s.plan);
  const mode = useSceneStore((s) => s.simMode);
  const sourceRoomId = useSceneStore((s) => s.simSourceRoomId);
  const setSimReady = useSceneStore((s) => s.setSimReady);

  const built = useMemo(() => buildSim3D(plan), [plan]);
  const soft = useMemo(makeSoftTexture, []);

  const hazePos = useMemo(() => new Float32Array(MAX_HAZE * 3), []);
  const hazeCol = useMemo(() => new Float32Array(MAX_HAZE * 3), []);
  const hazeRef = useRef<THREE.Points>(null);
  const linePos = useMemo(() => new Float32Array(MAX_LINEV * 3), []);
  const lineCol = useMemo(() => new Float32Array(MAX_LINEV * 3), []);
  const lineRef = useRef<THREE.LineSegments>(null);
  const arrowRef = useRef<THREE.InstancedMesh>(null);
  const [indicators, setIndicators] = useState<Indicator[]>([]);

  const steps = useRef(0);
  const converged = useRef(false);
  const [ready, setReady] = useState(false);

  // (re)start the solve whenever the home / source changes
  useEffect(() => {
    const room = plan.rooms.find((r) => r.id === sourceRoomId) ?? null;
    built.setSource(room ? room.rect : null);
    steps.current = 0;
    converged.current = false;
    setReady(false);
    setSimReady(false);
  }, [built, sourceRoomId, plan.rooms, setSimReady]);

  const dummy = useMemo(() => new THREE.Object3D(), []);
  const col = useMemo(() => new THREE.Color(), []);
  const quat = useMemo(() => new THREE.Quaternion(), []);
  const dir = useMemo(() => new THREE.Vector3(), []);

  const computeView = useCallback(() => {
    const { sim, nx, ny, nz, dx, origin, cellCenter, worldToCell, seeds } = built;
    const roofY = plan.wallHeight;
    const ox = origin[0], oy = origin[1], oz = origin[2];
    const ex = ox + nx * dx, ez = oz + nz * dx;
    const haze = hazeRef.current, line = lineRef.current, arrow = arrowRef.current;

    if (mode === "airflow") {
      if (haze) haze.visible = false;
      // seeds: vents + a sparse interior grid so the whole house is traced
      const sd: Array<[number, number, number]> = seeds.slice(0, 60).map((s) => [s[0], s[1], s[2]]);
      const stride = Math.max(2, Math.round(Math.cbrt((nx * ny * nz) / 90)));
      for (let k = stride >> 1; k < nz; k += stride)
        for (let j = stride >> 1; j < ny; j += stride)
          for (let i = stride >> 1; i < nx; i += stride) {
            const c = sim.cIdx(i, j, k);
            if (!sim.solid[c] && !sim.open[c]) sd.push(cellCenter(i, j, k));
          }
      let v = 0; // line vertices written
      let a = 0; // arrows
      const stepLen = dx * 0.7;
      const writeV = (x: number, y: number, z: number, sp: number) => {
        if (v >= MAX_LINEV) return;
        linePos[v * 3] = x; linePos[v * 3 + 1] = y; linePos[v * 3 + 2] = z;
        const t = Math.min(1, sp / 1.0);
        lineCol[v * 3] = 0.16 - 0.06 * t; lineCol[v * 3 + 1] = 0.5 - 0.18 * t; lineCol[v * 3 + 2] = 0.95;
        v++;
      };
      for (const seed of sd) {
        if (v + 2 * 36 > MAX_LINEV) break;
        let px = seed[0], py = seed[1], pz = seed[2];
        const pts: Array<[number, number, number, number]> = [];
        for (let s = 0; s < 36; s++) {
          if (px < ox || px > ex || py < oy || py > roofY || pz < oz || pz > ez) break;
          const [i, j, k] = worldToCell(px, py, pz);
          const c = sim.cIdx(i, j, k);
          if (sim.solid[c]) break;
          const [u, vv, w] = sim.velocityAt(i, j, k);
          const sp = Math.hypot(u, vv, w);
          if (sp < 0.03) break;
          pts.push([px, py, pz, sp]);
          px += (u / sp) * stepLen; py += (vv / sp) * stepLen; pz += (w / sp) * stepLen;
        }
        if (pts.length < 4) continue;
        for (let q = 0; q < pts.length - 1; q++) {
          writeV(pts[q][0], pts[q][1], pts[q][2], pts[q][3]);
          writeV(pts[q + 1][0], pts[q + 1][1], pts[q + 1][2], pts[q + 1][3]);
        }
        // arrowhead at the middle, pointing along the flow
        if (arrow && a < MAX_ARROWS) {
          const mi = (pts.length / 2) | 0;
          const [mx, my, mz] = pts[mi];
          const [nx2, ny2, nz2] = pts[Math.min(mi + 1, pts.length - 1)];
          dir.set(nx2 - mx, ny2 - my, nz2 - mz);
          if (dir.lengthSq() < 1e-9) dir.set(0, 1, 0);
          dir.normalize();
          quat.setFromUnitVectors(UP, dir);
          dummy.position.set(mx, my, mz);
          dummy.quaternion.copy(quat);
          dummy.scale.set(dx * 0.9, dx * 1.6, dx * 0.9);
          dummy.updateMatrix();
          arrow.setMatrixAt(a, dummy.matrix);
          col.setRGB(0.12, 0.38, 0.95);
          arrow.setColorAt(a, col);
          a++;
        }
      }
      if (line) {
        line.visible = true;
        line.geometry.setDrawRange(0, v);
        (line.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
        (line.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
      }
      if (arrow) {
        arrow.visible = true;
        arrow.count = a;
        arrow.instanceMatrix.needsUpdate = true;
        if (arrow.instanceColor) arrow.instanceColor.needsUpdate = true;
      }
      setIndicators([]);
      return;
    }

    // temperature / contamination: haze (saturated where strong) + per-room indicator
    if (line) line.visible = false;
    if (arrow) arrow.visible = false;
    let n = 0;
    const field = mode === "temperature" ? sim.temp : sim.s;
    const total = nx * ny * nz;
    for (let c = 0; c < total && n < MAX_HAZE; c++) {
      if (sim.solid[c] || sim.open[c]) continue;
      const val = field[c];
      let r: number, g: number, b: number;
      if (mode === "temperature") {
        const t = val / 10;
        if (Math.abs(t) < 0.18) continue;
        if (t > 0) { r = 0.92; g = 0.27; b = 0.18; } else { r = 0.18; g = 0.46; b = 0.96; }
      } else {
        if (val < 0.1) continue;
        r = 0.55; g = 0.2; b = 0.95;
      }
      const i = c % nx, j = Math.floor(c / nx) % ny, k = Math.floor(c / (nx * ny));
      const [wx, wy, wz] = cellCenter(i, j, k);
      if (wy > roofY) continue;
      hazePos[n * 3] = wx; hazePos[n * 3 + 1] = wy; hazePos[n * 3 + 2] = wz;
      hazeCol[n * 3] = r; hazeCol[n * 3 + 1] = g; hazeCol[n * 3 + 2] = b;
      n++;
    }
    if (haze) {
      haze.visible = n > 0;
      haze.geometry.setDrawRange(0, n);
      (haze.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (haze.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    }

    // per-room indicator: average value over each room → every room shows a result
    const inds: Indicator[] = [];
    for (const room of plan.rooms) {
      const [i0, , k0] = worldToCell(room.rect.x, 0, room.rect.z);
      const [i1, , k1] = worldToCell(room.rect.x + room.rect.w, 0, room.rect.z + room.rect.d);
      let sum = 0, cnt = 0;
      for (let k = k0; k <= k1; k++)
        for (let j = 0; j < ny; j++)
          for (let i = i0; i <= i1; i++) {
            const c = sim.cIdx(i, j, k);
            if (sim.solid[c] || sim.open[c]) continue;
            sum += field[c]; cnt++;
          }
      const avg = cnt ? sum / cnt : 0;
      let color: string;
      if (mode === "temperature") {
        const t = Math.max(-1, Math.min(1, avg / 6));
        if (t >= 0) color = `rgb(${(lerp(220, 235, t)) | 0},${(lerp(220, 70, t)) | 0},${(lerp(220, 55, t)) | 0})`;
        else { const x = -t; color = `rgb(${(lerp(220, 60, x)) | 0},${(lerp(220, 120, x)) | 0},${(lerp(220, 245, x)) | 0})`; }
      } else {
        const x = Math.max(0, Math.min(1, avg));
        color = `rgb(${(lerp(225, 140, x)) | 0},${(lerp(225, 50, x)) | 0},${(lerp(225, 240, x)) | 0})`;
      }
      inds.push({ pos: [room.rect.x + room.rect.w / 2, plan.wallHeight * 0.55, room.rect.z + room.rect.d / 2], color });
    }
    setIndicators(inds);
  }, [built, mode, plan.rooms, plan.wallHeight, hazePos, hazeCol, linePos, lineCol, dummy, col, quat, dir]);

  // recompute the (static) view once converged, or when the mode changes
  useEffect(() => {
    if (ready) computeView();
  }, [ready, computeView]);

  useFrame(() => {
    if (converged.current) return; // steady state: nothing to animate
    for (let b = 0; b < BATCH; b++) built.sim.step(0.05);
    steps.current += BATCH;
    if (steps.current >= TARGET_STEPS) {
      converged.current = true;
      setReady(true);
      setSimReady(true);
    }
  });

  return (
    <group>
      <points ref={hazeRef} frustumCulled={false} visible={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[hazePos, 3]} usage={THREE.DynamicDrawUsage} />
          <bufferAttribute attach="attributes-color" args={[hazeCol, 3]} usage={THREE.DynamicDrawUsage} />
        </bufferGeometry>
        <pointsMaterial map={soft} vertexColors transparent depthWrite={false} sizeAttenuation size={built.dx * 3.2} opacity={0.42} />
      </points>

      <lineSegments ref={lineRef} frustumCulled={false} visible={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[linePos, 3]} usage={THREE.DynamicDrawUsage} />
          <bufferAttribute attach="attributes-color" args={[lineCol, 3]} usage={THREE.DynamicDrawUsage} />
        </bufferGeometry>
        <lineBasicMaterial vertexColors transparent opacity={0.85} />
      </lineSegments>

      <instancedMesh ref={arrowRef} args={[null as unknown as THREE.BufferGeometry, null as unknown as THREE.Material, MAX_ARROWS]} frustumCulled={false} visible={false}>
        <coneGeometry args={[0.5, 1, 7]} />
        <meshStandardMaterial vertexColors transparent opacity={0.95} depthWrite={false} toneMapped={false} />
      </instancedMesh>

      {indicators.map((m, i) => (
        <mesh key={i} position={m.pos}>
          <sphereGeometry args={[built.dx * 1.4, 16, 16]} />
          <meshStandardMaterial color={m.color} emissive={m.color} emissiveIntensity={0.6} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
