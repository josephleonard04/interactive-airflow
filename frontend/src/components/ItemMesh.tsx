import { itemColor } from "../floorplan/palette";
import type { PlacedItem } from "../floorplan/types";
import { useSceneStore } from "../scene/store";

// One placed item (furniture or HVAC). Click to select; HVAC vents render
// semi-transparent so they read as openings rather than solids.

export function ItemMesh({ item }: { item: PlacedItem }) {
  const selectedId = useSceneStore((s) => s.selectedId);
  const select = useSceneStore((s) => s.select);
  const selected = selectedId === item.id;
  const isVent = item.type === "supply" || item.type === "return";

  return (
    <mesh
      name={item.id}
      position={item.position}
      rotation={[0, item.rotationY, 0]}
      onPointerDown={(e) => {
        e.stopPropagation();
        select(item.id);
      }}
      castShadow={item.category === "furniture"}
    >
      <boxGeometry args={item.size} />
      <meshStandardMaterial
        color={itemColor(item.type)}
        emissive={selected ? "#22d3ee" : "#000000"}
        emissiveIntensity={selected ? 0.5 : 0}
        transparent={isVent}
        opacity={isVent ? 0.7 : 1}
      />
    </mesh>
  );
}
