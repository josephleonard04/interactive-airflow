import type { FloorPlan } from "../floorplan/types";

// WHAT THE HOME LOOKED LIKE AT ONE MOMENT, small enough to attach to every
// logged event.
//
// The session log used to record what CHANGED — "move fan from (1.2, 4.0) to
// (3.1, 4.7)" — which is enough to read a transcript and nothing like enough to
// analyse one. Reconstructing the layout at step 40 meant replaying the first
// 39 deltas and hoping none of them was lossy, and the moment anything was
// logged before the state it described (several were), the replay silently
// diverged. Attaching the whole arrangement to each event costs a few hundred
// bytes and removes that entire class of problem: every row is self-contained,
// so any step can be scored, diffed or re-simulated on its own.

/** One device or piece of furniture, as it stood. Rounded, because the analysis
 *  question is "where was it", not "which float". */
export interface ItemState {
  id: string;
  type: string;
  room: string;
  /** Metres, floor plan coordinates. */
  x: number;
  z: number;
  /** Height off the floor — matters for wall units. */
  y: number;
  /** Heading in degrees, 0 = +z, 90 = +x. */
  yaw: number;
  /** Vertical aim in degrees, + = up. Only meaningful on an AC or a fan. */
  tilt?: number;
  on?: boolean;
  power?: number;
  oscillate?: boolean;
}

export interface OpeningState {
  id: string;
  kind: string;
  between: string[];
  open: boolean;
  /** Where along the wall, so a moved window is visible in the log. */
  x: number;
  z: number;
}

export interface LayoutSnapshot {
  items: ItemState[];
  openings: OpeningState[];
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const degrees = (rad: number) => Math.round((rad * 180) / Math.PI);

export function snapshotLayout(plan: FloorPlan): LayoutSnapshot {
  return {
    items: plan.items.map((it) => ({
      id: it.id,
      type: it.type,
      room: it.roomId,
      x: r2(it.position[0]),
      z: r2(it.position[2]),
      y: r2(it.position[1]),
      yaw: degrees(it.rotationY),
      ...(it.tilt !== undefined ? { tilt: degrees(it.tilt) } : {}),
      ...(it.on !== undefined ? { on: it.on } : {}),
      ...(it.power !== undefined ? { power: it.power } : {}),
      ...(it.oscillate !== undefined ? { oscillate: it.oscillate } : {}),
    })),
    openings: [...plan.doors, ...plan.windows].map((o) => ({
      id: o.id,
      kind: o.kind,
      between: o.rooms,
      open: o.open,
      x: r2((o.a[0] + o.b[0]) / 2),
      z: r2((o.a[1] + o.b[1]) / 2),
    })),
  };
}
