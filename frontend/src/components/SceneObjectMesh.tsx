import { useSceneStore } from "../scene/store";
import type { SceneObject } from "../scene/types";

// Colour per kind: furniture = solid obstacle, supply = inlet (cool blue),
// return = outlet (warm amber). Selected object is highlighted.
const KIND_COLOR: Record<SceneObject["kind"], string> = {
  furniture: "#8a8f98",
  supply: "#3b82f6",
  return: "#f59e0b",
};

export function SceneObjectMesh({ object }: { object: SceneObject }) {
  const selectedId = useSceneStore((s) => s.selectedId);
  const select = useSceneStore((s) => s.select);
  const selected = selectedId === object.id;

  return (
    <mesh
      name={object.id}
      position={object.position}
      rotation={[0, object.rotationY, 0]}
      onPointerDown={(e) => {
        e.stopPropagation();
        select(object.id);
      }}
      castShadow
    >
      <boxGeometry args={object.size} />
      <meshStandardMaterial
        color={KIND_COLOR[object.kind]}
        emissive={selected ? "#22d3ee" : "#000000"}
        emissiveIntensity={selected ? 0.4 : 0}
        transparent={object.kind !== "furniture"}
        opacity={object.kind === "furniture" ? 1 : 0.65}
      />
    </mesh>
  );
}
