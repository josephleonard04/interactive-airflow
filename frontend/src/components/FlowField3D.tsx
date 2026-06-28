import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { buildSim3D, advectDiffuseFill } from "../sim/sim3d";
import { useSceneStore } from "../scene/store";

// Steady-state airflow visualization inside the 3D house. The Euler solver runs to
// equilibrium ONCE, then we show the settled result:
//   - airflow       → soft dots that keep drifting along the steady flow (no arrows)
//   - temperature   → rooms filled red (warm) / blue (cool); spreads through OPEN
//                     doors to connected rooms, blocked by walls / closed doors
//   - contamination → connected rooms filled violet from the source room
// Temperature/smell use a room-connectivity model (open doors link rooms, open
// windows vent to ambient) so "the whole house is affected if the doors are open".

const MAX_HAZE = 16000;
const NUM_PARTICLES = 500;
const TARGET_STEPS = 180;
const BATCH = 6;

function makeSoftTexture(): THREE.Texture {
  const s = 64;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.45, "rgba(255,255,255,0.5)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(c);
}

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

  const head = useMemo(() => new Float32Array(NUM_PARTICLES * 3), []);
  const ageA = useMemo(() => new Float32Array(NUM_PARTICLES), []);
  const maxAgeA = useMemo(() => new Float32Array(NUM_PARTICLES), []);
  const headCol = useMemo(() => new Float32Array(NUM_PARTICLES * 3), []);
  const headRef = useRef<THREE.Points>(null);

  const steps = useRef(0);
  const converged = useRef(false);
  const fieldsRef = useRef<{ temp: Float32Array; smell: Float32Array } | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const room = plan.rooms.find((r) => r.id === sourceRoomId) ?? null;
    built.setSource(room ? room.rect : null);
    steps.current = 0;
    converged.current = false;
    setReady(false);
    setSimReady(false);
  }, [built, sourceRoomId, plan.rooms, setSimReady]);

  const spawn = useMemo(() => {
    const { sim, nx, ny, nz, dx, cellCenter, seeds } = built;
    return (p: number) => {
      let pos: [number, number, number] | null = null;
      if (seeds.length && Math.random() < 0.7) {
        const s = seeds[(Math.random() * seeds.length) | 0];
        pos = [s[0] + (Math.random() - 0.5) * dx, s[1] + (Math.random() - 0.5) * dx, s[2] + (Math.random() - 0.5) * dx];
      } else {
        for (let t = 0; t < 25; t++) {
          const i = (Math.random() * nx) | 0, j = (Math.random() * ny) | 0, k = (Math.random() * nz) | 0;
          const c = sim.cIdx(i, j, k);
          if (!sim.solid[c] && !sim.open[c]) { pos = cellCenter(i, j, k); break; }
        }
      }
      if (!pos) pos = cellCenter(nx >> 1, ny >> 1, nz >> 1);
      head[p * 3] = pos[0]; head[p * 3 + 1] = pos[1]; head[p * 3 + 2] = pos[2];
      ageA[p] = Math.random() * 2;
      maxAgeA[p] = 2 + Math.random() * 2.5;
    };
  }, [built, head, ageA, maxAgeA]);

  useEffect(() => { for (let p = 0; p < NUM_PARTICLES; p++) spawn(p); }, [spawn]);

  // render the airflow-carried temperature / smell field as a gradient that covers
  // the whole connected house (intensity = strength), from the cached steady field
  const computeHaze = useCallback(() => {
    const haze = hazeRef.current;
    if (!haze) return;
    const F = fieldsRef.current;
    if (mode === "airflow" || !F) { haze.visible = false; return; }
    const { sim, nx, ny, nz, cellCenter, ambient } = built;
    const roofY = plan.wallHeight;
    const field = mode === "temperature" ? F.temp : F.smell;
    let mx = 1e-6;
    for (let c = 0; c < nx * ny * nz; c++) {
      if (sim.solid[c] || ambient[c]) continue;
      const a = Math.abs(field[c]);
      if (a > mx) mx = a;
    }
    let n = 0;
    const total = nx * ny * nz;
    for (let c = 0; c < total && n < MAX_HAZE; c++) {
      if (sim.solid[c] || ambient[c]) continue;
      const t = field[c] / mx; // normalized −1..1 (temp) or 0..1 (smell)
      let r: number, g: number, b: number;
      if (mode === "temperature") {
        const a = Math.abs(t);
        if (a < 0.03) continue; // skip ~neutral air
        if (t > 0) { r = 0.95; g = 0.85 - 0.6 * a; b = 0.82 - 0.62 * a; } // pale → deep red
        else { r = 0.82 - 0.62 * a; g = 0.88 - 0.4 * a; b = 0.97; } // pale → deep blue
      } else {
        if (t < 0.03) continue;
        r = 0.92 - 0.4 * t; g = 0.82 - 0.6 * t; b = 0.97 - 0.04 * t; // pale lavender → deep violet
      }
      const i = c % nx, j = Math.floor(c / nx) % ny, k = Math.floor(c / (nx * ny));
      const [wx, wy, wz] = cellCenter(i, j, k);
      if (wy > roofY) continue;
      hazePos[n * 3] = wx; hazePos[n * 3 + 1] = wy; hazePos[n * 3 + 2] = wz;
      hazeCol[n * 3] = r; hazeCol[n * 3 + 1] = g; hazeCol[n * 3 + 2] = b;
      n++;
    }
    haze.visible = n > 0;
    haze.geometry.setDrawRange(0, n);
    (haze.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (haze.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }, [built, mode, plan.wallHeight, hazePos, hazeCol]);

  useEffect(() => { if (ready) computeHaze(); }, [ready, computeHaze]);

  useFrame((_, delta) => {
    // converge to steady state once
    if (!converged.current) {
      for (let b = 0; b < BATCH; b++) built.sim.step(0.05);
      steps.current += BATCH;
      if (steps.current >= TARGET_STEPS) {
        // freeze and solve the airflow-carried temperature & smell fields once
        const sim = built.sim;
        fieldsRef.current = {
          temp: advectDiffuseFill(built, sim.tempFixed, sim.tempVal),
          smell: advectDiffuseFill(built, sim.sFixed, sim.sVal),
        };
        converged.current = true;
        setReady(true);
        setSimReady(true);
      }
      return;
    }
    // airflow: keep drifting dots through the (frozen) steady flow
    const headPts = headRef.current;
    const showAir = mode === "airflow";
    if (headPts) headPts.visible = showAir;
    if (!showAir || !headPts) return;
    const { sim, nx, ny, nz, dx, origin, worldToCell } = built;
    const dt = Math.min(delta, 0.05);
    const roofY = plan.wallHeight;
    const ox = origin[0], oy = origin[1], oz = origin[2];
    const ex = ox + nx * dx, ey = Math.min(oy + ny * dx, roofY), ez = oz + nz * dx;
    for (let p = 0; p < NUM_PARTICLES; p++) {
      let x = head[p * 3], y = head[p * 3 + 1], z = head[p * 3 + 2];
      const [i, j, k] = worldToCell(x, y, z);
      const [u, v, w] = sim.velocityAt(i, j, k);
      const sp = Math.hypot(u, v, w);
      ageA[p] += dt;
      const cx = x + u * dt * 1.8, cy = y + v * dt * 1.8, cz = z + w * dt * 1.8;
      const out = cx < ox || cx > ex || cy < oy || cy > ey || cz < oz || cz > ez;
      if (!out) {
        const [ci, cj, ck] = worldToCell(cx, cy, cz);
        const cc = sim.cIdx(ci, cj, ck);
        if (sim.open[cc]) { spawn(p); x = head[p * 3]; y = head[p * 3 + 1]; z = head[p * 3 + 2]; }
        else if (!sim.solid[cc]) { x = cx; y = cy; z = cz; }
      } else { spawn(p); x = head[p * 3]; y = head[p * 3 + 1]; z = head[p * 3 + 2]; }
      if (ageA[p] > maxAgeA[p] || sp < 0.015) { spawn(p); x = head[p * 3]; y = head[p * 3 + 1]; z = head[p * 3 + 2]; }
      head[p * 3] = x; head[p * 3 + 1] = y; head[p * 3 + 2] = z;
      const t = Math.min(1, sp / 1.0);
      headCol[p * 3] = 0.18 - 0.06 * t; headCol[p * 3 + 1] = 0.5 - 0.18 * t; headCol[p * 3 + 2] = 0.95;
    }
    (headPts.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (headPts.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  });

  return (
    <group>
      <points ref={hazeRef} frustumCulled={false} visible={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[hazePos, 3]} usage={THREE.DynamicDrawUsage} />
          <bufferAttribute attach="attributes-color" args={[hazeCol, 3]} usage={THREE.DynamicDrawUsage} />
        </bufferGeometry>
        <pointsMaterial map={soft} vertexColors transparent depthWrite={false} sizeAttenuation size={built.dx * 2.7} opacity={0.2} />
      </points>

      <points ref={headRef} frustumCulled={false} visible={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[head, 3]} usage={THREE.DynamicDrawUsage} />
          <bufferAttribute attach="attributes-color" args={[headCol, 3]} usage={THREE.DynamicDrawUsage} />
        </bufferGeometry>
        <pointsMaterial map={soft} vertexColors transparent depthWrite={false} sizeAttenuation size={built.dx * 1.6} opacity={0.9} />
      </points>
    </group>
  );
}
