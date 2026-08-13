import { carveOpening } from "./geometry";
import type { FloorPlan, Opening } from "./types";

// Where a window is ALLOWED to go, as a pure function of the plan.
//
// The editor already answers a version of this question — moveOpeningToPoint in
// scene/store.ts walks the room's walls, picks the one nearest the cursor and
// refuses the illegal ones. That path is interactive by nature: it needs a
// cursor, it moves one opening to one place, and it lives inside a zustand set().
// The placement search needs the same RULES with none of that: every legal spot,
// enumerated, on a plan it is holding rather than the one on screen.
//
// So the rules live here and the search reads them. The store keeps its own
// cursor-driven path; what matters is that both refuse the same things, and the
// three refusals below are the ones that actually bite:
//
//   · a window must give onto the OUTSIDE — the wall shared with the next room
//     would make an interior window looking into the living room;
//   · it must not land on another opening;
//   · it must not be cut behind something full-height. A window across a shower
//     screen is glass you cannot reach, cannot open, and cannot see out of, and
//     the air does not get past the screen either. A basin under a window is
//     fine, which is why the test is on height rather than on presence.

/** Fractions along a wall to try. Five is enough to find the good end of a wall
 *  without turning one search into a sweep of the whole perimeter. */
// Seven positions per wall rather than five. Where the glazing sits relative to
// the extract is the bathroom task's whole question, and at five the search had
// 20 placements to choose from across four walls — coarse enough that the best
// spot on a wall was often simply not in the list.
const FRACS = [0.14, 0.26, 0.38, 0.5, 0.62, 0.74, 0.86];
/** Clearance from the corners. */
const M = 0.12;
/** Anything at least this tall blocks glazing behind it. */
const TALL = 1.4;

const rectContains = (r: { x: number; z: number; w: number; d: number }, x: number, z: number) =>
  x > r.x + 1e-3 && x < r.x + r.w - 1e-3 && z > r.z + 1e-3 && z < r.z + r.d - 1e-3;

function span(o: Opening): { axis: "x" | "z"; line: number; s: number; e: number } {
  const vertical = Math.abs(o.a[0] - o.b[0]) < 1e-3;
  return vertical
    ? { axis: "z", line: o.a[0], s: Math.min(o.a[1], o.b[1]), e: Math.max(o.a[1], o.b[1]) }
    : { axis: "x", line: o.a[1], s: Math.min(o.a[0], o.b[0]), e: Math.max(o.a[0], o.b[0]) };
}

/** Every legal placement of `o` on the walls of its own room, as moved copies.
 *  Includes the one it is already in, so a caller can compare "leave it" against
 *  "move it" on the same footing. */
