import { useRef, useState } from "react";
import { Edges } from "@react-three/drei";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import type { Group } from "three";
import type { PlacedItem } from "../floorplan/types";
import { useSceneStore } from "../scene/store";
import { canAim, canMove } from "../floorplan/scenarios";
import { Model } from "./models";

// One placed item: a composite furniture/HVAC model plus an invisible click
// target (so the whole footprint is grabbable) and a glow outline when
// selected/hovered. Pointer-down in select mode selects it and starts a floor
// drag (handled by the Editor's DragController).

export function ItemMesh({ item }: { item: PlacedItem }) {
  const selectedId = useSceneStore((s) => s.selectedId);
  const mode = useSceneStore((s) => s.mode);
  const selectItem = useSceneStore((s) => s.selectItem);
  const setDragging = useSceneStore((s) => s.setDragging);
  const [hovered, setHovered] = useState(false);
  const selected = selectedId === item.id;

  // An oscillating fan sweeps left–right like a real stand fan (faster at
  // higher power). The sweep group sits inside the item's own yaw, so the
  // user-set facing stays the sweep centre.
  const sweepRef = useRef<Group>(null);
  const sweeping = item.type === "fan" && !!item.oscillate && item.on !== false;
  useFrame(({ clock }) => {
    if (!sweepRef.current) return;
    sweepRef.current.rotation.y = sweeping
      ? Math.sin(clock.elapsedTime * (0.9 + (item.power ?? 2) * 0.35)) * 0.7
      : 0;
  });

  // In a study scenario only the task's own devices are draggable. The rest of
  // the home is scenery: it is there because a real room has furniture in it,
  // not because the participant is meant to rearrange it.
  const tools = useSceneStore((s) => s.tools);
  const draggable = canMove(tools, item.type);
  // Aimable-but-not-movable items (a rented AC) can still be SELECTED so their
  // angle can be changed — they just don't start a position drag.
  const selectable = canAim(tools, item.type);

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (mode !== "select" || !selectable) return;
    e.stopPropagation();
    selectItem(item.id);
    if (draggable) setDragging(item.id);
  };

  return (
    <group
      position={item.position}
      rotation={[0, item.rotationY, 0]}
      onPointerDown={onPointerDown}
      onPointerOver={(e) => {
        if (!selectable) return; // no hover affordance on scenery
        e.stopPropagation();
        setHovered(true);
      }}
      onPointerOut={() => setHovered(false)}
    >
      {/* invisible but raycastable click target covering the footprint */}
      <mesh>
        <boxGeometry args={item.size} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        {(selected || hovered) && (
          <Edges scale={1.05} threshold={15} color={selected ? "#22d3ee" : "#67e8f9"} />
        )}
      </mesh>

      <group ref={sweepRef}>
        <Model type={item.type} size={item.size} />
      </group>
    </group>
  );
}
