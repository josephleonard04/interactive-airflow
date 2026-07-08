import { useRef, useState } from "react";
import type { Rect } from "../floorplan/types";
import { useSceneStore } from "../scene/store";
import { ROOM_COLOR } from "../floorplan/palette";

// A small top-down mini-map of the home where the user DRAWS the area a goal
// refers to ("keep this area cool"). Drag = box; click = a ~0.8 m spot. The
// sketched region grounds deictic goals and is highlighted in the 3D view.

const MAX_W = 258;
const MAX_H = 190;

export function SketchCanvas() {
  const plan = useSceneStore((s) => s.plan);
  const region = useSceneStore((s) => s.sketchRegion);
  const setRegion = useSceneStore((s) => s.setSketchRegion);
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ x0: number; z0: number; x1: number; z1: number } | null>(null);

  const { bounds } = plan;
  const scale = Math.min(MAX_W / bounds.w, MAX_H / bounds.d);
  const W = bounds.w * scale;
  const H = bounds.d * scale;

  const toWorld = (e: React.PointerEvent): [number, number] => {
    const r = svgRef.current!.getBoundingClientRect();
    const x = bounds.x + Math.max(0, Math.min(W, e.clientX - r.left)) / scale;
    const z = bounds.z + Math.max(0, Math.min(H, e.clientY - r.top)) / scale;
    return [x, z];
  };

  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const [x, z] = toWorld(e);
    setDrag({ x0: x, z0: z, x1: x, z1: z });
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const [x, z] = toWorld(e);
    setDrag({ ...drag, x1: x, z1: z });
  };
  const onUp = () => {
    if (!drag) return;
    let x = Math.min(drag.x0, drag.x1);
    let z = Math.min(drag.z0, drag.z1);
    let w = Math.abs(drag.x1 - drag.x0);
    let d = Math.abs(drag.z1 - drag.z0);
    if (w < 0.3 || d < 0.3) {
      // a click marks a ~0.8 m spot
      x = (drag.x0 + drag.x1) / 2 - 0.4;
      z = (drag.z0 + drag.z1) / 2 - 0.4;
      w = 0.8;
      d = 0.8;
    }
    setRegion({ x, z, w, d });
    setDrag(null);
  };

  const px = (r: Rect) => ({
    x: (r.x - bounds.x) * scale,
    y: (r.z - bounds.z) * scale,
    w: r.w * scale,
    h: r.d * scale,
  });
  const preview: Rect | null = drag
    ? {
        x: Math.min(drag.x0, drag.x1),
        z: Math.min(drag.z0, drag.z1),
        w: Math.abs(drag.x1 - drag.x0),
        d: Math.abs(drag.z1 - drag.z0),
      }
    : null;

  return (
    <div>
      <svg
        ref={svgRef}
        width={W}
        height={H}
        style={{ display: "block", border: "1px solid var(--line)", borderRadius: 8, background: "#fff", cursor: "crosshair", touchAction: "none" }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
      >
        {plan.rooms.map((r) => {
          const p = px(r.rect);
          return (
            <g key={r.id}>
              <rect x={p.x} y={p.y} width={p.w} height={p.h}
                fill={ROOM_COLOR[r.type] ?? "#eee"} fillOpacity={0.35}
                stroke="var(--line)" strokeWidth={1} />
              <text x={p.x + p.w / 2} y={p.y + p.h / 2} textAnchor="middle" dominantBaseline="middle"
                fontSize={9} fill="var(--muted)" pointerEvents="none">
                {r.name}
              </text>
            </g>
          );
        })}
        {(preview ?? region) && (() => {
          const p = px((preview ?? region)!);
          return (
            <rect x={p.x} y={p.y} width={p.w} height={p.h}
              fill="#2a9d8f" fillOpacity={0.3} stroke="#2a9d8f" strokeWidth={1.5} rx={3} />
          );
        })()}
      </svg>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 5 }}>
        <span className="muted-line" style={{ margin: 0, flex: 1 }}>
          {region ? "Now say e.g. “keep this area cool”." : "Drag a box (or click a spot) to mark an area."}
        </span>
        {region && (
          <button className="ghost" style={{ fontSize: 11 }} onClick={() => setRegion(null)}>
            ✕ Clear
          </button>
        )}
      </div>
    </div>
  );
}
