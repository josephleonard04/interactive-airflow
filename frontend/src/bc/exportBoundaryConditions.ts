import type { Room, SceneObject, Vec3 } from "../scene/types";

// Translate the editor scene into a solver-agnostic boundary-condition
// description. This is the seam between the editor and the LFM fluid simulator:
// when an object moves, we re-derive this and hand it to the solver.
//
// The exact schema LFM wants is TBD (pending Yuchen's answer on how solid
// objects / BCs are defined — see docs/draft-reply-yuchen.md, question 4). For
// now we emit a neutral JSON the bridge can adapt: an axis-aligned bounding box
// per solid, and inlet/outlet patches with a flow magnitude.

export interface SolidBC {
  id: string;
  name: string;
  // Axis-aligned bounding box in room-local metres.
  min: Vec3;
  max: Vec3;
}

export interface FlowBC {
  id: string;
  name: string;
  type: "inlet" | "outlet";
  center: Vec3;
  size: Vec3;
  flow: number; // m^3/s
}

export interface BoundaryConditions {
  room: { size: Vec3 };
  solids: SolidBC[];
  flows: FlowBC[];
}

function aabb(o: SceneObject): { min: Vec3; max: Vec3 } {
  // Axis-aligned for now (rotationY ignored until we need oriented boxes).
  const [x, y, z] = o.position;
  const [w, h, d] = o.size;
  return {
    min: [x - w / 2, y - h / 2, z - d / 2],
    max: [x + w / 2, y + h / 2, z + d / 2],
  };
}

export function exportBoundaryConditions(room: Room, objects: SceneObject[]): BoundaryConditions {
  const solids: SolidBC[] = [];
  const flows: FlowBC[] = [];

  for (const o of objects) {
    if (o.kind === "furniture") {
      solids.push({ id: o.id, name: o.name, ...aabb(o) });
    } else {
      flows.push({
        id: o.id,
        name: o.name,
        type: o.kind === "supply" ? "inlet" : "outlet",
        center: o.position,
        size: o.size,
        flow: o.flow ?? 0,
      });
    }
  }

  return { room: { size: room.size }, solids, flows };
}
