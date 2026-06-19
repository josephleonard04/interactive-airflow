import { useMemo } from "react";
import type { ThreeEvent } from "@react-three/fiber";
import { wallPieces } from "../floorplan/geometry";
import type { WallSeg } from "../floorplan/types";
import { useSceneStore } from "../scene/store";

// Renders one wall as solid boxes (carved around doors/windows) plus translucent
// window panes. Walls are semi-transparent so interiors stay visible. In select
// mode a wall can be clicked to select it (then deleted to open up a room).

export function WallMesh({ wall }: { wall: WallSeg }) {
  const pieces = useMemo(() => wallPieces(wall), [wall]);
  const selectedWallId = useSceneStore((s) => s.selectedWallId);
  const mode = useSceneStore((s) => s.mode);
  const selectWall = useSceneStore((s) => s.selectWall);
  const selected = selectedWallId === wall.id;

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (mode !== "select") return;
    e.stopPropagation();
    selectWall(wall.id);
  };

  const solidColor = selected ? "#22d3ee" : wall.exterior ? "#b9c2cc" : "#cdd5dd";

  return (
    <group onPointerDown={onPointerDown}>
      {pieces.map((p, i) =>
        p.kind === "solid" ? (
          <mesh key={i} position={p.center}>
            <boxGeometry args={p.size} />
            <meshStandardMaterial
              color={solidColor}
              emissive={selected ? "#22d3ee" : "#000000"}
              emissiveIntensity={selected ? 0.4 : 0}
              transparent
              opacity={selected ? 0.75 : 0.5}
              depthWrite={false}
            />
          </mesh>
        ) : (
          <mesh key={i} position={p.center}>
            <boxGeometry args={p.size} />
            <meshStandardMaterial color="#aee0ff" transparent opacity={0.28} depthWrite={false} />
          </mesh>
        ),
      )}
    </group>
  );
}
