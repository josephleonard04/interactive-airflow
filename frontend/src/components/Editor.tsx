import { useEffect, useRef } from "react";
import { Canvas } from "@react-three/fiber";
import { Grid, OrbitControls, TransformControls } from "@react-three/drei";
import { useSceneStore } from "../scene/store";
import type { Vec3 } from "../floorplan/types";
import { FloorPlanView } from "./FloorPlanView";
import { ItemMesh } from "./ItemMesh";

// The 3D viewport. The plan is authored in the positive quadrant, so we wrap
// everything in a group translated to centre the building at the origin — the
// selected item's local position then equals its plan coordinate, which is what
// the gizmo edits and what we commit back to the store.

function SelectedTransform({ offset }: { offset: Vec3 }) {
  const transformRef = useRef<any>(null);
  const selectedId = useSceneStore((s) => s.selectedId);
  const items = useSceneStore((s) => s.plan.items);
  const setPosition = useSceneStore((s) => s.setPosition);
  const selected = items.find((it) => it.id === selectedId) ?? null;

  if (!selected) return null;

  return (
    <group position={offset}>
      <TransformControls
        ref={transformRef}
        mode="translate"
        onMouseUp={() => {
          const obj = transformRef.current?.object;
          if (obj) setPosition(selected.id, [obj.position.x, obj.position.y, obj.position.z] as Vec3);
        }}
      >
        <ItemMesh item={selected} />
      </TransformControls>
    </group>
  );
}

export function Editor() {
  const plan = useSceneStore((s) => s.plan);
  const selectedId = useSceneStore((s) => s.selectedId);
  const select = useSceneStore((s) => s.select);

  const { bounds, wallHeight } = plan;
  const offset: Vec3 = [-(bounds.x + bounds.w / 2), 0, -(bounds.z + bounds.d / 2)];
  const span = Math.max(bounds.w, bounds.d);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [select]);

  return (
    <Canvas
      shadows
      camera={{ position: [span * 0.75, span * 0.95, span * 0.95], fov: 45 }}
      onPointerMissed={() => select(null)}
    >
      <color attach="background" args={["#0f1419"]} />
      <ambientLight intensity={0.75} />
      <directionalLight position={[span, span * 1.5, span]} intensity={1.1} castShadow />
      <hemisphereLight intensity={0.3} />

      <Grid
        args={[60, 60]}
        cellColor="#2a3340"
        sectionColor="#3a4a5a"
        infiniteGrid
        fadeDistance={Math.max(40, span * 4)}
      />

      <group position={offset}>
        <FloorPlanView plan={plan} />
        {plan.items
          .filter((it) => it.id !== selectedId)
          .map((it) => (
            <ItemMesh key={it.id} item={it} />
          ))}
      </group>

      <SelectedTransform offset={offset} />

      <OrbitControls makeDefault enableDamping target={[0, wallHeight / 3, 0]} />
    </Canvas>
  );
}
