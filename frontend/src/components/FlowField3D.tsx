import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { buildSim3D } from "../sim/sim3d";
import { useSceneStore } from "../scene/store";

// The airflow simulation, rendered live inside the 3D house (it sits in the
// editor's centred group, so it lines up with the rooms). Voxel cloud shows
// temperature (blue↔red) or contaminant (violet); instanced darts show airflow
// direction. Steps a 3D Euler solver each frame — buoyancy makes warm air rise.

const MAX_CLOUD = 9000;
const MAX_ARROWS = 2200;
const UP = new THREE.Vector3(0, 1, 0);

export function FlowField3D() {
  const plan = useSceneStore((s) => s.plan);
  const mode = useSceneStore((s) => s.simMode);
  const paused = useSceneStore((s) => s.simPaused);
  const sourceRoomId = useSceneStore((s) => s.simSourceRoomId);

  const built = useMemo(() => buildSim3D(plan), [plan]);
  const cloudRef = useRef<THREE.InstancedMesh>(null);
  const arrowRef = useRef<THREE.InstancedMesh>(null);

  useEffect(() => {
    const room = plan.rooms.find((r) => r.id === sourceRoomId) ?? null;
    built.setSource(room ? room.rect : null);
  }, [built, sourceRoomId, plan.rooms]);

  // start with nothing rendered until the first frame fills the instances
  useEffect(() => {
    if (cloudRef.current) cloudRef.current.count = 0;
    if (arrowRef.current) arrowRef.current.count = 0;
  }, [built]);

  const samples = useMemo(() => {
    const { nx, ny, nz } = built;
    const step = Math.max(1, Math.round(Math.cbrt((nx * ny * nz) / MAX_ARROWS)));
    const arr: Array<[number, number, number]> = [];
    for (let k = step >> 1; k < nz; k += step)
      for (let j = step >> 1; j < ny; j += step)
        for (let i = step >> 1; i < nx; i += step) arr.push([i, j, k]);
    return arr;
  }, [built]);

  const dummy = useMemo(() => new THREE.Object3D(), []);
  const color = useMemo(() => new THREE.Color(), []);
  const quat = useMemo(() => new THREE.Quaternion(), []);
  const dir = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    const { sim, nx, ny, nz, dx, cellCenter } = built;
    if (!paused) sim.step(0.05);

    const cloud = cloudRef.current;
    if (cloud) {
      let n = 0;
      if (mode !== "airflow") {
        const field = mode === "temperature" ? sim.temp : sim.s;
        const total = nx * ny * nz;
        for (let c = 0; c < total && n < MAX_CLOUD; c++) {
          if (sim.solid[c] || sim.open[c]) continue;
          const v = field[c];
          let mag: number, r: number, gg: number, b: number;
          if (mode === "temperature") {
            const t = Math.max(-1, Math.min(1, v / 12));
            mag = Math.abs(t);
            if (mag < 0.14) continue;
            if (t >= 0) { r = 0.85; gg = 0.33; b = 0.31; } else { r = 0.23; gg = 0.51; b = 0.96; }
          } else {
            mag = Math.min(1, v);
            if (mag < 0.08) continue;
            r = 0.49; gg = 0.23; b = 0.93;
          }
          const i = c % nx;
          const j = Math.floor(c / nx) % ny;
          const k = Math.floor(c / (nx * ny));
          const [wx, wy, wz] = cellCenter(i, j, k);
          const s = dx * (0.35 + 0.65 * mag);
          dummy.position.set(wx, wy, wz);
          dummy.scale.set(s, s, s);
          dummy.rotation.set(0, 0, 0);
          dummy.updateMatrix();
          cloud.setMatrixAt(n, dummy.matrix);
          color.setRGB(r, gg, b);
          cloud.setColorAt(n, color);
          n++;
        }
      }
      cloud.count = n;
      cloud.instanceMatrix.needsUpdate = true;
      if (cloud.instanceColor) cloud.instanceColor.needsUpdate = true;
    }

    const arrow = arrowRef.current;
    if (arrow) {
      let n = 0;
      if (mode === "airflow") {
        let smax = 1e-6;
        for (const [i, j, k] of samples) {
          const c = sim.cIdx(i, j, k);
          if (sim.solid[c] || sim.open[c]) continue;
          const [u, v, w] = sim.velocityAt(i, j, k);
          const m = Math.hypot(u, v, w);
          if (m > smax) smax = m;
        }
        for (const [i, j, k] of samples) {
          if (n >= MAX_ARROWS) break;
          const c = sim.cIdx(i, j, k);
          if (sim.solid[c] || sim.open[c]) continue;
          const [u, v, w] = sim.velocityAt(i, j, k);
          const m = Math.hypot(u, v, w);
          if (m < smax * 0.12) continue;
          const [wx, wy, wz] = cellCenter(i, j, k);
          dir.set(u / m, v / m, w / m);
          quat.setFromUnitVectors(UP, dir);
          const len = dx * (0.9 + 1.1 * Math.min(1, m / smax));
          dummy.position.set(wx, wy, wz);
          dummy.quaternion.copy(quat);
          dummy.scale.set(dx * 0.5, len, dx * 0.5);
          dummy.updateMatrix();
          arrow.setMatrixAt(n, dummy.matrix);
          const t = Math.min(1, m / smax);
          color.setRGB(0.12 + 0.45 * t, 0.5, 0.72 - 0.32 * t);
          arrow.setColorAt(n, color);
          n++;
        }
      }
      arrow.count = n;
      arrow.instanceMatrix.needsUpdate = true;
      if (arrow.instanceColor) arrow.instanceColor.needsUpdate = true;
    }
  });

  return (
    <group>
      <instancedMesh ref={cloudRef} args={[null as unknown as THREE.BufferGeometry, null as unknown as THREE.Material, MAX_CLOUD]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial transparent opacity={0.5} depthWrite={false} />
      </instancedMesh>
      <instancedMesh ref={arrowRef} args={[null as unknown as THREE.BufferGeometry, null as unknown as THREE.Material, MAX_ARROWS]} frustumCulled={false}>
        <coneGeometry args={[0.5, 1, 7]} />
        <meshStandardMaterial transparent opacity={0.92} depthWrite={false} />
      </instancedMesh>
    </group>
  );
}