export function windowPlacements(plan: FloorPlan, o: Opening): Opening[] {
  if (o.fixed) return [o];
  const roomId = o.rooms.find((r) => r !== "outside");
  const room = plan.rooms.find((r) => r.id === roomId);
  if (!room) return [o];
  const { x: rx, z: rz, w, d } = room.rect;
  const half = o.width / 2;
  const E = 0.12;
  const outward = (px: number, pz: number) => !plan.rooms.some((r) => rectContains(r.rect, px, pz));
  const mid = { x: rx + w / 2, z: rz + d / 2 };
  const sides = (
    [
      { axis: "x", line: rz, lo: rx, hi: rx + w, out: outward(mid.x, rz - E) },
      { axis: "x", line: rz + d, lo: rx, hi: rx + w, out: outward(mid.x, rz + d + E) },
      { axis: "z", line: rx, lo: rz, hi: rz + d, out: outward(rx - E, mid.z) },
      { axis: "z", line: rx + w, lo: rz, hi: rz + d, out: outward(rx + w + E, mid.z) },
    ] as const
  ).filter((sd) => sd.hi - sd.lo >= o.width + 2 * M && (o.kind !== "window" || sd.out));

  const others = [...plan.doors, ...plan.windows].filter((v) => v.id !== o.id).map(span);
  const tall = plan.items.filter((it) => it.mount === "floor" && it.size[1] >= TALL);

  const out: Opening[] = [];
  for (const sd of sides) {
    for (const f of FRACS) {
      const want = sd.lo + f * (sd.hi - sd.lo);
      const centre = Math.min(sd.hi - M - half, Math.max(sd.lo + M + half, want));
      if (others.some((sp) => sp.axis === sd.axis && Math.abs(sp.line - sd.line) < 1e-3 && centre + half > sp.s - 0.06 && centre - half < sp.e + 0.06)) continue;
      const blocked = tall.some((it) => {
        const swapped = Math.abs(Math.round(it.rotationY / (Math.PI / 2))) % 2 === 1;
        const hx = (swapped ? it.size[2] : it.size[0]) / 2;
        const hz = (swapped ? it.size[0] : it.size[2]) / 2;
        if (sd.axis === "x") {
          if (Math.abs(it.position[2] - sd.line) > hz + 0.35) return false;
          return centre + half > it.position[0] - hx - 0.05 && centre - half < it.position[0] + hx + 0.05;
        }
        if (Math.abs(it.position[0] - sd.line) > hx + 0.35) return false;
        return centre + half > it.position[2] - hz - 0.05 && centre - half < it.position[2] + hz + 0.05;
      });
      if (blocked) continue;
      const moved: Opening = {
        ...o,
        a: sd.axis === "z" ? [sd.line, centre - half] : [centre - half, sd.line],
        b: sd.axis === "z" ? [sd.line, centre + half] : [centre + half, sd.line],
      };
      // Drop placements that duplicate one already collected (two fractions can
      // clamp onto the same centre on a short wall).
      if (out.some((p) => Math.hypot((p.a[0] + p.b[0]) / 2 - (moved.a[0] + moved.b[0]) / 2, (p.a[1] + p.b[1]) / 2 - (moved.a[1] + moved.b[1]) / 2) < 0.25)) continue;
      out.push(moved);
    }
  }
  return out.length ? out : [o];
}

/** The plan with one opening replaced, re-carved into the walls. The same
 *  Opening object is referenced from plan.doors/windows AND wall.openings, so
 *  all three have to agree or the solver and the renderer disagree about where
 *  the hole is. */
export function withOpeningMoved(plan: FloorPlan, moved: Opening): FloorPlan {
  const walls = plan.walls.map((wl) => ({ ...wl, openings: wl.openings.filter((v) => v.id !== moved.id) }));
  carveOpening(walls, moved);
  const swap = (arr: Opening[]) => arr.map((v) => (v.id === moved.id ? moved : v));
  return { ...plan, walls, doors: swap(plan.doors), windows: swap(plan.windows) };
}

/** Which side of its room an opening sits on, in the words someone would use
 *  pointing at the plan. Screen convention: +x right, small z at the top. */
export function windowSideName(plan: FloorPlan, o: Opening): string {
  const roomId = o.rooms.find((r) => r !== "outside");
  const room = plan.rooms.find((r) => r.id === roomId);
  const sp = span(o);
  if (!room) return "another wall";
  const { x, z, w, d } = room.rect;
  const along = sp.axis === "x" ? (sp.s + sp.e) / 2 - x : (sp.s + sp.e) / 2 - z;
  const frac = along / (sp.axis === "x" ? w : d);
  const end = frac < 0.34 ? (sp.axis === "x" ? "left" : "top") : frac > 0.66 ? (sp.axis === "x" ? "right" : "bottom") : "middle";
  const wall =
    sp.axis === "x"
      ? Math.abs(sp.line - z) < Math.abs(sp.line - (z + d))
        ? "top"
        : "bottom"
      : Math.abs(sp.line - x) < Math.abs(sp.line - (x + w))
        ? "left"
        : "right";
  return end === "middle" ? `the middle of the ${wall} wall` : `the ${end} of the ${wall} wall`;
}
