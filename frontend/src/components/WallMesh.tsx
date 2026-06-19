import { useMemo } from "react";
import { wallPieces } from "../floorplan/geometry";
import type { WallSeg } from "../floorplan/types";

// Renders one wall segment as a set of solid boxes (carved around doors and
// windows) plus translucent panes for windows. Walls are semi-transparent so
// the room interiors stay visible from an angled view.

export function WallMesh({ wall }: { wall: WallSeg }) {
  const pieces = useMemo(() => wallPieces(wall), [wall]);

  return (
    <group>
      {pieces.map((p, i) =>
        p.kind === "solid" ? (
          <mesh key={i} position={p.center}>
            <boxGeometry args={p.size} />
            <meshStandardMaterial
              color={wall.exterior ? "#b9c2cc" : "#cdd5dd"}
              transparent
              opacity={0.5}
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
