import { ROOM_COLOR } from "../floorplan/palette";
import type { FloorPlan } from "../floorplan/types";
import { WallMesh } from "./WallMesh";

// Structural shell: a colour-coded floor per room (no on-floor text labels —
// rooms are identified in the side panel) and every wall with doors/windows
// carved out. Furniture/HVAC are rendered separately so they stay selectable.

export function FloorPlanView({ plan }: { plan: FloorPlan }) {
  return (
    <group>
      {plan.rooms.map((room) => {
        const { x, z, w, d } = room.rect;
        return (
          <mesh
            key={room.id}
            rotation={[-Math.PI / 2, 0, 0]}
            position={[x + w / 2, 0.02, z + d / 2]}
            receiveShadow
          >
            <planeGeometry args={[w, d]} />
            <meshStandardMaterial color={ROOM_COLOR[room.type]} roughness={0.95} />
          </mesh>
        );
      })}

      {plan.walls.map((wall) => (
        <WallMesh key={wall.id} wall={wall} />
      ))}
    </group>
  );
}
