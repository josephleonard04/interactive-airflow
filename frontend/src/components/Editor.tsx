import { useEffect, useRef, useState } from "react";
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
        let along = lw.axis === "x" ? pt.x - offset[0] : pt.z - offset[2];
        along = Math.min(lw.hi - halfW, Math.max(lw.lo + halfW, along));
        const y = Math.min(plan.wallHeight - halfH, Math.max(halfH, pt.y));
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
        const hit = plan.items.some((o) => {
          if (o.id === draggingId || o.mount !== "floor") return false;
          const [ohx, ohz] = footHalf(o.size, o.rotationY);
          return Math.abs(gx - o.position[0]) < fhx + ohx - 0.02 && Math.abs(gz - o.position[2]) < fhz + ohz - 0.02;
        });
        if (hit) {
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

// Invisible ground plane: used to add wall points in draw-wall mode, and to
// clear the selection when clicking empty floor in select mode.
function GroundPlane({ offset }: { offset: Vec3 }) {
  const mode = useSceneStore((s) => s.mode);
  const addWall = useSceneStore((s) => s.addWall);
  const clearSelection = useSceneStore((s) => s.clearSelection);
  const [pending, setPending] = useState<Vec2 | null>(null);

  const snap = (v: number) => Math.round(v / GRID) * GRID;

  const onDown = (e: ThreeEvent<PointerEvent>) => {
    const px = snap(e.point.x - offset[0]);
    const pz = snap(e.point.z - offset[2]);
    if (mode === "draw-wall") {
      e.stopPropagation();
      if (!pending) setPending([px, pz]);
      else {
        addWall(pending, [px, pz]);
        setPending(null);
      }
    } else {
      clearSelection();
    }
  };

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} onPointerDown={onDown} visible={false}>
      <planeGeometry args={[200, 200]} />
    </mesh>
  );
}

export function Editor() {
  const plan = useSceneStore((s) => s.plan);
  const mode = useSceneStore((s) => s.mode);
  const draggingId = useSceneStore((s) => s.draggingId);
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

      <Grid
        args={[80, 80]}
        cellSize={GRID}
        cellColor="#8aa0ad"
        sectionColor="#6b8392"
        sectionSize={GRID * 4}
        infiniteGrid
        fadeStrength={2}
        fadeDistance={Math.max(45, span * 5)}
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

      <GroundPlane offset={offset} />

      <group position={offset}>
        <FloorPlanView plan={plan} />
        {plan.items.map((it) => (
          <ItemMesh key={it.id} item={it} />
        ))}
      </group>

      <DragController offset={offset} />

      <OrbitControls
        ref={orbitRef}
        makeDefault
        enableDamping
        minPolarAngle={0.1}
        maxPolarAngle={Math.PI / 2 - 0.04}
        target={[0, wallHeight / 3, 0]}
        enabled={!draggingId && mode === "select"}
      />
    </Canvas>
  );
}
