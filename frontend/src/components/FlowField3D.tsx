import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { buildSim3D } from "../sim/sim3d";
import { useSceneStore } from "../scene/store";

// The airflow simulation rendered as an easy-to-read "fluid" field inside the 3D
// house (it sits in the editor's centred group, so it lines up with the rooms):
//   - airflow       → particles that stream along with the air (like smoke in a
//                     wind tunnel) — far clearer for non-experts than arrows
//   - temperature   → a soft blue↔red haze (cool vs warm)
//   - contamination → a soft violet haze spreading like smoke
// Soft round sprites overlap into a smooth volume instead of blocky voxels.

const MAX_HAZE = 8000;
const NUM_PARTICLES = 1600;

// soft radial sprite so points blend into a smooth haze / glow
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
  const t = new THREE.CanvasTexture(c);
  return t;
}

export function FlowField3D() {
  const plan = useSceneStore((s) => s.plan);
  const mode = useSceneStore((s) => s.simMode);
  const paused = useSceneStore((s) => s.simPaused);
  const sourceRoomId = useSceneStore((s) => s.simSourceRoomId);

  const built = useMemo(() => buildSim3D(plan), [plan]);
  const soft = useMemo(makeSoftTexture, []);

  // haze buffers (temperature / contamination)
  const hazePos = useMemo(() => new Float32Array(MAX_HAZE * 3), []);
  const hazeCol = useMemo(() => new Float32Array(MAX_HAZE * 3), []);
  const hazeRef = useRef<THREE.Points>(null);

  // particle buffers (airflow tracers)
  const partPos = useMemo(() => new Float32Array(NUM_PARTICLES * 3), []);
  const partCol = useMemo(() => new Float32Array(NUM_PARTICLES * 3), []);
  const partAge = useMemo(() => new Float32Array(NUM_PARTICLES), []);
  const partRef = useRef<THREE.Points>(null);

  useEffect(() => {
    const room = plan.rooms.find((r) => r.id === sourceRoomId) ?? null;
    built.setSource(room ? room.rect : null);
  }, [built, sourceRoomId, plan.rooms]);

  // (re)seed particles into random open air whenever the sim is rebuilt
  const randomAir = useMemo(() => {
    const { sim, nx, ny, nz, cellCenter } = built;
    return (): [number, number, number] => {
      for (let tries = 0; tries < 30; tries++) {
        const i = (Math.random() * nx) | 0;
        const j = (Math.random() * ny) | 0;
        const k = (Math.random() * nz) | 0;
        const c = sim.cIdx(i, j, k);
        if (!sim.solid[c] && !sim.open[c]) {
          const [x, y, z] = cellCenter(i, j, k);
          return [x + (Math.random() - 0.5) * built.dx, y + (Math.random() - 0.5) * built.dx, z + (Math.random() - 0.5) * built.dx];
        }
      }
      return cellCenter(nx >> 1, ny >> 1, nz >> 1);
    };
  }, [built]);

  useEffect(() => {
    for (let p = 0; p < NUM_PARTICLES; p++) {
      const [x, y, z] = randomAir();
      partPos[p * 3] = x; partPos[p * 3 + 1] = y; partPos[p * 3 + 2] = z;
      partAge[p] = Math.random() * 2;
    }
    if (partRef.current) partRef.current.geometry.attributes.position.needsUpdate = true;
  }, [randomAir, partPos, partAge]);

  useFrame((_, delta) => {
    const { sim, nx, ny, nz, dx, origin, cellCenter, worldToCell } = built;
    if (!paused) sim.step(0.05);
    const dt = Math.min(delta, 0.05);

    // ---- haze (temperature / contamination) ----
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
            const t = Math.max(-1, Math.min(1, v / 12));
            if (Math.abs(t) < 0.14) continue;
            if (t >= 0) { r = 0.86; g = 0.30 + 0.25 * (1 - t); b = 0.28; }
            else { const a = -t; r = 0.30 + 0.25 * (1 - a); g = 0.55; b = 0.96; }
          } else {
            if (v < 0.06) continue;
            r = 0.55; g = 0.22; b = 0.95;
          }
          const i = c % nx;
          const j = Math.floor(c / nx) % ny;
          const k = Math.floor(c / (nx * ny));
          const [wx, wy, wz] = cellCenter(i, j, k);
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

    // ---- airflow particles ----
    const part = partRef.current;
    if (part) {
      part.visible = mode === "airflow";
      if (mode === "airflow") {
        const ox = origin[0], oy = origin[1], oz = origin[2];
        const ex = ox + nx * dx, ey = oy + ny * dx, ez = oz + nz * dx;
        for (let p = 0; p < NUM_PARTICLES; p++) {
          let x = partPos[p * 3], y = partPos[p * 3 + 1], z = partPos[p * 3 + 2];
          const [i, j, k] = worldToCell(x, y, z);
          const c = sim.cIdx(i, j, k);
          const [u, v, w] = sim.velocityAt(i, j, k);
          const sp = Math.hypot(u, v, w);
          partAge[p] += dt;
          // respawn stale, escaped, or stuck particles into fresh air
          if (
            partAge[p] > 3.5 || sp < 0.02 || sim.solid[c] || sim.open[c] ||
            x < ox || x > ex || y < oy || y > ey || z < oz || z > ez
          ) {
            const [rx, ry, rz] = randomAir();
            x = rx; y = ry; z = rz; partAge[p] = 0;
          } else {
            const m = 2.2; // visual speed multiplier
            x += u * dt * m; y += v * dt * m; z += w * dt * m;
          }
          partPos[p * 3] = x; partPos[p * 3 + 1] = y; partPos[p * 3 + 2] = z;
          const t = Math.min(1, sp / 1.0);
          partCol[p * 3] = 0.15 + 0.35 * t;
          partCol[p * 3 + 1] = 0.55 + 0.25 * t;
          partCol[p * 3 + 2] = 0.85;
        }
        (part.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
        (part.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
      }
    }
  });

  return (
    <group>
      <points ref={hazeRef} frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[hazePos, 3]} usage={THREE.DynamicDrawUsage} />
          <bufferAttribute attach="attributes-color" args={[hazeCol, 3]} usage={THREE.DynamicDrawUsage} />
        </bufferGeometry>
        <pointsMaterial
          map={soft}
          vertexColors
          transparent
          depthWrite={false}
          sizeAttenuation
          size={built.dx * 3.2}
          opacity={0.32}
        />
      </points>

      <points ref={partRef} frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[partPos, 3]} usage={THREE.DynamicDrawUsage} />
          <bufferAttribute attach="attributes-color" args={[partCol, 3]} usage={THREE.DynamicDrawUsage} />
        </bufferGeometry>
        <pointsMaterial
          map={soft}
          vertexColors
          transparent
          depthWrite={false}
          sizeAttenuation
          size={built.dx * 1.1}
          opacity={0.95}
        />
      </points>
    </group>
  );
}
