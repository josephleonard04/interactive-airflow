import type { FloorPlan, PlacedItem, Vec3 } from "../floorplan/types";

// Translate a floor plan into a solver-agnostic boundary-condition description —
// the seam between the editor and the LFM fluid simulator. It carries both the
// vector geometry (walls / doors / windows / solids) and the rasterised room
// labels so the solver knows which cells belong to which room, for airflow /
// temperature / humidity / CO2 simulation.
//
// The exact schema LFM wants is TBD (see docs/draft-reply-yuchen.md, Q4); this
// is a neutral JSON the integration bridge can adapt.

export interface AABB {
  id: string;
  type: string;
  roomId: string;
  min: Vec3;
  max: Vec3;
}

export interface FlowBC {
  id: string;
  type: string; // supply / return / ac
  role: "inlet" | "outlet";
  roomId: string;
  center: Vec3;
  size: Vec3;
  flow: number;
}

export interface WallBC {
  a: [number, number];
  b: [number, number];
  thickness: number;
  height: number;
  exterior: boolean;
  roomId: string;
}

export interface OpeningBC {
  id: string;
  a: [number, number];
  b: [number, number];
  width: number;
  sill: number;
  height: number;
  rooms: [string, string];
}

export interface BoundaryConditions {
  housingType: string;
  name: string;
  bounds: FloorPlan["bounds"];
  wallHeight: number;
  rooms: Array<{ id: string; type: string; name: string; rect: FloorPlan["bounds"] }>;
  grid: FloorPlan["grid"];
  walls: WallBC[];
  doors: OpeningBC[];
  windows: OpeningBC[];
  solids: AABB[];
  flows: FlowBC[];
  fans: AABB[];
}

function aabb(it: PlacedItem): AABB {
  const [x, y, z] = it.position;
  const [w, h, d] = it.size;
  return {
    id: it.id,
    type: it.type,
    roomId: it.roomId,
    min: [x - w / 2, y - h / 2, z - d / 2],
    max: [x + w / 2, y + h / 2, z + d / 2],
  };
}

export function exportBoundaryConditions(plan: FloorPlan): BoundaryConditions {
  const solids: AABB[] = [];
  const flows: FlowBC[] = [];
  const fans: AABB[] = [];

  for (const it of plan.items) {
    if (it.category === "furniture") {
      solids.push(aabb(it));
    } else if (it.type === "return") {
      flows.push({
        id: it.id,
        type: it.type,
        role: "outlet",
        roomId: it.roomId,
        center: it.position,
        size: it.size,
        flow: it.flow ?? 0,
      });
    } else if (it.type === "supply" || it.type === "ac") {
      flows.push({
        id: it.id,
        type: it.type,
        role: "inlet",
        roomId: it.roomId,
        center: it.position,
        size: it.size,
        flow: it.flow ?? 0,
      });
    } else if (it.type === "fan") {
      fans.push(aabb(it));
    }
  }

  const mapOpening = (o: FloorPlan["doors"][number]): OpeningBC => ({
    id: o.id,
    a: o.a,
    b: o.b,
    width: o.width,
    sill: o.sill,
    height: o.height,
    rooms: o.rooms as [string, string],
  });

  return {
    housingType: plan.housingType,
    name: plan.name,
    bounds: plan.bounds,
    wallHeight: plan.wallHeight,
    rooms: plan.rooms.map((r) => ({ id: r.id, type: r.type, name: r.name, rect: r.rect })),
    grid: plan.grid,
    walls: plan.walls.map((w) => ({
      a: w.a,
      b: w.b,
      thickness: w.thickness,
      height: w.height,
      exterior: w.exterior,
      roomId: w.roomId,
    })),
    doors: plan.doors.map(mapOpening),
    windows: plan.windows.map(mapOpening),
    solids,
    flows,
    fans,
  };
}
