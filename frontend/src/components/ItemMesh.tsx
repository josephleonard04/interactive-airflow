import { useState } from "react";
import { Edges } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";
import type { PlacedItem } from "../floorplan/types";
import { useSceneStore } from "../scene/store";
import { Model } from "./models";

// One placed item: a composite furniture/HVAC model plus an invisible click
// target (so the whole footprint is grabbable) and a glow outline when
// selected/hovered. Pointer-down in select mode selects it and starts a floor
// drag (handled by the Editor's DragController).

export function ItemMesh({ item }: { item: PlacedItem }) {
  const selectedId = useSceneStore((s) => s.selectedId);
  const mode = useSceneStore((s) => s.mode);
  const selectItem = useSceneStore((s) => s.selectItem);
  const setDragging = useSceneStore((s) => s.setDragging);
  const [hovered, setHovered] = useState(false);
  const selected = selectedId === item.id;

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (mode !== "select") return;
    e.stopPropagation();
    selectItem(item.id);
    setDragging(item.id);
  };

  return (
    <group
      position={item.position}
      rotation={[0, item.rotationY, 0]}
      onPointerDown={onPointerDown}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHovered(true);
      }}
      onPointerOut={() => setHovered(false)}
    >
      {/* invisible but raycastable click target covering the footprint */}
      <mesh>
        <boxGeometry args={item.size} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        {(selected || hovered) && (
          <Edges scale={1.05} threshold={15} color={selected ? "#22d3ee" : "#67e8f9"} />
        )}
      </mesh>

      <Model type={item.type} size={item.size} />
    </group>
  );
}
