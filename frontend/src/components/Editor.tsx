import { useEffect, useRef } from "react";
import { Canvas } from "@react-three/fiber";
import { Grid, OrbitControls, TransformControls } from "@react-three/drei";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { useSceneStore } from "../scene/store";
import type { Vec3 } from "../scene/types";
import { Room } from "./Room";
import { SceneObjectMesh } from "./SceneObjectMesh";

// The 3D viewport. OrbitControls for camera; TransformControls (a translate
// gizmo) attached to the selected object. Dragging the gizmo is the "mouse"
// control path; it commits the new position back into the store on release,
// exactly like the programmatic api would.

function SelectedTransform() {
  const transformRef = useRef<any>(null);
  const selectedId = useSceneStore((s) => s.selectedId);
  const objects = useSceneStore((s) => s.objects);
  const setPosition = useSceneStore((s) => s.setPosition);
  const selected = objects.find((o) => o.id === selectedId) ?? null;

  if (!selected) return null;

  return (
    <TransformControls
      ref={transformRef}
      mode="translate"
      onMouseUp={() => {
        const obj = transformRef.current?.object;
        if (obj) {
          const p = obj.position;
          setPosition(selected.id, [p.x, p.y, p.z] as Vec3);
        }
      }}
    >
      <SceneObjectMesh object={selected} />
    </TransformControls>
  );
}

export function Editor() {
  const room = useSceneStore((s) => s.room);
  const objects = useSceneStore((s) => s.objects);
  const selectedId = useSceneStore((s) => s.selectedId);
  const select = useSceneStore((s) => s.select);
  const orbitRef = useRef<OrbitControlsImpl>(null);

  // Disable camera orbit while dragging the transform gizmo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [select]);

  const [w, h, d] = room.size;

  return (
    <Canvas shadows camera={{ position: [w * 1.3, h * 1.6, d * 1.6], fov: 50 }}>
      <color attach="background" args={["#0f1419"]} />
      <ambientLight intensity={0.6} />
      <directionalLight position={[5, 8, 5]} intensity={1.1} castShadow />

      {/* click empty space to deselect */}
      <mesh
        position={[0, -0.01, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        onPointerDown={() => select(null)}
        visible={false}
      >
        <planeGeometry args={[100, 100]} />
      </mesh>

      <Grid
        args={[20, 20]}
        cellColor="#2a3340"
        sectionColor="#3a4a5a"
        position={[0, 0, 0]}
        infiniteGrid
        fadeDistance={30}
      />

      <Room size={room.size} />

      {/* non-selected objects render plainly; the selected one is wrapped in the gizmo */}
      {objects
        .filter((o) => o.id !== selectedId)
        .map((o) => (
          <SceneObjectMesh key={o.id} object={o} />
        ))}

      <SelectedTransform />

      <OrbitControls
        ref={orbitRef}
        makeDefault
        enableDamping
        target={[0, h / 2, 0]}
      />
    </Canvas>
  );
}
