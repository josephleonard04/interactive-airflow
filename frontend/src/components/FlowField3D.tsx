import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Line } from "@react-three/drei";
import * as THREE from "three";
import { buildSim3D, geodesicFields, roomMeans } from "../sim/sim3d";
import { tempColor } from "../viz/temperature";
import { computeNoiseField } from "../sim/noise";
import { useSceneStore } from "../scene/store";
import { applyFieldToSim } from "../engine/accurate";
import { STREAMLINE_BLUE, buildStreamlinePaths, type StreamlinePaths } from "../viz/streamlines";
import { FLOW_RENDER_ORDER } from "../viz/layers";

// Steady-state airflow visualization inside the 3D house. The Euler solver runs to
// equilibrium ONCE, then we show the settled result:
//   - airflow       → soft dots that keep drifting along the steady flow (no arrows)
//   - temperature   → rooms filled red (warm) / blue (cool); spreads through OPEN
//                     doors to connected rooms, blocked by walls / closed doors
//   - contamination → connected rooms filled violet from the source room
// Temperature/smell use a room-connectivity model (open doors link rooms, open
// windows vent to ambient) so "the whole house is affected if the doors are open".

const DOT_RGB = (() => {
  const c = new THREE.Color(STREAMLINE_BLUE);
  return [c.r, c.g, c.b] as const;
})();

