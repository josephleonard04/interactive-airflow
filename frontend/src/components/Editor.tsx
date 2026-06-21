import { useEffect, useRef, useState } from "react";
import { Canvas, useThree, type ThreeEvent } from "@react-three/fiber";
import { Grid, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { useSceneStore } from "../scene/store";
import type { Vec2, Vec3 } from "../floorplan/types";
import { FloorPlanView } from "./FloorPlanView";
import { ItemMesh } from "./ItemMesh";

// Drag-to-move: while an item is being dragged we raycast the pointer onto a
// horizontal plane at the item's height and follow it. Camera orbit is disabled
// during a drag so the two don't fight.
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

    const worldY = item.position[1];
    const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -worldY);
    const ray = new THREE.Raycaster();
    const b = plan.bounds;

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
      if (!ray.ray.intersectPlane(dragPlane, pt)) return;
      const px = Math.min(b.x + b.w, Math.max(b.x, pt.x - offset[0]));
      const pz = Math.min(b.z + b.d, Math.max(b.z, pt.z - offset[2]));
      setPosition(draggingId, [px, worldY, pz]);
    };
    const onUp = () => setDragging(null);

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [draggingId, camera, gl, offset, plan.items, plan.bounds, setPosition, setDragging]);

  return null;
}

// Invisible ground plane: used to add wall points in draw-wall mode, and to
// clear the selection when clicking empty floor in select mode.
function GroundPlane({ offset }: { offset: Vec3 }) {
  const mode = useSceneStore((s) => s.mode);
  const addWall = useSceneStore((s) => s.addWall);
  const clearSelection = useSceneStore((s) => s.clearSelection);
  const [pending, setPending] = useState<Vec2 | null>(null);

  const snap = (v: number) => Math.round(v / 0.1) * 0.1;

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
    <Canvas shadows camera={{ position: [span * 0.7, span * 0.95, span * 0.95], fov: 45 }}>
      <color attach="background" args={["#0f1419"]} />
      <ambientLight intensity={0.78} />
      <directionalLight position={[span, span * 1.5, span]} intensity={1.1} castShadow />
      <hemisphereLight intensity={0.3} />

      <Grid
        args={[60, 60]}
        cellColor="#2a3340"
        sectionColor="#3a4a5a"
        infiniteGrid
        fadeDistance={Math.max(40, span * 4)}
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
        target={[0, wallHeight / 3, 0]}
        enabled={!draggingId && mode === "select"}
      />
    </Canvas>
  );
}
