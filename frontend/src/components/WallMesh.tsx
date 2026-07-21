import { useMemo, useState } from "react";
import type { ThreeEvent } from "@react-three/fiber";
import { wallPieces } from "../floorplan/geometry";
import type { WallSeg } from "../floorplan/types";
import { useSceneStore } from "../scene/store";
import { WALL_RENDER_ORDER } from "../viz/layers";

// Renders one wall as solid boxes (carved around doors/windows, keeping headers
// above them). Walls are semi-transparent so interiors stay visible. In select
// mode a wall can be clicked to select it (then add a door/window, or delete to
// open up a room). Hover highlights what you're about to select, so it's clear
// whether you'll grab the wall or a door/window in front of it.

export function WallMesh({ wall }: { wall: WallSeg }) {
  const pieces = useMemo(() => wallPieces(wall), [wall]);
  const selectedWallId = useSceneStore((s) => s.selectedWallId);
  const mode = useSceneStore((s) => s.mode);
  const selectWall = useSceneStore((s) => s.selectWall);
  const [hovered, setHovered] = useState(false);
  const selected = selectedWallId === wall.id;
  const active = selected || hovered;

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (mode !== "select") return;
    e.stopPropagation();
    selectWall(wall.id);
  };

  const color = selected ? "#22d3ee" : hovered ? "#8fd6e6" : wall.exterior ? "#b9c2cc" : "#cdd5dd";

  return (
    <group
      onPointerDown={onPointerDown}
      onPointerOver={(e) => {
        if (mode !== "select") return;
        e.stopPropagation();
        setHovered(true);
      }}
      onPointerOut={() => setHovered(false)}
    >
      {pieces.map((p, i) => (
        // renderOrder: walls are drawn AFTER the airflow lines. Both are
        // transparent and neither writes depth, so without an explicit order
        // three.js sorts them by centroid distance — which flips from line to
        // line and as the camera moves. The result was that some streamlines
        // painted over a wall and others under it, so the same picture showed
        // air apparently passing through walls and floors while the underlying
        // geometry never did. Fixing the order makes every line consistently
        // read as being BEHIND the glass, which is what a see-through wall means.
        <mesh key={i} position={p.center} renderOrder={WALL_RENDER_ORDER}>
          <boxGeometry args={p.size} />
          <meshStandardMaterial
            color={color}
            emissive={active ? "#22d3ee" : "#000000"}
            emissiveIntensity={selected ? 0.4 : hovered ? 0.2 : 0}
            transparent
            opacity={active ? 0.78 : 0.5}
            depthWrite={false}
          />
        </mesh>
      ))}
    </group>
  );
}
