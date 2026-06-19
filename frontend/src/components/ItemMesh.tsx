import { useState } from "react";
import type { ThreeEvent } from "@react-three/fiber";
import { itemColor } from "../floorplan/palette";
import type { PlacedItem } from "../floorplan/types";
import { useSceneStore } from "../scene/store";

// One placed item (furniture or HVAC). In select mode, pointer-down selects it
// and begins a floor drag (handled by the Editor's DragController). HVAC vents
// render semi-transparent so they read as openings rather than solids.

export function ItemMesh({ item }: { item: PlacedItem }) {
  const selectedId = useSceneStore((s) => s.selectedId);
  const mode = useSceneStore((s) => s.mode);
  const selectItem = useSceneStore((s) => s.selectItem);
  const setDragging = useSceneStore((s) => s.setDragging);
  const [hovered, setHovered] = useState(false);
  const selected = selectedId === item.id;
  const isVent = item.type === "supply" || item.type === "return";

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (mode !== "select") return;
    e.stopPropagation();
    selectItem(item.id);
    setDragging(item.id);
  };

  return (
    <mesh
      name={item.id}
      position={item.position}
      rotation={[0, item.rotationY, 0]}
      onPointerDown={onPointerDown}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHovered(true);
      }}
      onPointerOut={() => setHovered(false)}
      castShadow={item.category === "furniture"}
    >
      <boxGeometry args={item.size} />
      <meshStandardMaterial
        color={itemColor(item.type)}
        emissive={selected ? "#22d3ee" : hovered ? "#0ea5b7" : "#000000"}
        emissiveIntensity={selected ? 0.55 : hovered ? 0.3 : 0}
        transparent={isVent}
        opacity={isVent ? 0.7 : 1}
      />
    </mesh>
  );
}
