import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useThree, type ThreeEvent } from "@react-three/fiber";
import { ContactShadows, Grid, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { GRID, WALL_THICKNESS } from "../floorplan/geometry";
import { useSceneStore } from "../scene/store";
import type { Vec2, Vec3, WallSeg } from "../floorplan/types";
import { FloorPlanView } from "./FloorPlanView";
import { ItemMesh } from "./ItemMesh";

interface WallHit {
  x: number;
  z: number;
  rot: number;
  axis: "x" | "z";
  line: number;
  lo: number;
  hi: number;
  sign: number;
}

// Find the nearest wall to a point, returning the flush position + facing.
function nearestWall(px: number, pz: number, walls: WallSeg[], depth: number, halfWidth: number): WallHit | null {
  let best: { w: WallSeg; line: number; lo: number; hi: number } | null = null;
  let bestD = Infinity;
  for (const w of walls) {
    if (w.axis === "x") {
      const line = w.a[1];
      const lo = Math.min(w.a[0], w.b[0]);
      const hi = Math.max(w.a[0], w.b[0]);
      const dd = Math.hypot(px - Math.min(hi, Math.max(lo, px)), pz - line);
      if (dd < bestD) ((bestD = dd), (best = { w, line, lo, hi }));
    } else {
      const line = w.a[0];
      const lo = Math.min(w.a[1], w.b[1]);
      const hi = Math.max(w.a[1], w.b[1]);
      const dd = Math.hypot(px - line, pz - Math.min(hi, Math.max(lo, pz)));
      if (dd < bestD) ((bestD = dd), (best = { w, line, lo, hi }));
    }
  }
  if (!best) return null;
  const off = WALL_THICKNESS / 2 + depth / 2;
  if (best.w.axis === "x") {
    const foot = Math.min(best.hi - halfWidth, Math.max(best.lo + halfWidth, px));
    const sign = pz >= best.line ? 1 : -1;
    return { x: foot, z: best.line + sign * off, rot: sign > 0 ? 0 : Math.PI, axis: "x", line: best.line, lo: best.lo, hi: best.hi, sign };
  }
  const foot = Math.min(best.hi - halfWidth, Math.max(best.lo + halfWidth, pz));
  const sign = px >= best.line ? 1 : -1;
  return { x: best.line + sign * off, z: foot, rot: sign > 0 ? Math.PI / 2 : -Math.PI / 2, axis: "z", line: best.line, lo: best.lo, hi: best.hi, sign };
}

// Rotation-aware footprint half-extents (a 90°/270° rotation swaps w/d).
function footHalf(size: Vec3, rotationY: number): [number, number] {
  const swapped = Math.abs(Math.round(rotationY / (Math.PI / 2))) % 2 === 1;
  return swapped ? [size[2] / 2, size[0] / 2] : [size[0] / 2, size[2] / 2];
}

// Would an item footprint centred at (gx,gz) overlap ANY wall (including walls
// the user drew)? Used to stop furniture straddling a wall.
function wallBlocked(gx: number, gz: number, fhx: number, fhz: number, walls: WallSeg[]): boolean {
  const ix0 = gx - fhx, ix1 = gx + fhx, iz0 = gz - fhz, iz1 = gz + fhz;
  const eps = 0.02;
  for (const w of walls) {
    const line = w.axis === "z" ? w.a[0] : w.a[1];
    const lo = w.axis === "z" ? Math.min(w.a[1], w.b[1]) : Math.min(w.a[0], w.b[0]);
    const hi = w.axis === "z" ? Math.max(w.a[1], w.b[1]) : Math.max(w.a[0], w.b[0]);
    const t = w.thickness / 2;
    const wx0 = w.axis === "z" ? line - t : lo;
    const wx1 = w.axis === "z" ? line + t : hi;
    const wz0 = w.axis === "z" ? lo : line - t;
    const wz1 = w.axis === "z" ? hi : line + t;
    if (ix1 > wx0 + eps && ix0 < wx1 - eps && iz1 > wz0 + eps && iz0 < wz1 - eps) return true;
  }
  return false;
}

// Drag-to-move with physical constraints:
//  - floor items snap to the grid, stay inside ONE room (no straddling walls),
//    and can't overlap other floor items;
//  - wall items (TV/AC) slide along their wall AND move up/down on it;
//  - camera orbit is disabled during a drag.
function DragController({ offset }: { offset: Vec3 }) {
  const { camera, gl } = useThree();
  const plan = useSceneStore((s) => s.plan);
  const draggingId = useSceneStore((s) => s.draggingId);
  const setPosition = useSceneStore((s) => s.setPosition);
  const setDragging = useSceneStore((s) => s.setDragging);

  useEffect(() => {
    if (!draggingId) return;
    const item = plan.items.find((i) => i.id === draggingId);
    if (!item) return;

    const ray = new THREE.Raycaster();
    const worldY0 = item.position[1];
    const depth = item.size[2];
    const halfW = item.size[0] / 2;
    const halfH = item.size[1] / 2;
    const off = WALL_THICKNESS / 2 + depth / 2;
    const [fhx, fhz] = footHalf(item.size, item.rotationY);
    const lockedWall = item.mount === "wall" ? nearestWall(item.position[0], item.position[2], plan.walls, depth, halfW) : null;
    let lastValid: Vec3 = [item.position[0], item.position[1], item.position[2]];

    const ndc = (e: PointerEvent) => {
      const rect = gl.domElement.getBoundingClientRect();
      return new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
    };
    const snapG = (v: number) => Math.round(v / GRID) * GRID;

    const onMove = (e: PointerEvent) => {
      ray.setFromCamera(ndc(e), camera);
      const pt = new THREE.Vector3();

      // wall items: slide along the wall + move vertically on its plane
      if (lockedWall) {
        const lw = lockedWall;
        const plane =
          lw.axis === "x"
            ? new THREE.Plane(new THREE.Vector3(0, 0, 1), -(lw.line + offset[2]))
            : new THREE.Plane(new THREE.Vector3(1, 0, 0), -(lw.line + offset[0]));
        if (!ray.ray.intersectPlane(plane, pt)) return;
        // snap both the slide-along-wall and the up/down height to the grid
        let along = snapG(lw.axis === "x" ? pt.x - offset[0] : pt.z - offset[2]);
        along = Math.min(lw.hi - halfW, Math.max(lw.lo + halfW, along));
        const y = Math.min(plan.wallHeight - halfH, Math.max(halfH, snapG(pt.y)));
        const pos: Vec3 = lw.axis === "x" ? [along, y, lw.line + lw.sign * off] : [lw.line + lw.sign * off, y, along];
        setPosition(draggingId, pos, lw.rot);
        return;
      }

      // floor / ceiling items: horizontal plane → grid → confine to a room → no overlap
      const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -worldY0);
      if (!ray.ray.intersectPlane(dragPlane, pt)) return;
      let gx = snapG(pt.x - offset[0]);
      let gz = snapG(pt.z - offset[2]);

      let room = plan.rooms.find(
        (r) => gx > r.rect.x && gx < r.rect.x + r.rect.w && gz > r.rect.z && gz < r.rect.z + r.rect.d,
      );
      if (!room) {
        let bd = Infinity;
        for (const r of plan.rooms) {
          const dc = Math.hypot(gx - (r.rect.x + r.rect.w / 2), gz - (r.rect.z + r.rect.d / 2));
          if (dc < bd) ((bd = dc), (room = r));
        }
      }
      if (!room) return;
      const m = WALL_THICKNESS / 2 + 0.03;
      const xlo = room.rect.x + m + fhx;
      const xhi = room.rect.x + room.rect.w - m - fhx;
      const zlo = room.rect.z + m + fhz;
      const zhi = room.rect.z + room.rect.d - m - fhz;
      gx = xlo <= xhi ? Math.min(xhi, Math.max(xlo, gx)) : room.rect.x + room.rect.w / 2;
      gz = zlo <= zhi ? Math.min(zhi, Math.max(zlo, gz)) : room.rect.z + room.rect.d / 2;

      if (item.mount === "floor") {
        const hitItem = plan.items.some((o) => {
          if (o.id === draggingId || o.mount !== "floor") return false;
          const [ohx, ohz] = footHalf(o.size, o.rotationY);
          return Math.abs(gx - o.position[0]) < fhx + ohx - 0.02 && Math.abs(gz - o.position[2]) < fhz + ohz - 0.02;
        });
        // also reject straddling any wall (including user-drawn walls)
        if (hitItem || wallBlocked(gx, gz, fhx, fhz, plan.walls)) {
          setPosition(draggingId, lastValid);
          return;
        }
      }
      lastValid = [gx, worldY0, gz];
      setPosition(draggingId, lastValid);
    };
    const onUp = () => setDragging(null);

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [draggingId, camera, gl, offset, plan, setPosition, setDragging]);

  return null;
}

// Drag a selected door/window along its wall (it stays on the same wall line).
function OpeningDragController({ offset }: { offset: Vec3 }) {
  const { camera, gl } = useThree();
  const plan = useSceneStore((s) => s.plan);
  const draggingOpeningId = useSceneStore((s) => s.draggingOpeningId);
  const moveOpeningAlong = useSceneStore((s) => s.moveOpeningAlong);
  const setDraggingOpening = useSceneStore((s) => s.setDraggingOpening);

  useEffect(() => {
    if (!draggingOpeningId) return;
    const o = [...plan.doors, ...plan.windows].find((x) => x.id === draggingOpeningId);
    if (!o) return;
    const vertical = Math.abs(o.a[0] - o.b[0]) < 1e-3; // wall runs along z
    const ray = new THREE.Raycaster();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const snapG = (v: number) => Math.round(v / GRID) * GRID;
    const ndc = (e: PointerEvent) => {
      const rect = gl.domElement.getBoundingClientRect();
      return new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
    };
    const onMove = (e: PointerEvent) => {
      ray.setFromCamera(ndc(e), camera);
      const pt = new THREE.Vector3();
      if (!ray.ray.intersectPlane(plane, pt)) return;
      const along = vertical ? snapG(pt.z - offset[2]) : snapG(pt.x - offset[0]);
      moveOpeningAlong(draggingOpeningId, along);
    };
    const onUp = () => setDraggingOpening(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [draggingOpeningId, camera, gl, offset, plan, moveOpeningAlong, setDraggingOpening]);

  return null;
}

const FLOOR_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

// Floor interaction layer (rendered inside the centred group, so its dots line
// up with the building). In select mode, clicking empty floor clears the
// selection. In add-wall mode, it shows the placement GRID as dots, marks the
// chosen start point, previews the wall to the cursor, and builds it on the
// second click. Uses the pointer ray (not the hit object) so clicks read the
// floor even when the cursor is over furniture.
function FloorInteractor({ offset }: { offset: Vec3 }) {
  const mode = useSceneStore((s) => s.mode);
  const addWall = useSceneStore((s) => s.addWall);
  const clearSelection = useSceneStore((s) => s.clearSelection);
  const bounds = useSceneStore((s) => s.plan.bounds);
  const wallHeight = useSceneStore((s) => s.plan.wallHeight);
  const [start, setStart] = useState<Vec2 | null>(null);
  const [hover, setHover] = useState<Vec2 | null>(null);

  const snap = (v: number) => Math.round(v / GRID) * GRID;
  const floorPoint = (e: ThreeEvent<PointerEvent>): Vec2 | null => {
    const pt = new THREE.Vector3();
    if (!e.ray.intersectPlane(FLOOR_PLANE, pt)) return null;
    return [snap(pt.x - offset[0]), snap(pt.z - offset[2])];
  };

  // grid dots span exactly the home footprint (no overflow)
  const dots = useMemo(() => {
    const arr: number[] = [];
    for (let x = bounds.x; x <= bounds.x + bounds.w + 1e-6; x += GRID)
      for (let z = bounds.z; z <= bounds.z + bounds.d + 1e-6; z += GRID) arr.push(x, 0.03, z);
    return new Float32Array(arr);
  }, [bounds]);

  const onDown = (e: ThreeEvent<PointerEvent>) => {
    if (mode !== "draw-wall") {
      clearSelection();
      return;
    }
    e.stopPropagation();
    const p = floorPoint(e);
    if (!p) return;
    if (!start) setStart(p);
    else {
      if (p[0] !== start[0] || p[1] !== start[1]) addWall(start, p);
      setStart(null);
    }
  };
  const onMove = (e: ThreeEvent<PointerEvent>) => {
    if (mode !== "draw-wall") return;
    const p = floorPoint(e);
    if (p) setHover(p);
  };

  // axis-aligned preview from start → hover (matches addWall's snapping)
  let preview: { pos: Vec3; size: Vec3 } | null = null;
  if (start && hover) {
    const dx = Math.abs(hover[0] - start[0]);
    const dz = Math.abs(hover[1] - start[1]);
    if (dx >= dz) {
      const x0 = Math.min(start[0], hover[0]);
      const x1 = Math.max(start[0], hover[0]);
      preview = { pos: [(x0 + x1) / 2, wallHeight / 2, start[1]], size: [Math.max(x1 - x0, 0.05), wallHeight, WALL_THICKNESS] };
    } else {
      const z0 = Math.min(start[1], hover[1]);
      const z1 = Math.max(start[1], hover[1]);
      preview = { pos: [start[0], wallHeight / 2, (z0 + z1) / 2], size: [WALL_THICKNESS, wallHeight, Math.max(z1 - z0, 0.05)] };
    }
  }

  return (
    <group>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[bounds.x + bounds.w / 2, 0.015, bounds.z + bounds.d / 2]}
        onPointerDown={onDown}
        onPointerMove={onMove}
      >
        <planeGeometry args={[400, 400]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      {mode === "draw-wall" && (
        <group>
          <points>
            <bufferGeometry>
              <bufferAttribute attach="attributes-position" args={[dots, 3]} />
            </bufferGeometry>
            <pointsMaterial size={0.1} color="#0b3a44" sizeAttenuation />
          </points>
          {hover && (
            <mesh position={[hover[0], 0.05, hover[1]]}>
              <sphereGeometry args={[0.09, 14, 14]} />
              <meshBasicMaterial color="#0e7c8c" />
            </mesh>
          )}
          {start && (
            <mesh position={[start[0], 0.06, start[1]]}>
              <sphereGeometry args={[0.13, 14, 14]} />
              <meshBasicMaterial color="#22d3ee" />
            </mesh>
          )}
          {preview && (
            <mesh position={preview.pos}>
              <boxGeometry args={preview.size} />
              <meshStandardMaterial color="#22d3ee" transparent opacity={0.35} />
            </mesh>
          )}
        </group>
      )}
    </group>
  );
}

export function Editor() {
  const plan = useSceneStore((s) => s.plan);
  const mode = useSceneStore((s) => s.mode);
  const draggingId = useSceneStore((s) => s.draggingId);
  const draggingOpeningId = useSceneStore((s) => s.draggingOpeningId);
  const selectedId = useSceneStore((s) => s.selectedId);
  const clearSelection = useSceneStore((s) => s.clearSelection);
  const removeSelected = useSceneStore((s) => s.removeSelected);
  const rotateItem = useSceneStore((s) => s.rotateItem);
  const setMode = useSceneStore((s) => s.setMode);
  const undo = useSceneStore((s) => s.undo);
  const redo = useSceneStore((s) => s.redo);

  const { bounds, wallHeight } = plan;
  const offset: Vec3 = [-(bounds.x + bounds.w / 2), 0, -(bounds.z + bounds.d / 2)];
  const span = Math.max(bounds.w, bounds.d);
  const orbitRef = useRef<any>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      const meta = e.ctrlKey || e.metaKey;
      if (meta && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (meta && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        redo();
        return;
      }
      if (typing) return;
      if (e.key === "Escape") {
        clearSelection();
        setMode("select");
      } else if (e.key === "Delete" || e.key === "Backspace") {
        removeSelected();
      } else if ((e.key === "r" || e.key === "R") && selectedId) {
        rotateItem(selectedId, Math.PI / 2);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clearSelection, removeSelected, rotateItem, selectedId, setMode, undo, redo]);

  // Ensure the canvas measures its container once mounted (covers cases where
  // the resize observer doesn't fire on the mount tick).
  useEffect(() => {
    const id = requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <Canvas
      dpr={[1, 2]}
      gl={{ alpha: true, antialias: true }}
      camera={{ position: [span * 0.85, span * 0.78, span * 1.05], fov: 40 }}
    >
      {/* soft studio lighting */}
      <ambientLight intensity={0.7} />
      <hemisphereLight args={["#ffffff", "#8a8475", 0.6]} />
      <directionalLight position={[span, span * 1.7, span * 0.6]} intensity={1.35} />
      <directionalLight position={[-span * 0.8, span, -span * 0.5]} intensity={0.4} />

      {/* floor grid sized exactly to the home footprint */}
      <Grid
        position={[0, 0.005, 0]}
        args={[bounds.w, bounds.d]}
        cellSize={GRID}
        cellColor="#8aa0ad"
        sectionColor="#6b8392"
        sectionSize={GRID * 4}
      />

      {/* soft contact shadow grounds the whole home */}
      <ContactShadows
        position={[0, 0.015, 0]}
        scale={span * 1.8}
        far={span * 1.4}
        blur={2.4}
        opacity={0.45}
        color="#060a0e"
        resolution={1024}
      />

      <group position={offset}>
        <FloorInteractor offset={offset} />
        <FloorPlanView plan={plan} />
        {plan.items.map((it) => (
          <ItemMesh key={it.id} item={it} />
        ))}
      </group>

      <DragController offset={offset} />
      <OpeningDragController offset={offset} />

      <OrbitControls
        ref={orbitRef}
        makeDefault
        enableDamping
        minPolarAngle={0.1}
        maxPolarAngle={Math.PI / 2 - 0.04}
        target={[0, wallHeight / 3, 0]}
        enabled={!draggingId && !draggingOpeningId && mode === "select"}
      />
    </Canvas>
  );
}
