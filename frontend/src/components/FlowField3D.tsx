import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Line } from "@react-three/drei";
import * as THREE from "three";
import { buildSim3D, geodesicFields, roomMeans } from "../sim/sim3d";
import { flowColor, tempColor } from "../viz/temperature";
import { SMELL_FULL_SCALE, contaminantColor } from "../viz/smell";
import { computeNoiseField } from "../sim/noise";
import { useSceneStore } from "../scene/store";
import { applyFieldToSim } from "../engine/accurate";
import { STREAMLINE_BLUE, buildStreamlinePaths, type StreamlinePaths } from "../viz/streamlines";
import { SCENARIOS, VIZ_DEFAULT } from "../floorplan/scenarios";
import { FLOW_RENDER_ORDER } from "../viz/layers";
import { openingBox } from "../bc/lfm";
import { WALL_THICKNESS } from "../floorplan/geometry";

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

// HOW MUCH SOLVING ONE FRAME MAY DO, in milliseconds.
//
// This was a fixed batch of 6 steps. On the apartment's 30x14x35 grid a single
// step measures ~43 ms, so a "batch" was ~260 ms of blocking work inside one
// animation frame — about four frames per second, for the seven seconds a solve
// takes. Editing anything while the simulation ran restarted that solve, which
// is what made dragging a fan feel like the app had hung.
//
// A budget instead of a count: keep stepping while there is time left in the
// frame, and always do at least one step so a machine slower than the budget
// still converges rather than stalling. The solve takes the same number of
// steps; it just stops monopolising the frame it started in.
const STEP_BUDGET_MS = 10;

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
  // Which contaminant this task is about, so the floor is drawn on the ramp
  // that matches the word in the tab. The same field carries kitchen odour in
  // one task and bathroom moisture in another, and painting mould magenta
  // invites the participant to reason about a smell.
  const contaminantKind = useSceneStore((s) => (s.scenarioId === "humidity" ? "humidity" : "smell")) as
    | "humidity"
    | "smell";
  const setRoomTemps = useSceneStore((s) => s.setRoomTemps);
  // A drag publishes a new plan on every pointer move. Rebuilding and
  // re-solving on each of those is hopeless — the solve never gets near
  // convergence, and the frames it does run are the slow ones — so the solver
  // holds the plan as it stood when the drag began and picks the new one up on
  // release. What is on screen during the drag is the last settled field, which
  // is stale for as long as the mouse is down and correct again a moment later.
  const draggingId = useSceneStore((s) => s.draggingId);
  const draggingOpeningId = useSceneStore((s) => s.draggingOpeningId);
  const dragging = draggingId !== null || draggingOpeningId !== null;

  const [simPlan, setSimPlan] = useState(plan);
  useEffect(() => {
    if (dragging || simPlan === plan) return;
    setSimPlan(plan);
  }, [plan, dragging, simPlan]);

  const built = useMemo(() => buildSim3D(simPlan), [simPlan]);
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
  /** Cold end, mean and warm end of the current solution, computed once when the
   *  fields land rather than per frame — the dot loop needs it 850 times a frame. */
  const rangeRef = useRef<[number, number, number] | null>(null);
  const [ready, setReady] = useState(false);
  const [paths, setPaths] = useState<StreamlinePaths | null>(null);
  const dashRef = useRef<React.ComponentRef<typeof Line> | null>(null);

  useEffect(() => {
    const room = simPlan.rooms.find((r) => r.id === sourceRoomId) ?? null;
    built.setSource(room ? room.rect : null);
    steps.current = 0;
    converged.current = false;
    setReady(false);
    setPaths(null);
    setSimReady(false);
  }, [built, sourceRoomId, simPlan.rooms, setSimReady, engine, accurate]);

  // Points in every OPEN doorway and window, at a couple of heights. These are
  // the routes air uses to move between rooms, so seeding them guarantees the
  // whole-house paths are drawn instead of only whatever each room happens to be
  // doing on its own.
  const gateways = useMemo(() => {
    const g: Array<[number, number, number]> = [];
    for (const o of [...simPlan.doors, ...simPlan.windows]) {
      if (!o.open) continue;
      const cx = (o.a[0] + o.b[0]) / 2;
      const cz = (o.a[1] + o.b[1]) / 2;
      const lo = o.sill + o.height * 0.35;
      const hi = o.sill + o.height * 0.7;
      g.push([cx, lo, cz], [cx, hi, cz]);
    }
    return g;
  }, [simPlan.doors, simPlan.windows]);

  // World-space boxes of everything standing in the rooms (rotation-aware
  // footprint). The streamline pass clips against these so no line ever draws
  // through a couch or desk — the sim's voxel solids are too coarse to trust
  // for that visually.
  const obstacles = useMemo(
    () =>
      simPlan.items
        .filter((it) => it.category === "furniture" || it.mount === "floor")
        .map((it) => {
          const [cx, cy, cz] = it.position;
          const [sw, sh, sd] = it.size;
          const swapped = Math.abs(Math.round(it.rotationY / (Math.PI / 2))) % 2 === 1;
          const hx = (swapped ? sd : sw) / 2;
          const hz = (swapped ? sw : sd) / 2;
          return {
            min: [cx - hx, cy - sh / 2, cz - hz] as [number, number, number],
            max: [cx + hx, cy + sh / 2, cz + hz] as [number, number, number],
          };
        }),
    [simPlan.items],
  );

  // Line density is a per-task setting (see Scenario.viz) — outside a task, and
  // for tasks that don't override it, VIZ_DEFAULT applies.
  const scenarioId = useSceneStore((s) => s.scenarioId);
  const vizMaxSeeds =
    (scenarioId ? SCENARIOS[scenarioId].viz?.maxSeeds : undefined) ?? VIZ_DEFAULT.maxSeeds;

  // Real wall slabs + the holes that open doors/windows punch through them.
  const { wallBoxes, gapBoxes } = useMemo(() => {
    const pad = 0.02;
    const wb = simPlan.walls.map((w) => {
      const x0 = Math.min(w.a[0], w.b[0]);
      const x1 = Math.max(w.a[0], w.b[0]);
      const z0 = Math.min(w.a[1], w.b[1]);
      const z1 = Math.max(w.a[1], w.b[1]);
      const h = w.thickness / 2 + pad;
      // A wall is a line in plan; give it its real thickness on the thin axis.
      return {
        min: [x0 - (x1 - x0 < 1e-6 ? h : pad), 0, z0 - (z1 - z0 < 1e-6 ? h : pad)] as [number, number, number],
        max: [x1 + (x1 - x0 < 1e-6 ? h : pad), w.height, z1 + (z1 - z0 < 1e-6 ? h : pad)] as [number, number, number],
      };
    });
    const gb = [...simPlan.doors, ...simPlan.windows]
      .filter((o) => o.open)
      .map((o) => {
        const b = openingBox(o, WALL_THICKNESS);
        // Slightly wider than the hole so a line threading it isn't clipped by
        // the wall box it necessarily overlaps.
        return {
          min: [b.min[0] - 0.08, b.min[1], b.min[2] - 0.08] as [number, number, number],
          max: [b.max[0] + 0.08, b.max[1], b.max[2] + 0.08] as [number, number, number],
        };
      });
    return { wallBoxes: wb, gapBoxes: gb };
  }, [simPlan.walls, simPlan.doors, simPlan.windows]);

  // Absolute air temperature (°C) at a world point, read off the same geodesic
  // field the Temp view draws. The solver's field is a DELTA from the outdoor
  // baseline, so the baseline is added back here — the ramp is anchored on real
  // temperatures, not on whatever this run's maximum happened to be.
  const tempSampler = useCallback(
    (x: number, y: number, z: number): number | null => {
      const F = fieldsRef.current;
      if (!F) return null;
      const { sim, worldToCell } = built;
      const [i, j, k] = worldToCell(x, y, z);
      const c = sim.cIdx(i, j, k);
      if (sim.solid[c]) return null;
      return outdoorTemp + F.temp[c];
    },
    [built, outdoorTemp],
  );

  /** The coldest, average and warmest air inside the home right now — what the
   *  flow colours are scaled between, so a device's own air saturates instead of
   *  landing somewhere in the middle of an absolute comfort ramp. The MEAN is
   *  what makes the picture readable: it is the pale centre, so a line reads warm
   *  or cold relative to the air in this home rather than to an abstract scale.
   *  Interior cells only: past an open window the field is outdoor air, and
   *  letting 2 °C outdoors set the cold end would flatten every indoor
   *  difference against it. */
  const tempRangeOf = useCallback(
    (temp: Float32Array): [number, number, number] => {
      const { sim, inside } = built;
      let lo = Infinity;
      let hi = -Infinity;
      let sum = 0;
      let n = 0;
      for (let c = 0; c < temp.length; c++) {
        if (sim.solid[c] || !inside[c]) continue;
        const t = outdoorTemp + temp[c];
        if (t < lo) lo = t;
        if (t > hi) hi = t;
        sum += t;
        n++;
      }
      return n > 0 ? [lo, sum / n, hi] : [outdoorTemp, outdoorTemp, outdoorTemp];
    },
    [built, outdoorTemp],
  );

  // Build smooth streamlines from the frozen steady-state velocity field. Called
  // once the fields exist, so the colour sampler always has one to read.
  const buildPaths = useCallback(
    () =>
      setPaths(
        buildStreamlinePaths(built, {
          roofY: simPlan.wallHeight,
          maxSeeds: vizMaxSeeds,
          rooms: simPlan.rooms.map((r) => r.rect),
          gateways,
          obstacles,
          walls: wallBoxes,
          gaps: gapBoxes,
          tempAt: tempSampler,
          tempRange: rangeRef.current ?? undefined,
        }),
      ),
    [built, simPlan.wallHeight, simPlan.rooms, gateways, obstacles, vizMaxSeeds, wallBoxes, gapBoxes, tempSampler, tempRangeOf],
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
          // Contaminant. EVERY interior column is drawn, including the clean
          // ones: air that has been swept clear is the result the task is
          // after, and leaving it uncoloured meant half of what the participant
          // achieved never appeared on screen. A smell task reads mint to
          // magenta, a humidity task sand to deep blue — see viz/smell.
          const c = contaminantColor(colSum[q] / colN[q] / SMELL_FULL_SCALE, contaminantKind);
          r = c.r; g = c.g; b = c.b;
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
  }, [built, mode, hazePos, hazeCol, outdoorTemp, contaminantKind]);

  useEffect(() => { if (ready) computeHaze(); }, [ready, computeHaze]);

  useFrame((_, delta) => {
    // streamline dashes drift forward so the air visibly FLOWS along the lines
    if (dashRef.current) dashRef.current.material.dashOffset -= delta * 0.55;
    // converge to steady state once
    if (!converged.current) {
      // Not while the mouse is down. The plan under the drag is changing every
      // move, so any work done here is thrown away on the next one — and it is
      // the most expensive work in the app, which is precisely what made the
      // drag stutter. The last settled field stays on screen until release.
      if (dragging) return;
      const sim = built.sim;
      // Accurate engine: skip the live solve — inject the OpenFOAM velocity
      // field, then let the same scalar fill carry temperature/smell along it.
      if (useOpenFoam && accurate?.field) {
        applyFieldToSim(built, accurate.field);
        { const gf = geodesicFields(built);
          fieldsRef.current = { temp: gf.temp, smell: gf.smell, noise: computeNoiseField(simPlan, built) };
          rangeRef.current = tempRangeOf(gf.temp);
          setRoomTemps(roomMeans(built, gf.temp)); }
        converged.current = true;
        buildPaths();
        setReady(true);
        setSimReady(true);
        return;
      }
      // As many steps as fit in this frame's budget, and never fewer than one.
      const until = performance.now() + STEP_BUDGET_MS;
      do {
        sim.step(0.05);
        steps.current += 1;
      } while (steps.current < TARGET_STEPS && performance.now() < until);
      if (steps.current >= TARGET_STEPS) {
        // temperature & air quality: per-grid geodesic fields (fill the whole
        // connected house from the sources; walls / shut doors block)
        const gf = geodesicFields(built);
        fieldsRef.current = {
          temp: gf.temp,
          smell: gf.smell,
          noise: computeNoiseField(simPlan, built),
        };
        rangeRef.current = tempRangeOf(gf.temp);
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
    const roofY = simPlan.wallHeight;
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
      // Coloured by the warmth of the air the dot is sitting in — the same ramp
      // and the same meaning as the streamlines, so the two airflow styles agree
      // with each other and with the Temp view. Falls back to the flat blue
      // before the fields exist.
      const tc = tempSampler(x, y, z);
      const rg = rangeRef.current;
      if (tc == null) {
        headCol[p * 3] = DOT_RGB[0]; headCol[p * 3 + 1] = DOT_RGB[1]; headCol[p * 3 + 2] = DOT_RGB[2];
      } else {
        const c = rg ? flowColor(tc, rg[0], rg[1], rg[2]) : tempColor(tc);
        headCol[p * 3] = c.r; headCol[p * 3 + 1] = c.g; headCol[p * 3 + 2] = c.b;
      }
    }
    (headPts.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (headPts.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  });

  const showStreamlines = mode === "airflow" && airflowStyle === "lines" && paths != null && paths.points.length > 0;

  return (
    <group>
      {showStreamlines && (
        <group>
          <Line points={paths!.points} segments vertexColors={paths!.colors} lineWidth={5} transparent opacity={0.16} depthWrite={false} renderOrder={FLOW_RENDER_ORDER} />
          {/* faint continuous core so the path always reads */}
          <Line points={paths!.points} segments vertexColors={paths!.colors} lineWidth={1.6} transparent opacity={0.35} depthWrite={false} renderOrder={FLOW_RENDER_ORDER} />
          {/* animated dashes flowing along the line = moving air */}
          <Line
            ref={dashRef}
            points={paths!.points}
            segments
            vertexColors={paths!.colors}
            lineWidth={2.4}
            transparent
            opacity={0.95}
            depthWrite={false}
            renderOrder={FLOW_RENDER_ORDER}
            dashed
            dashSize={0.22}
            gapSize={0.16}
          />
        </group>
      )}
      <points ref={hazeRef} frustumCulled={false} visible={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[hazePos, 3]} usage={THREE.DynamicDrawUsage} />
          <bufferAttribute attach="attributes-color" args={[hazeCol, 3]} usage={THREE.DynamicDrawUsage} />
        </bufferGeometry>
        {/* Was 0.62, which laid the temperature over the floor as a wash — the
            difference between a 17 °C bedroom and a 23 °C living room survived
            the ramp and then got diluted by the beige floor underneath it. */}
        <pointsMaterial map={soft} vertexColors transparent depthWrite={false} sizeAttenuation size={built.dx * 4.2} opacity={0.82} />
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
