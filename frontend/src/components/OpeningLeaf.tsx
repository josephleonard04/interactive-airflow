import { useState } from "react";
import { Edges } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";
import type { Opening } from "../floorplan/types";
import { useSceneStore } from "../scene/store";

// Renders a door panel or window sash inside its opening, with a frame. The leaf
// hinges open when `open` is true. Clicking selects the opening (so the panel
// can be toggled or removed). Drawn in plan coordinates (inside the centred
// group), so it reads the opening's floor endpoints directly.

const FRAME = 0.05;
const FRAME_DEPTH = 0.13;

export function OpeningLeaf({ opening }: { opening: Opening }) {
  const mode = useSceneStore((s) => s.mode);
  const selectOpening = useSceneStore((s) => s.selectOpening);
  const selected = useSceneStore((s) => s.selectedOpeningId) === opening.id;
  const [hovered, setHovered] = useState(false);

  const { a, b, kind, sill, height, open } = opening;
  const vertical = Math.abs(a[0] - b[0]) < 1e-3;
  const line = vertical ? a[0] : a[1];
  const lo = vertical ? Math.min(a[1], b[1]) : Math.min(a[0], b[0]);
  const hi = vertical ? Math.max(a[1], b[1]) : Math.max(a[0], b[0]);
  const width = hi - lo;

  const cx = vertical ? line : (lo + hi) / 2;
  const cz = vertical ? (lo + hi) / 2 : line;
  const hingeX = vertical ? line : lo;
  const hingeZ = vertical ? lo : line;
  const base = vertical ? -Math.PI / 2 : 0;

  const sillY = kind === "door" ? 0 : sill;
  const thickness = kind === "door" ? 0.045 : 0.03;
  const isDoor = kind === "door";

  const onDown = (e: ThreeEvent<PointerEvent>) => {
    if (mode !== "select") return;
    e.stopPropagation();
    selectOpening(opening.id);
  };

  return (
    <group
      onPointerDown={onDown}
      onPointerOver={(e) => {
        if (mode !== "select") return;
        e.stopPropagation();
        setHovered(true);
      }}
      onPointerOut={() => setHovered(false)}
    >
      {/* frame (static, in the wall plane) */}
      <group position={[cx, 0, cz]} rotation={[0, base, 0]}>
        <mesh position={[-width / 2 - FRAME / 2, sillY + height / 2, 0]}>
          <boxGeometry args={[FRAME, height + FRAME, FRAME_DEPTH]} />
          <meshStandardMaterial color="#e9edf1" />
        </mesh>
        <mesh position={[width / 2 + FRAME / 2, sillY + height / 2, 0]}>
          <boxGeometry args={[FRAME, height + FRAME, FRAME_DEPTH]} />
          <meshStandardMaterial color="#e9edf1" />
        </mesh>
        <mesh position={[0, sillY + height + FRAME / 2, 0]}>
          <boxGeometry args={[width + FRAME * 2, FRAME, FRAME_DEPTH]} />
          <meshStandardMaterial color="#e9edf1" />
        </mesh>
        {!isDoor && (
          <mesh position={[0, sillY - FRAME / 2, 0]}>
            <boxGeometry args={[width + FRAME * 2, FRAME, FRAME_DEPTH]} />
            <meshStandardMaterial color="#e9edf1" />
          </mesh>
        )}
      </group>

      {isDoor ? (
        /* door: a panel that swings open on a hinge */
        <group position={[hingeX, sillY, hingeZ]} rotation={[0, base + (open ? 1.4 : 0), 0]}>
          <mesh position={[width / 2, height / 2, 0]} castShadow>
            <boxGeometry args={[width, height, thickness]} />
            <meshStandardMaterial color="#a07f57" roughness={0.7} />
            {(selected || hovered) && (
              <Edges scale={1.06} threshold={15} color={selected ? "#22d3ee" : "#67e8f9"} />
            )}
          </mesh>
          <mesh position={[width * 0.86, height * 0.5, thickness / 2 + 0.02]}>
            <sphereGeometry args={[0.03, 8, 8]} />
            <meshStandardMaterial color="#d4af37" metalness={0.6} roughness={0.3} />
          </mesh>
        </group>
      ) : (
        /* window: glass when closed, clear (open passage) when open — no swing */
        <group position={[cx, 0, cz]} rotation={[0, base, 0]}>
          <mesh position={[0, sillY + height / 2, 0]}>
            <boxGeometry args={[width, height, thickness]} />
            <meshStandardMaterial
              color="#bfe6ff"
              transparent
              opacity={open ? 0.05 : 0.42}
              roughness={0.1}
              metalness={0.1}
            />
            {(selected || hovered) && (
              <Edges scale={1.06} threshold={15} color={selected ? "#22d3ee" : "#67e8f9"} />
            )}
          </mesh>
        </group>
      )}
    </group>
  );
}
