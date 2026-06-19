import { useMemo } from "react";
import { BoxGeometry } from "three";
import type { Vec3 } from "../scene/types";

// The fixed room shell: floor + back/side walls drawn as thin, semi-transparent
// planes so the interior stays visible, plus a wireframe box for clear bounds.
// Origin is the room-centre on the floor.

export function Room({ size }: { size: Vec3 }) {
  const [w, h, d] = size;
  const boxGeometry = useMemo(() => new BoxGeometry(w, h, d), [w, h, d]);

  return (
    <group>
      {/* floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[w, d]} />
        <meshStandardMaterial color="#d9dee5" />
      </mesh>

      {/* back wall (−z) */}
      <mesh position={[0, h / 2, -d / 2]}>
        <planeGeometry args={[w, h]} />
        <meshStandardMaterial color="#eef1f5" transparent opacity={0.35} side={2} />
      </mesh>

      {/* left wall (−x) */}
      <mesh position={[-w / 2, h / 2, 0]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[d, h]} />
        <meshStandardMaterial color="#e7ebf0" transparent opacity={0.25} side={2} />
      </mesh>

      {/* wireframe edge box for clear bounds */}
      <lineSegments position={[0, h / 2, 0]}>
        <edgesGeometry args={[boxGeometry]} />
        <lineBasicMaterial color="#9aa7b4" />
      </lineSegments>
    </group>
  );
}
