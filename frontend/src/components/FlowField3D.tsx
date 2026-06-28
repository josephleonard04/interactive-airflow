import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { buildSim3D } from "../sim/sim3d";
import { useSceneStore } from "../scene/store";

// The airflow simulation rendered to be read at a glance inside the 3D house:
//   - airflow       → comet trails seeded FROM the vents, so air visibly streams
//                     out of the AC/fan and travels to the openings (not noise);
//                     particles are kept inside the house (no escaping walls/roof)
//   - temperature   → saturated red (hot) / blue (cold) blobs; neutral air stays
//                     clear, and a glowing marker anchors each heat/cold source
//   - contamination → a violet haze from a marked source room
// Soft round sprites overlap into a smooth volume rather than blocky voxels.

const MAX_HAZE = 9000;
const NUM_PARTICLES = 450;

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

export function FlowField3D() {
  const plan = useSceneStore((s) => s.plan);
  const mode = useSceneStore((s) => s.simMode);
  const paused = useSceneStore((s) => s.simPaused);
  const sourceRoomId = useSceneStore((s) => s.simSourceRoomId);

  const built = useMemo(() => buildSim3D(plan), [plan]);
  const soft = useMemo(makeSoftTexture, []);

  const hazePos = useMemo(() => new Float32Array(MAX_HAZE * 3), []);
  const hazeCol = useMemo(() => new Float32Array(MAX_HAZE * 3), []);
  const hazeRef = useRef<THREE.Points>(null);

  // airflow particles: soft dots that drift with the air (seeded from vents)
  const head = useMemo(() => new Float32Array(NUM_PARTICLES * 3), []);
  const age = useMemo(() => new Float32Array(NUM_PARTICLES), []);
  const maxAge = useMemo(() => new Float32Array(NUM_PARTICLES), []);
  const headCol = useMemo(() => new Float32Array(NUM_PARTICLES * 3), []);
  const headRef = useRef<THREE.Points>(null);

  useEffect(() => {
    const room = plan.rooms.find((r) => r.id === sourceRoomId) ?? null;
    built.setSource(room ? room.rect : null);
  }, [built, sourceRoomId, plan.rooms]);

  const spawn = useMemo(() => {
    const { sim, nx, ny, nz, dx, cellCenter, seeds } = built;
    return (p: number) => {
      let pos: [number, number, number] | null = null;
      // mostly seed from vents so flow has a clear origin; otherwise random air
      if (seeds.length && Math.random() < 0.75) {
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
      age[p] = 0;
      maxAge[p] = 1.5 + Math.random() * 2.5;
    };
  }, [built, head, age, maxAge]);

  useEffect(() => {
    for (let p = 0; p < NUM_PARTICLES; p++) spawn(p);
  }, [spawn]);

  // source markers (heat=red, cold=blue, smell=violet) anchor each field
  const markers = useMemo(() => {
    if (mode === "temperature") {
      return built.markers.map((m) => ({ pos: m.pos, color: m.kind === "hot" ? "#e0492c" : "#2f7bf6" }));
    }
    if (mode === "contamination") {
      const r = plan.rooms.find((rm) => rm.id === sourceRoomId);
      if (r) return [{ pos: [r.rect.x + r.rect.w / 2, plan.wallHeight * 0.45, r.rect.z + r.rect.d / 2] as [number, number, number], color: "#8b3aed" }];
    }
    return [];
  }, [mode, built, plan.rooms, plan.wallHeight, sourceRoomId]);

  useFrame((_, delta) => {
    const { sim, nx, ny, nz, dx, origin, cellCenter, worldToCell } = built;
    if (!paused) sim.step(0.05);
    const dt = Math.min(delta, 0.05);
    const roofY = plan.wallHeight; // keep everything under the roof

    // ---- haze (temperature / contamination): saturated blobs, neutral clear ----
    const haze = hazeRef.current;
    if (haze) {
      let n = 0;
      if (mode !== "airflow") {
        const field = mode === "temperature" ? sim.temp : sim.s;
        const total = nx * ny * nz;
        for (let c = 0; c < total && n < MAX_HAZE; c++) {
          if (sim.solid[c] || sim.open[c]) continue;
          const v = field[c];
          let r: number, g: number, b: number;
          if (mode === "temperature") {
            const t = v / 12;
            if (Math.abs(t) < 0.2) continue; // neutral air stays clear
            if (t > 0) { r = 0.92; g = 0.27; b = 0.18; } else { r = 0.18; g = 0.46; b = 0.96; }
          } else {
            if (v < 0.1) continue;
            r = 0.55; g = 0.2; b = 0.95;
          }
          const i = c % nx, j = Math.floor(c / nx) % ny, k = Math.floor(c / (nx * ny));
          const [wx, wy, wz] = cellCenter(i, j, k);
          if (wy > roofY) continue; // never above the roof
          hazePos[n * 3] = wx; hazePos[n * 3 + 1] = wy; hazePos[n * 3 + 2] = wz;
          hazeCol[n * 3] = r; hazeCol[n * 3 + 1] = g; hazeCol[n * 3 + 2] = b;
          n++;
        }
      }
      haze.visible = mode !== "airflow" && n > 0;
      haze.geometry.setDrawRange(0, n);
      (haze.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (haze.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    }

    // ---- airflow: soft dots drifting with the air (seeded from vents, contained) ----
    const headPts = headRef.current;
    const showAir = mode === "airflow";
    if (headPts) headPts.visible = showAir;
    if (showAir && headPts) {
      const ox = origin[0], oy = origin[1], oz = origin[2];
      const ex = ox + nx * dx, ey = Math.min(oy + ny * dx, roofY), ez = oz + nz * dx;
      for (let p = 0; p < NUM_PARTICLES; p++) {
        let x = head[p * 3], y = head[p * 3 + 1], z = head[p * 3 + 2];
        const [i, j, k] = worldToCell(x, y, z);
        const [u, v, w] = sim.velocityAt(i, j, k);
        const sp = Math.hypot(u, v, w);
        age[p] += dt;
        const cand: [number, number, number] = [x + u * dt * 1.8, y + v * dt * 1.8, z + w * dt * 1.8];
        const out = cand[0] < ox || cand[0] > ex || cand[1] < oy || cand[1] > ey || cand[2] < oz || cand[2] > ez;
        if (!out) {
          const [ci, cj, ck] = worldToCell(cand[0], cand[1], cand[2]);
          const cc = sim.cIdx(ci, cj, ck);
          if (sim.open[cc]) { spawn(p); x = head[p * 3]; y = head[p * 3 + 1]; z = head[p * 3 + 2]; }
          else if (!sim.solid[cc]) { x = cand[0]; y = cand[1]; z = cand[2]; } // else slide (keep pos)
        } else { spawn(p); x = head[p * 3]; y = head[p * 3 + 1]; z = head[p * 3 + 2]; }
        if (age[p] > maxAge[p] || sp < 0.015) { spawn(p); x = head[p * 3]; y = head[p * 3 + 1]; z = head[p * 3 + 2]; }
        head[p * 3] = x; head[p * 3 + 1] = y; head[p * 3 + 2] = z;
        // colour by speed: gentle sky-blue (slow) → deeper blue (fast)
        const tt = Math.min(1, sp / 1.0);
        headCol[p * 3] = 0.20 - 0.08 * tt;
        headCol[p * 3 + 1] = 0.55 - 0.20 * tt;
        headCol[p * 3 + 2] = 0.95;
      }
      (headPts.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (headPts.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    }
  });

  return (
    <group>
      <points ref={hazeRef} frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[hazePos, 3]} usage={THREE.DynamicDrawUsage} />
          <bufferAttribute attach="attributes-color" args={[hazeCol, 3]} usage={THREE.DynamicDrawUsage} />
        </bufferGeometry>
        <pointsMaterial map={soft} vertexColors transparent depthWrite={false} sizeAttenuation size={built.dx * 3.2} opacity={0.4} />
      </points>

      <points ref={headRef} frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[head, 3]} usage={THREE.DynamicDrawUsage} />
          <bufferAttribute attach="attributes-color" args={[headCol, 3]} usage={THREE.DynamicDrawUsage} />
        </bufferGeometry>
        <pointsMaterial map={soft} vertexColors transparent depthWrite={false} sizeAttenuation size={built.dx * 1.7} opacity={0.9} />
      </points>

      {markers.map((m, idx) => (
        <mesh key={idx} position={m.pos}>
          <sphereGeometry args={[built.dx * 1.1, 16, 16]} />
          <meshStandardMaterial color={m.color} emissive={m.color} emissiveIntensity={0.8} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}