const MAX_HAZE = 16000;
const NUM_PARTICLES = 850;
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
  const engine = useSceneStore((s) => s.engine);
  const accurate = useSceneStore((s) => s.accurate);
  const airflowStyle = useSceneStore((s) => s.airflowStyle);
  const outdoorTemp = useSceneStore((s) => s.outdoorTemp);
  const setRoomTemps = useSceneStore((s) => s.setRoomTemps);

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
  const fieldsRef = useRef<{ temp: Float32Array; smell: Float32Array; noise: Float32Array } | null>(null);
  const [ready, setReady] = useState(false);
  const [paths, setPaths] = useState<StreamlinePaths | null>(null);
  const dashRef = useRef<React.ComponentRef<typeof Line> | null>(null);

  useEffect(() => {
    const room = plan.rooms.find((r) => r.id === sourceRoomId) ?? null;
    built.setSource(room ? room.rect : null);
    steps.current = 0;
    converged.current = false;
    setReady(false);
    setPaths(null);
    setSimReady(false);
  }, [built, sourceRoomId, plan.rooms, setSimReady, engine, accurate]);

  // Build smooth streamlines from the frozen steady-state velocity field.
  const buildPaths = useCallback(
    () =>
      setPaths(
        buildStreamlinePaths(built, {
          roofY: plan.wallHeight,
          // Seeds are allotted round-robin across the rooms. Lines now run to
          // their natural end rather than stopping at the first busy cell, so
          // each seed covers more ground: 60 -> ~30 long lines, every room.
          maxSeeds: 60,
          rooms: plan.rooms.map((r) => r.rect),
        }),
      ),
    [built, plan.wallHeight, plan.rooms],
  );

  const useOpenFoam = engine === "openfoam" && accurate?.field != null;

  const spawn = useMemo(() => {
    const { sim, nx, ny, nz, dx, cellCenter, seeds } = built;
    return (p: number) => {
      let pos: [number, number, number] | null = null;
      // ~1/3 of particles spawn at the AC/supply vents (where air is born); the
      // rest spawn anywhere in the house — air moves everywhere, so every room
      // shows drifting particles, not just the AC room.
      if (seeds.length && Math.random() < 0.35) {
        const s = seeds[(Math.random() * seeds.length) | 0];
        pos = [s[0] + (Math.random() - 0.5) * dx, s[1] + (Math.random() - 0.5) * dx, s[2] + (Math.random() - 0.5) * dx];
      } else {
        for (let t = 0; t < 30; t++) {
          const i = (Math.random() * nx) | 0, j = (Math.random() * ny) | 0, k = (Math.random() * nz) | 0;
          const c = sim.cIdx(i, j, k);
          if (sim.solid[c] || sim.open[c]) continue;
          pos = cellCenter(i, j, k);
          break;
        }
      }
      if (!pos) pos = cellCenter(nx >> 1, ny >> 1, nz >> 1);
      head[p * 3] = pos[0]; head[p * 3 + 1] = pos[1]; head[p * 3 + 2] = pos[2];
      ageA[p] = Math.random() * 2;
      maxAgeA[p] = 2 + Math.random() * 2.5;
    };
  }, [built, head, ageA, maxAgeA]);

  useEffect(() => { for (let p = 0; p < NUM_PARTICLES; p++) spawn(p); }, [spawn]);

  // render temperature / smell as a flat 2D top-down coloured layer: average the
  // airflow-carried field down each vertical column and lay one coloured sheet of
  // soft points over the floor plan (intensity = strength)
  const computeHaze = useCallback(() => {
    const haze = hazeRef.current;
    if (!haze) return;
    const F = fieldsRef.current;
    if (mode === "airflow" || !F) { haze.visible = false; return; }
    const { sim, nx, ny, nz, cellCenter, inside } = built;
    const field = mode === "temperature" ? F.temp : mode === "noise" ? F.noise : F.smell;
    // column average over height → a 2D (x,z) map. Only cells INSIDE the home
    // count: the domain extends past the exterior walls, and with a window open
    // the air (and the heat and odour it carries) genuinely spills into those
    // outdoor cells — physically right, but we draw the home, not the outdoors.
    const colSum = new Float64Array(nx * nz);
    const colN = new Int32Array(nx * nz);
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const c = sim.cIdx(i, j, k);
          if (sim.solid[c] || !inside[c]) continue;
          const q = i + nx * k;
          colSum[q] += field[c];
          colN[q]++;
        }
    let mx = 1e-6;
    for (let q = 0; q < nx * nz; q++) if (colN[q]) { const a = Math.abs(colSum[q] / colN[q]); if (a > mx) mx = a; }

    const Y0 = 0.18; // floor-level sheet
    let n = 0;
    for (let k = 0; k < nz; k++)
      for (let i = 0; i < nx && n < MAX_HAZE; i++) {
        const q = i + nx * k;
        if (!colN[q]) continue;
        let r: number, g: number, b: number;
        if (mode === "temperature") {
          // Absolute °C = outdoor baseline + the solver's delta, through a fixed
          // comfort-anchored ramp. EVERY interior column is drawn — a room at the
          // baseline is not "no data", it is a real temperature the user wants to
          // see. (The old code skipped near-zero deltas, which is why most of the
          // house showed nothing.)
          const c = tempColor(outdoorTemp + colSum[q] / colN[q]);
          r = c.r; g = c.g; b = c.b;
        } else if (mode === "noise") {
          const t = colSum[q] / colN[q] / mx;
          let a = t;
          if (a < 0.04) continue;
          a = Math.sqrt(a); // green (quiet) → yellow → red (loud)
          if (a < 0.5) { const u = a / 0.5; r = 0.13 + 0.85 * u; g = 0.77 + 0.03 * u; b = 0.37 - 0.29 * u; }
          else { const u = (a - 0.5) / 0.5; r = 0.98 - 0.12 * u; g = 0.80 - 0.65 * u; b = 0.08 + 0.06 * u; }
        } else {
          let a = colSum[q] / colN[q] / mx;
          if (a < 0.02) continue;
          a = Math.sqrt(a);
          r = 0.80 - 0.50 * a; g = 0.52 - 0.45 * a; b = 0.96 - 0.06 * a; // light lavender → deep violet
        }
        const [wx, , wz] = cellCenter(i, 0, k);
        hazePos[n * 3] = wx; hazePos[n * 3 + 1] = Y0; hazePos[n * 3 + 2] = wz;
        hazeCol[n * 3] = r; hazeCol[n * 3 + 1] = g; hazeCol[n * 3 + 2] = b;
        n++;
      }
    haze.visible = n > 0;
    haze.geometry.setDrawRange(0, n);
    (haze.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (haze.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }, [built, mode, hazePos, hazeCol, outdoorTemp]);

  useEffect(() => { if (ready) computeHaze(); }, [ready, computeHaze]);

  useFrame((_, delta) => {
    // Dashes travel downstream so the air visibly FLOWS along each line. This is
    // the only cue that says which WAY the air is going, so it needs to be quick
    // enough to read at a glance — 0.55 was a slow crawl.
    if (dashRef.current) dashRef.current.material.dashOffset -= delta * 2.2;
    // converge to steady state once
    if (!converged.current) {
      const sim = built.sim;
      // Accurate engine: skip the live solve — inject the OpenFOAM velocity
      // field, then let the same scalar fill carry temperature/smell along it.
      if (useOpenFoam && accurate?.field) {
        applyFieldToSim(built, accurate.field);
        { const gf = geodesicFields(built);
          fieldsRef.current = { temp: gf.temp, smell: gf.smell, noise: computeNoiseField(plan, built) };
          setRoomTemps(roomMeans(built, gf.temp)); }
        converged.current = true;
        buildPaths();
        setReady(true);
        setSimReady(true);
        return;
      }
      for (let b = 0; b < BATCH; b++) sim.step(0.05);
      steps.current += BATCH;
      if (steps.current >= TARGET_STEPS) {
        // temperature & air quality: per-grid geodesic fields (fill the whole
        // connected house from the sources; walls / shut doors block)
        const gf = geodesicFields(built);
        fieldsRef.current = {
          temp: gf.temp,
          smell: gf.smell,
          noise: computeNoiseField(plan, built),
        };
        setRoomTemps(roomMeans(built, gf.temp));
        converged.current = true;
        buildPaths();
        setReady(true);
        setSimReady(true);
      }
      return;
    }
    // airflow: keep drifting dots through the (frozen) steady flow
    const headPts = headRef.current;
    const showAir = mode === "airflow" && airflowStyle === "dots";
    if (headPts) headPts.visible = showAir;
    if (!showAir || !headPts) return;
    const { sim, nx, ny, nz, dx, origin, worldToCell, inside } = built;
    const dt = Math.min(delta, 0.05);
    const roofY = plan.wallHeight;
    const ox = origin[0], oy = origin[1], oz = origin[2];
    const ex = ox + nx * dx, ey = Math.min(oy + ny * dx, roofY), ez = oz + nz * dx;
    for (let p = 0; p < NUM_PARTICLES; p++) {
      let x = head[p * 3], y = head[p * 3 + 1], z = head[p * 3 + 2];
      const [i, j, k] = worldToCell(x, y, z);
      const [u, v, w] = sim.velocityAt(i, j, k);
      const sp = Math.hypot(u, v, w);
      // slow air still drifts: boost sub-0.06 m/s velocities up to a visible
      // floor (direction unchanged) so motion reads across the whole house
      const boost = sp > 1e-4 ? Math.min(Math.max(1, 0.06 / sp), 12) : 0;
      const ue = u * boost, ve = v * boost, we = w * boost;
      ageA[p] += sp < 0.01 ? dt * 2.2 : dt; // stagnant particles recycle sooner
      const tx = x + ue * dt * 1.8, ty = y + ve * dt * 1.8, tz = z + we * dt * 1.8;
      const out = tx < ox || tx > ex || ty < oy || ty > ey || tz < oz || tz > ez;
      if (!out) {
        // March in sub-steps no longer than half a cell. A boosted dot can move
        // several cells per frame, and testing only the destination let it jump
        // clean over a wall (0.1 m thick, cells are 0.24 m) and reappear in the
        // next room. Walls have to be able to stop it mid-flight.
        const dist = Math.hypot(tx - x, ty - y, tz - z);
        const sub = Math.max(1, Math.min(8, Math.ceil(dist / (dx * 0.5))));
        let px = x, py = y, pz = z, blocked = false, escaped = false;
        for (let s = 1; s <= sub; s++) {
          const f = s / sub;
          const qx = x + (tx - x) * f, qy = y + (ty - y) * f, qz = z + (tz - z) * f;
          const [ci, cj, ck] = worldToCell(qx, qy, qz);
          const cc = sim.cIdx(ci, cj, ck);
          if (sim.solid[cc]) { blocked = true; break; }
          // recycle at an opening OR the moment the air leaves the house — the
          // dot has done its job once it exits, and we don't draw the outdoors
          if (sim.open[cc] || !inside[cc]) { escaped = true; break; }
          px = qx; py = qy; pz = qz;
        }
        if (escaped) { spawn(p); x = head[p * 3]; y = head[p * 3 + 1]; z = head[p * 3 + 2]; }
        else if (blocked) { ageA[p] += dt * 3; x = px; y = py; z = pz; } // pinned on a wall — retire it sooner
        else { x = px; y = py; z = pz; }
      } else { spawn(p); x = head[p * 3]; y = head[p * 3 + 1]; z = head[p * 3 + 2]; }
      if (ageA[p] > maxAgeA[p]) { spawn(p); x = head[p * 3]; y = head[p * 3 + 1]; z = head[p * 3 + 2]; }
      head[p * 3] = x; head[p * 3 + 1] = y; head[p * 3 + 2] = z;
      // the same single blue as the streamlines, so the two airflow views agree
      headCol[p * 3] = DOT_RGB[0]; headCol[p * 3 + 1] = DOT_RGB[1]; headCol[p * 3 + 2] = DOT_RGB[2];
    }
    (headPts.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (headPts.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  });

  const showStreamlines = mode === "airflow" && airflowStyle === "lines" && paths != null && paths.points.length > 0;

  return (
    <group>
      {showStreamlines && (
        <group>
          {/* soft glow, then a continuous core, so the path reads on any backdrop */}
          <Line points={paths!.points} segments color={STREAMLINE_BLUE} lineWidth={5} transparent opacity={0.15} depthWrite={false} renderOrder={FLOW_RENDER_ORDER} />
          <Line points={paths!.points} segments color={STREAMLINE_BLUE} lineWidth={1.5} transparent opacity={0.3} depthWrite={false} renderOrder={FLOW_RENDER_ORDER} />
          {/* animated dashes travelling downstream = the air actually moving.
              Short dashes with a wide gap read as distinct packets of air being
              carried along, rather than a dotted line that happens to shimmer. */}
          <Line
            ref={dashRef}
            points={paths!.points}
            segments
            color={STREAMLINE_BLUE}
            lineWidth={2.8}
            transparent
            opacity={0.98}
            depthWrite={false}
            renderOrder={FLOW_RENDER_ORDER}
            dashed
            dashSize={0.16}
            gapSize={0.3}
          />
        </group>
      )}
      <points ref={hazeRef} frustumCulled={false} visible={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[hazePos, 3]} usage={THREE.DynamicDrawUsage} />
          <bufferAttribute attach="attributes-color" args={[hazeCol, 3]} usage={THREE.DynamicDrawUsage} />
        </bufferGeometry>
        <pointsMaterial map={soft} vertexColors transparent depthWrite={false} sizeAttenuation size={built.dx * 4.2} opacity={0.62} />
      </points>

      <points ref={headRef} frustumCulled={false} visible={false} renderOrder={FLOW_RENDER_ORDER}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[head, 3]} usage={THREE.DynamicDrawUsage} />
          <bufferAttribute attach="attributes-color" args={[headCol, 3]} usage={THREE.DynamicDrawUsage} />
        </bufferGeometry>
        <pointsMaterial map={soft} vertexColors transparent depthWrite={false} sizeAttenuation size={built.dx * 1.6} opacity={0.9} />
      </points>
    </group>
  );
}
