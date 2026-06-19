import { Text } from "@react-three/drei";
import { ROOM_COLOR } from "../floorplan/palette";
import type { FloorPlan } from "../floorplan/types";
import { WallMesh } from "./WallMesh";

// Renders the structural shell: a colour-coded floor per room with its label,
// and every wall (with doors/windows carved out). Furniture/HVAC are rendered
// separately by the Editor so they remain individually selectable/movable.

export function FloorPlanView({ plan }: { plan: FloorPlan }) {
  return (
    <group>
      {plan.rooms.map((room) => {
        const { x, z, w, d } = room.rect;
        const cx = x + w / 2;
        const cz = z + d / 2;
        return (
          <group key={room.id}>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[cx, 0.02, cz]} receiveShadow>
              <planeGeometry args={[w, d]} />
              <meshStandardMaterial color={ROOM_COLOR[room.type]} />
            </mesh>
            <Text
              position={[cx, 0.05, cz]}
              rotation={[-Math.PI / 2, 0, 0]}
              fontSize={Math.min(0.32, w / 6, d / 4)}
              color="#1f2937"
              anchorX="center"
              anchorY="middle"
            >
              {room.name.toUpperCase()}
            </Text>
          </group>
        );
      })}

      {plan.walls.map((wall) => (
        <WallMesh key={wall.id} wall={wall} />
      ))}
    </group>
  );
}
