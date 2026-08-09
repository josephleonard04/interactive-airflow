import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useThree, type ThreeEvent } from "@react-three/fiber";
import { ContactShadows, Grid, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { ventMountY } from "../floorplan/catalog";
import { GRID, WALL_THICKNESS } from "../floorplan/geometry";
import { useSceneStore } from "../scene/store";
import type { Opening, Rect, Vec2, Vec3, WallSeg } from "../floorplan/types";
import { FloorPlanView } from "./FloorPlanView";
import { FlowField3D } from "./FlowField3D";
import { ItemMesh } from "./ItemMesh";

/** Wall items whose height is not the participant's to choose — see the drag
 *  handler. Both are ceiling-level grilles in every real installation. */
const VENT_TYPES = ["supply", "return"];

type Side = "north" | "south" | "east" | "west";
interface RoomEdge {
  side: Side;
  dist: number; // perpendicular distance from the cursor to this edge
  axis: "x" | "z"; // wall runs along this axis
  line: number; // constant coordinate of the wall line
  sign: number; // +1/-1: which way the interior (room) is from the line
  rot: number; // yaw so the item faces into the room
}

// The four edges of a room, with the cursor's perpendicular distance to each.
// A wall item attaches to the nearest edge, on the interior side, facing in —
// which is exactly "stick to this side of this room's wall".
function roomEdges(rect: Rect, px: number, pz: number): RoomEdge[] {
  const { x, z, w, d } = rect;
  return [
    { side: "south", dist: Math.abs(pz - z), axis: "x", line: z, sign: 1, rot: 0 },
    { side: "north", dist: Math.abs(z + d - pz), axis: "x", line: z + d, sign: -1, rot: Math.PI },
    { side: "west", dist: Math.abs(px - x), axis: "z", line: x, sign: 1, rot: Math.PI / 2 },
    { side: "east", dist: Math.abs(x + w - px), axis: "z", line: x + w, sign: -1, rot: -Math.PI / 2 },
  ];
}

// Rotation-aware footprint half-extents (a 90°/270° rotation swaps w/d).
function footHalf(size: Vec3, rotationY: number): [number, number] {
  const swapped = Math.abs(Math.round(rotationY / (Math.PI / 2))) % 2 === 1;
  return swapped ? [size[2] / 2, size[0] / 2] : [size[0] / 2, size[2] / 2];
}

// Would an item footprint centred at (gx,gz) overlap ANY wall (including walls
// the user drew)? Used to stop furniture straddling a wall.
function wallBlocked(gx: number, gz: number, fhx: number, fhz: number, walls: WallSeg[]): boolean {
  const ix0 = gx - fhx, ix1 = gx + fhx, iz0 = gz - fhz, iz1 = gz + fhz;
  const eps = 0.02;
  for (const w of walls) {
    const line = w.axis === "z" ? w.a[0] : w.a[1];
    const lo = w.axis === "z" ? Math.min(w.a[1], w.b[1]) : Math.min(w.a[0], w.b[0]);
    const hi = w.axis === "z" ? Math.max(w.a[1], w.b[1]) : Math.max(w.a[0], w.b[0]);
    const t = w.thickness / 2;
    const wx0 = w.axis === "z" ? line - t : lo;
    const wx1 = w.axis === "z" ? line + t : hi;
    const wz0 = w.axis === "z" ? lo : line - t;
    const wz1 = w.axis === "z" ? hi : line + t;
    if (ix1 > wx0 + eps && ix0 < wx1 - eps && iz1 > wz0 + eps && iz0 < wz1 - eps) return true;
  }
  return false;
}

// Would an item footprint block a doorway (the opening plus a clearance in front
// of it on both sides)? Keeps furniture out of doorways.
function doorBlocked(gx: number, gz: number, fhx: number, fhz: number, doors: Opening[]): boolean {
  const clear = 0.45;
  const m = 0.05;
  const ix0 = gx - fhx, ix1 = gx + fhx, iz0 = gz - fhz, iz1 = gz + fhz;
  for (const o of doors) {
    const vertical = Math.abs(o.a[0] - o.b[0]) < 1e-3;
    const line = vertical ? o.a[0] : o.a[1];
    const s = vertical ? Math.min(o.a[1], o.b[1]) : Math.min(o.a[0], o.b[0]);
    const e = vertical ? Math.max(o.a[1], o.b[1]) : Math.max(o.a[0], o.b[0]);
    const rx0 = vertical ? line - clear : s - m;
    const rx1 = vertical ? line + clear : e + m;
    const rz0 = vertical ? s - m : line - clear;
    const rz1 = vertical ? e + m : line + clear;
    if (ix1 > rx0 && ix0 < rx1 && iz1 > rz0 && iz0 < rz1) return true;
  }
  return false;
}

// Drag-to-move with physical constraints:
//  - floor items snap to the grid, stay inside ONE room (no straddling walls),
//    and can't overlap other floor items;
//  - wall items (TV/AC) slide along their wall AND move up/down on it;
//  - camera orbit is disabled during a drag.
function DragController({ offset }: { offset: Vec3 }) {
  const { camera, gl } = useThree();
  const plan = useSceneStore((s) => s.plan);
  const draggingId = useSceneStore((s) => s.draggingId);
  const setPosition = useSceneStore((s) => s.setPosition);
  const setDragging = useSceneStore((s) => s.setDragging);
  const tools = useSceneStore((s) => s.tools);

  useEffect(() => {
    if (!draggingId) return;
    const item = plan.items.find((i) => i.id === draggingId);
    if (!item) return;

    const ray = new THREE.Raycaster();
    const worldY0 = item.position[1];
    const depth = item.size[2];
    const halfW = item.size[0] / 2;
    const off = WALL_THICKNESS / 2 + depth / 2;
    const [fhx, fhz] = footHalf(item.size, item.rotationY);
    const isWallItem = item.mount === "wall";
    // remembered room + edge for the wall-item drag (hysteresis near corners)
    const inset = 0.25;
    const roomAtPt = (px: number, pz: number, pad: number) =>
      plan.rooms.find(
        (r) => px > r.rect.x + pad && px < r.rect.x + r.rect.w - pad && pz > r.rect.z + pad && pz < r.rect.z + r.rect.d - pad,
      );
    const startRoom = roomAtPt(item.position[0], item.position[2], -0.2);
    let lastRoomId: string | null = startRoom?.id ?? null;
    let lastSide: Side | null = startRoom
      ? roomEdges(startRoom.rect, item.position[0], item.position[2]).sort((a, b) => a.dist - b.dist)[0].side
      : null;
    let lastValid: Vec3 = [item.position[0], item.position[1], item.position[2]];

    const ndc = (e: PointerEvent) => {
      const rect = gl.domElement.getBoundingClientRect();
      return new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
    };
    const snapG = (v: number) => Math.round(v / GRID) * GRID;

    const onMove = (e: PointerEvent) => {
      ray.setFromCamera(ndc(e), camera);
      const pt = new THREE.Vector3();

      // wall items (TV/AC): attach to the nearest edge of the room the cursor is
      // in, on the interior side, facing in. Sliding around that side keeps the
      // same wall; crossing to another edge re-orients; entering another room
      // sticks to that room's wall.
      if (isWallItem) {
        const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        const fp = new THREE.Vector3();
        if (!ray.ray.intersectPlane(floor, fp)) return;
        const px = fp.x - offset[0];
        const pz = fp.z - offset[2];

        // which room is the cursor in? Require it a bit inside (inset) so small
        // overshoots past a shared wall don't flip rooms; fall back to the last
        // room, then the nearest room centre.
        let room =
          roomAtPt(px, pz, inset) ??
          plan.rooms.find((r) => r.id === lastRoomId) ??
          plan.rooms.reduce<typeof plan.rooms[number] | null>(
            (b, r) => {
              const dc = Math.hypot(px - (r.rect.x + r.rect.w / 2), pz - (r.rect.z + r.rect.d / 2));
              return !b || dc < Math.hypot(px - (b.rect.x + b.rect.w / 2), pz - (b.rect.z + b.rect.d / 2)) ? r : b;
            },
            null,
          );
        if (!room) return;

        const edges = roomEdges(room.rect, px, pz).sort((a, b) => a.dist - b.dist);
        let edge = edges[0];
        // hysteresis: keep the current side unless clearly closer to another
        if (lastSide && lastRoomId === room.id) {
          const le = edges.find((e) => e.side === lastSide);
          if (le && le.side !== edge.side && edge.dist + 0.3 >= le.dist) edge = le;
        }
        lastRoomId = room.id;
        lastSide = edge.side;

        const { x, z, w, d } = room.rect;
        const m = WALL_THICKNESS / 2 + 0.02;
        let cx: number;
        let cz: number;
        if (edge.axis === "x") {
          const along = Math.min(x + w - halfW - m, Math.max(x + halfW + m, snapG(px)));
          cx = along;
          cz = edge.line + edge.sign * off;
        } else {
          const along = Math.min(z + d - halfW - m, Math.max(z + halfW + m, snapG(pz)));
          cx = edge.line + edge.sign * off;
          cz = along;
        }

        // height up/down the wall: intersect the ray with the vertical wall plane
        // and use the cursor's Y (clamped to keep the item on the wall).
        const sh = item.size[1];
        const wallH = plan.wallHeight;
        let cy: number;
        if (VENT_TYPES.includes(item.type)) {
          // A VENT LIVES JUST UNDER THE CEILING AND NOWHERE ELSE. Letting the
          // cursor's height carry it meant a grille could be dragged to
          // mid-wall or down by the skirting, which is not where extract vents
          // are fitted and quietly changes the physics — height decides whether
          // it pulls the warm, damp air off the top of the room or the cool
          // layer at the floor. The drag is a question about WHICH WALL, so the
          // height is pinned and only the wall and the slide along it move.
          cy = ventMountY(wallH);
        } else {
          const normal = edge.axis === "x" ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
          const lineWorld = edge.axis === "x" ? edge.line + offset[2] : edge.line + offset[0];
          const wallPlane = new THREE.Plane(normal, -lineWorld);
          const wp = new THREE.Vector3();
          cy = worldY0;
          if (ray.ray.intersectPlane(wallPlane, wp)) {
            cy = Math.min(wallH - sh / 2 - 0.02, Math.max(sh / 2 + 0.02, wp.y));
          }
        }
        setPosition(draggingId, [cx, cy, cz], edge.rot);
        return;
      }

      // floor / ceiling items: horizontal plane → grid → confine to a room → no overlap
      const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -worldY0);
      if (!ray.ray.intersectPlane(dragPlane, pt)) return;
      let gx = snapG(pt.x - offset[0]);
      let gz = snapG(pt.z - offset[2]);

      // A TASK CAN PIN AN ITEM TO ONE ROOM — see ScenarioTools.confineToRoom.
      // The winter heater is the case: the question is how heat gets from the
      // room that makes it to the room that needs it, and carrying the heater
      // next door deletes the question rather than answering it. Clamping the
      // drag says so without a dialog: it simply will not go through the door.
      const pinned = tools.confineToRoom?.[item.type];
      let room = pinned
        ? plan.rooms.find((r) => r.id === pinned)
        : plan.rooms.find(
            (r) => gx > r.rect.x && gx < r.rect.x + r.rect.w && gz > r.rect.z && gz < r.rect.z + r.rect.d,
          );
      if (!room) {
        let bd = Infinity;
        for (const r of plan.rooms) {
          const dc = Math.hypot(gx - (r.rect.x + r.rect.w / 2), gz - (r.rect.z + r.rect.d / 2));
          if (dc < bd) ((bd = dc), (room = r));
        }
      }
      if (!room) return;
      const m = WALL_THICKNESS / 2 + 0.03;
      const xlo = room.rect.x + m + fhx;
      const xhi = room.rect.x + room.rect.w - m - fhx;
      const zlo = room.rect.z + m + fhz;
      const zhi = room.rect.z + room.rect.d - m - fhz;
      gx = xlo <= xhi ? Math.min(xhi, Math.max(xlo, gx)) : room.rect.x + room.rect.w / 2;
      gz = zlo <= zhi ? Math.min(zhi, Math.max(zlo, gz)) : room.rect.z + room.rect.d / 2;

      if (item.mount === "floor") {
        const hitItem = plan.items.some((o) => {
          if (o.id === draggingId || o.mount !== "floor") return false;
          const [ohx, ohz] = footHalf(o.size, o.rotationY);
          return Math.abs(gx - o.position[0]) < fhx + ohx - 0.02 && Math.abs(gz - o.position[2]) < fhz + ohz - 0.02;
        });
        // reject straddling a wall (incl. user-drawn) or blocking a doorway
        if (
          hitItem ||
          wallBlocked(gx, gz, fhx, fhz, plan.walls) ||
          doorBlocked(gx, gz, fhx, fhz, plan.doors)
        ) {
          setPosition(draggingId, lastValid);
          return;
        }
      }
      lastValid = [gx, worldY0, gz];
      setPosition(draggingId, lastValid);
    };
    const onUp = () => setDragging(null);

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [draggingId, camera, gl, offset, plan, setPosition, setDragging, tools]);

  return null;
}

// Drag a selected door/window along its wall (it stays on the same wall line).
function OpeningDragController({ offset }: { offset: Vec3 }) {
  const { camera, gl } = useThree();
  const plan = useSceneStore((s) => s.plan);
  const draggingOpeningId = useSceneStore((s) => s.draggingOpeningId);
  const moveOpeningAlong = useSceneStore((s) => s.moveOpeningAlong);
  const moveOpeningToPoint = useSceneStore((s) => s.moveOpeningToPoint);
  const setDraggingOpening = useSceneStore((s) => s.setDraggingOpening);

  useEffect(() => {
    if (!draggingOpeningId) return;
    const o = [...plan.doors, ...plan.windows].find((x) => x.id === draggingOpeningId);
    if (!o || o.fixed) return; // structural — not the participant's to move
    const vertical = Math.abs(o.a[0] - o.b[0]) < 1e-3; // wall runs along z
    const ray = new THREE.Raycaster();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const snapG = (v: number) => Math.round(v / GRID) * GRID;
    const ndc = (e: PointerEvent) => {
      const rect = gl.domElement.getBoundingClientRect();
      return new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
    };
    const onMove = (e: PointerEvent) => {
      ray.setFromCamera(ndc(e), camera);
      const pt = new THREE.Vector3();
      if (!ray.ray.intersectPlane(plane, pt)) return;
      const px = snapG(pt.x - offset[0]);
      const pz = snapG(pt.z - offset[2]);
      // A WINDOW may travel round any wall of its own room, so the drag follows
      // the cursor to the nearest one; a door stays on the wall it was hung in
      // and only slides along it.
      if (o.kind === "window") moveOpeningToPoint(draggingOpeningId, px, pz);
      else moveOpeningAlong(draggingOpeningId, vertical ? pz : px);
    };
    const onUp = () => setDraggingOpening(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [draggingOpeningId, camera, gl, offset, plan, moveOpeningAlong, moveOpeningToPoint, setDraggingOpening]);

  return null;
}

const FLOOR_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

// Floor interaction layer (rendered inside the centred group, so its dots line
// up with the building). In select mode, clicking empty floor clears the
// selection. In add-wall mode, it shows the placement GRID as dots, marks the
// chosen start point, previews the wall to the cursor, and builds it on the
// second click. Uses the pointer ray (not the hit object) so clicks read the
// floor even when the cursor is over furniture.
function FloorInteractor({ offset }: { offset: Vec3 }) {
  const mode = useSceneStore((s) => s.mode);
  const addWall = useSceneStore((s) => s.addWall);
  const clearSelection = useSceneStore((s) => s.clearSelection);
  const bounds = useSceneStore((s) => s.plan.bounds);
  const wallHeight = useSceneStore((s) => s.plan.wallHeight);
  const [start, setStart] = useState<Vec2 | null>(null);
  const [hover, setHover] = useState<Vec2 | null>(null);

  const snap = (v: number) => Math.round(v / GRID) * GRID;
  const floorPoint = (e: ThreeEvent<PointerEvent>): Vec2 | null => {
    const pt = new THREE.Vector3();
    if (!e.ray.intersectPlane(FLOOR_PLANE, pt)) return null;
    return [snap(pt.x - offset[0]), snap(pt.z - offset[2])];
  };

  // grid dots span exactly the home footprint (no overflow)
  const dots = useMemo(() => {
    const arr: number[] = [];
    for (let x = bounds.x; x <= bounds.x + bounds.w + 1e-6; x += GRID)
      for (let z = bounds.z; z <= bounds.z + bounds.d + 1e-6; z += GRID) arr.push(x, 0.03, z);
    return new Float32Array(arr);
  }, [bounds]);

  const onDown = (e: ThreeEvent<PointerEvent>) => {
    if (mode !== "draw-wall") {
      clearSelection();
      return;
    }
    e.stopPropagation();
    const p = floorPoint(e);
    if (!p) return;
    if (!start) setStart(p);
    else {
      if (p[0] !== start[0] || p[1] !== start[1]) addWall(start, p);
      setStart(null);
    }
  };
  const onMove = (e: ThreeEvent<PointerEvent>) => {
    if (mode !== "draw-wall") return;
    const p = floorPoint(e);
    if (p) setHover(p);
  };

  // axis-aligned preview from start → hover (matches addWall's snapping)
  let preview: { pos: Vec3; size: Vec3 } | null = null;
  if (start && hover) {
    const dx = Math.abs(hover[0] - start[0]);
    const dz = Math.abs(hover[1] - start[1]);
    if (dx >= dz) {
      const x0 = Math.min(start[0], hover[0]);
      const x1 = Math.max(start[0], hover[0]);
      preview = { pos: [(x0 + x1) / 2, wallHeight / 2, start[1]], size: [Math.max(x1 - x0, 0.05), wallHeight, WALL_THICKNESS] };
    } else {
      const z0 = Math.min(start[1], hover[1]);
      const z1 = Math.max(start[1], hover[1]);
      preview = { pos: [start[0], wallHeight / 2, (z0 + z1) / 2], size: [WALL_THICKNESS, wallHeight, Math.max(z1 - z0, 0.05)] };
    }
  }

  return (
    <group>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[bounds.x + bounds.w / 2, 0.015, bounds.z + bounds.d / 2]}
        onPointerDown={onDown}
        onPointerMove={onMove}
      >
        <planeGeometry args={[400, 400]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      {mode === "draw-wall" && (
        <group>
          <points>
            <bufferGeometry>
              <bufferAttribute attach="attributes-position" args={[dots, 3]} />
            </bufferGeometry>
            <pointsMaterial size={0.1} color="#0b3a44" sizeAttenuation />
          </points>
          {hover && (
            <mesh position={[hover[0], 0.05, hover[1]]}>
              <sphereGeometry args={[0.09, 14, 14]} />
              <meshBasicMaterial color="#0e7c8c" />
            </mesh>
          )}
          {start && (
            <mesh position={[start[0], 0.06, start[1]]}>
              <sphereGeometry args={[0.13, 14, 14]} />
              <meshBasicMaterial color="#22d3ee" />
            </mesh>
          )}
          {preview && (
            <mesh position={preview.pos}>
              <boxGeometry args={preview.size} />
              <meshStandardMaterial color="#22d3ee" transparent opacity={0.35} />
            </mesh>
          )}
        </group>
      )}
    </group>
  );
}

type ViewName = "top" | "iso" | "fit";

// When the sim panel overlays the left edge of the canvas, shift the rendered
// view right by the covered width so the house stays centred in the part of the
// canvas the user can actually see (instead of hiding behind the panel).
//
// PAN ONLY — NO ZOOM, and the zoom came from the way OUT of it. setViewOffset
// overwrites camera.aspect with fullWidth/fullHeight (a wider-than-canvas value
// here) and clearViewOffset does NOT put it back — it only disables the view.
// So closing the panel left the camera on the wide aspect until the next window
// resize, and a too-wide aspect fits more world across the canvas: the house
// shrank. Reopening the panel restored the correct framing, which read as the
// house "getting bigger" every time Simulate was pressed. Restoring the aspect
// on the way out is the whole fix; the house is now the same size open or shut,
// and the offset does nothing but slide the view sideways.
const SIM_PANEL_COVER = 330; // panel width 300 + left offset/margins
function PanelOffset() {
  const simActive = useSceneStore((s) => s.simActive);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera;
    (globalThis as unknown as { __editorCamera?: THREE.Camera }).__editorCamera = cam; // debug/scripting handle
    const reset = () => {
      cam.clearViewOffset();
      cam.aspect = size.width / size.height;
      cam.updateProjectionMatrix();
    };
    if (simActive && size.width > SIM_PANEL_COVER * 2) {
      cam.setViewOffset(size.width + SIM_PANEL_COVER, size.height, 0, 0, size.width, size.height);
    } else {
      reset();
    }
    return reset;
  }, [camera, simActive, size.width, size.height]);
  return null;
}

// Applies a requested camera view inside the Canvas (runs when `seq` bumps).
function ViewRig({
  seq,
  view,
  span,
  wallHeight,
  orbitRef,
}: {
  seq: number;
  view: ViewName;
  span: number;
  wallHeight: number;
  orbitRef: { current: { target: THREE.Vector3; update: () => void } | null };
}) {
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    if (seq === 0) return;
    const target = new THREE.Vector3(0, view === "top" ? 0 : wallHeight / 3, 0);
    if (view === "top") camera.position.set(0, span * 1.7, 0.001);
    else if (view === "iso") camera.position.set(span * 0.85, span * 0.78, span * 1.05);
    else camera.position.set(span * 0.6, span * 0.52, span * 0.76); // fit: framed closer
    camera.lookAt(target);
    if (orbitRef.current) {
      orbitRef.current.target.copy(target);
      orbitRef.current.update();
    }
  }, [seq]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

export function Editor() {
  const plan = useSceneStore((s) => s.plan);
  const mode = useSceneStore((s) => s.mode);
  const draggingId = useSceneStore((s) => s.draggingId);
  const draggingOpeningId = useSceneStore((s) => s.draggingOpeningId);
  const simActive = useSceneStore((s) => s.simActive);
  const sketchRegion = useSceneStore((s) => s.sketchRegion);
  const selectedId = useSceneStore((s) => s.selectedId);
  const clearSelection = useSceneStore((s) => s.clearSelection);
  const removeSelected = useSceneStore((s) => s.removeSelected);
  const rotateItem = useSceneStore((s) => s.rotateItem);
  const setMode = useSceneStore((s) => s.setMode);
  const undo = useSceneStore((s) => s.undo);
  const redo = useSceneStore((s) => s.redo);

  const { bounds, wallHeight } = plan;
  const offset: Vec3 = [-(bounds.x + bounds.w / 2), 0, -(bounds.z + bounds.d / 2)];
  const span = Math.max(bounds.w, bounds.d);
  const orbitRef = useRef<any>(null);
  const [viewReq, setViewReq] = useState<{ view: ViewName; seq: number }>({ view: "iso", seq: 0 });
  const [freeCam, setFreeCam] = useState(false);
  const requestView = (view: ViewName) => setViewReq((v) => ({ view, seq: v.seq + 1 }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      const meta = e.ctrlKey || e.metaKey;
      if (meta && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (meta && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        redo();
        return;
      }
      if (typing) return;
      if (e.key === "Escape") {
        clearSelection();
        setMode("select");
      } else if (e.key === "Delete" || e.key === "Backspace") {
        removeSelected();
      } else if ((e.key === "r" || e.key === "R") && selectedId) {
        rotateItem(selectedId, Math.PI / 2);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clearSelection, removeSelected, rotateItem, selectedId, setMode, undo, redo]);

  // Ensure the canvas measures its container once mounted (covers cases where
  // the resize observer doesn't fire on the mount tick).
  useEffect(() => {
    const id = requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <>
      <div className="view-toolbar" aria-label="Camera views">
        <button onClick={() => requestView("top")} title="Look straight down (floor-plan view)">Top</button>
        <button onClick={() => requestView("iso")} title="Isometric view">Iso</button>
        <button onClick={() => requestView("fit")} title="Frame the whole home">Fit</button>
        <button
          className={freeCam ? "active" : ""}
          onClick={() => setFreeCam((v) => !v)}
          title="Free camera: unlock angles; right-drag (or two fingers) to pan the house around the canvas"
        >
          Free
        </button>
      </div>
    <Canvas
      dpr={[1, 2]}
      gl={{ alpha: true, antialias: true }}
      camera={{ position: [span * 1.02, span * 0.94, span * 1.26], fov: 40 }}
    >
      {/* soft studio lighting */}
      <ambientLight intensity={0.7} />
      <hemisphereLight args={["#ffffff", "#8a8475", 0.6]} />
      <directionalLight position={[span, span * 1.7, span * 0.6]} intensity={1.35} />
      <directionalLight position={[-span * 0.8, span, -span * 0.5]} intensity={0.4} />

      {/* soft contact shadow grounds the whole home */}
      <ContactShadows
        position={[0, 0.015, 0]}
        scale={span * 1.8}
        far={span * 1.4}
        blur={2.4}
        opacity={0.45}
        color="#060a0e"
        resolution={1024}
      />

      <group position={offset}>
        <FloorInteractor offset={offset} />
        {/* one grid PER ROOM, so empty (non-room) space shows no grid at all */}
        {plan.rooms.map((r) => (
          <Grid
            key={`grid-${r.id}`}
            position={[r.rect.x + r.rect.w / 2, 0.006, r.rect.z + r.rect.d / 2]}
            args={[r.rect.w, r.rect.d]}
            cellSize={GRID}
            cellColor="#8aa0ad"
            sectionColor="#6b8392"
            sectionSize={GRID * 4}
          />
        ))}
        <FloorPlanView plan={plan} />
        {plan.items.map((it) => (
          <ItemMesh key={it.id} item={it} />
        ))}
        {simActive && <FlowField3D />}
        {sketchRegion && (
          <mesh
            position={[sketchRegion.x + sketchRegion.w / 2, 0.025, sketchRegion.z + sketchRegion.d / 2]}
            rotation={[-Math.PI / 2, 0, 0]}
          >
            <planeGeometry args={[sketchRegion.w, sketchRegion.d]} />
            <meshBasicMaterial color="#2a9d8f" transparent opacity={0.28} depthWrite={false} />
          </mesh>
        )}
      </group>

      <DragController offset={offset} />
      <OpeningDragController offset={offset} />

      <ViewRig seq={viewReq.seq} view={viewReq.view} span={span} wallHeight={wallHeight} orbitRef={orbitRef} />
      <PanelOffset />
      <OrbitControls
        ref={orbitRef}
        makeDefault
        enableDamping
        enablePan
        screenSpacePanning
        minPolarAngle={freeCam ? 0 : 0.1}
        maxPolarAngle={freeCam ? Math.PI - 0.05 : Math.PI / 2 - 0.04}
        target={[0, wallHeight / 3, 0]}
        enabled={!draggingId && !draggingOpeningId && mode === "select"}
      />
    </Canvas>
    </>
  );
}
