import { useRef, useState } from "react";
import type { Rect, Vec2 } from "../floorplan/types";
import { useSceneStore } from "../scene/store";
import { ROOM_COLOR } from "../floorplan/palette";
import {
  INTENT_COLOR,
  INTENT_LABEL,
  TOOL_COLOR,
  areaRoom,
  nextMarkId,
  sketchToGoal,
  type SketchIntent,
  type SketchTool,
} from "../intent/sketch";

// A top-down mini-map of the home the user DRAWS on to state what they want.
//
// A box on its own says "somewhere around here" and nothing else, so the pen
// carries the meaning: pick warm / cool / fresh air / no wind, then draw
// where you mean it. The arrow pen is a different kind of statement — not "make
// this room X" but "move the air this way, from here to there" — which is
// exactly the sentence people reach for and the clumsiest one to type.
//
// Drag = box (or arrow). Click = a ~0.8 m spot.

const MAX_W = 258;
const MAX_H = 190;

const TOOLS: Array<{ id: SketchTool; label: string; hint: string }> = [
  // First, because it is the one that needs no decision: box the place you mean
  // and say the rest in words. The four wishes below are the shortcuts.
  { id: "plain", label: "▢ Just an area", hint: "Box an area, then type what you want there" },
  { id: "warm", label: "🔥 Warm", hint: "Box the area you want warmer" },
  { id: "cool", label: "❄️ Cool", hint: "Box the area you want cooler" },
  { id: "fresh", label: "🌬️ Fresh air", hint: "Box the area you want aired out" },
  { id: "nodraft", label: "🚫 No wind", hint: "Box the area where you do not want air blowing on you" },
  { id: "arrow", label: "➜ Air flow", hint: "Drag an arrow: move air from here to there" },
];

export function SketchCanvas() {
  const plan = useSceneStore((s) => s.plan);
  const marks = useSceneStore((s) => s.sketchMarks);
  const tool = useSceneStore((s) => s.sketchTool);
  const setTool = useSceneStore((s) => s.setSketchTool);
  const addMark = useSceneStore((s) => s.addSketchMark);
  const removeMark = useSceneStore((s) => s.removeSketchMark);
  const clearSketch = useSceneStore((s) => s.clearSketch);
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ x0: number; z0: number; x1: number; z1: number } | null>(null);

  const { bounds } = plan;
  const scale = Math.min(MAX_W / bounds.w, MAX_H / bounds.d);
  const W = bounds.w * scale;
  const H = bounds.d * scale;

  const toWorld = (e: React.PointerEvent): Vec2 => {
    const r = svgRef.current!.getBoundingClientRect();
    return [
      bounds.x + Math.max(0, Math.min(W, e.clientX - r.left)) / scale,
      bounds.z + Math.max(0, Math.min(H, e.clientY - r.top)) / scale,
    ];
  };

  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    // Capture keeps the drag alive if the pointer leaves the little map. It
    // throws when the pointer id isn't active, which must not take the whole
    // stroke down with it.
    try {
      (e.target as Element).setPointerCapture?.(e.pointerId);
    } catch {
      /* not capturable — the drag still works, it just ends at the edge */
    }
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
    const dx = Math.abs(drag.x1 - drag.x0);
    const dz = Math.abs(drag.z1 - drag.z0);
    if (tool === "arrow") {
      // An arrow needs two distinct ends to mean anything; a stray click is not
      // a direction, so it is dropped rather than turned into a zero-length one.
      if (Math.hypot(dx, dz) > 0.6) {
        addMark({ id: nextMarkId(), kind: "arrow", from: [drag.x0, drag.z0], to: [drag.x1, drag.z1] });
      }
    } else {
      let x = Math.min(drag.x0, drag.x1);
      let z = Math.min(drag.z0, drag.z1);
      let w = dx;
      let d = dz;
      if (w < 0.3 || d < 0.3) {
        // a click marks a ~0.8 m spot
        x = (drag.x0 + drag.x1) / 2 - 0.4;
        z = (drag.z0 + drag.z1) / 2 - 0.4;
        w = 0.8;
        d = 0.8;
      }
      addMark({ id: nextMarkId(), kind: "area", intent: tool as SketchIntent, rect: { x, z, w, d } });
    }
    setDrag(null);
  };

  const px = (r: Rect) => ({
    x: (r.x - bounds.x) * scale,
    y: (r.z - bounds.z) * scale,
    w: r.w * scale,
    h: r.d * scale,
  });
  const pt = (p: Vec2) => [(p[0] - bounds.x) * scale, (p[1] - bounds.z) * scale] as const;

  const previewRect: Rect | null =
    drag && tool !== "arrow"
      ? {
          x: Math.min(drag.x0, drag.x1),
          z: Math.min(drag.z0, drag.z1),
          w: Math.abs(drag.x1 - drag.x0),
          d: Math.abs(drag.z1 - drag.z0),
        }
      : null;

  const reading = sketchToGoal(marks, plan);

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
        {TOOLS.map((t) => (
          <button
            key={t.id}
            className={tool === t.id ? "tool active" : "tool"}
            style={{
              fontSize: 11,
              padding: "3px 8px",
              borderColor: tool === t.id ? TOOL_COLOR(t.id) : undefined,
              color: tool === t.id ? TOOL_COLOR(t.id) : undefined,
            }}
            title={t.hint}
            onClick={() => setTool(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <svg
        ref={svgRef}
        width={W}
        height={H}
        style={{
          display: "block",
          border: "1px solid var(--line)",
          borderRadius: 8,
          background: "#fff",
          cursor: "crosshair",
          touchAction: "none",
        }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
      >
        <defs>
          <marker id="sketch-arrowhead" markerWidth="7" markerHeight="7" refX="5.5" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 z" fill="#5b6470" />
          </marker>
        </defs>

        {plan.rooms.map((r) => {
          const p = px(r.rect);
          return (
            <g key={r.id}>
              <rect
                x={p.x}
                y={p.y}
                width={p.w}
                height={p.h}
                fill={ROOM_COLOR[r.type] ?? "#eee"}
                fillOpacity={0.35}
                stroke="var(--line)"
                strokeWidth={1}
              />
              <text
                x={p.x + p.w / 2}
                y={p.y + p.h / 2}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize={9}
                fill="var(--muted)"
                pointerEvents="none"
              >
                {r.name}
              </text>
            </g>
          );
        })}

        {marks.map((m) => {
          if (m.kind === "area") {
            const p = px(m.rect);
            const c = INTENT_COLOR[m.intent];
            return (
              <g key={m.id} pointerEvents="none">
                <rect x={p.x} y={p.y} width={p.w} height={p.h} fill={c} fillOpacity={0.26} stroke={c} strokeWidth={1.5} rx={3} />
                <text x={p.x + p.w / 2} y={p.y + p.h / 2} textAnchor="middle" dominantBaseline="middle" fontSize={8.5} fill={c} fontWeight={700}>
                  {INTENT_LABEL[m.intent]}
                </text>
              </g>
            );
          }
          const [ax, ay] = pt(m.from);
          const [bx, by] = pt(m.to);
          return (
            <g key={m.id} pointerEvents="none">
              <line x1={ax} y1={ay} x2={bx} y2={by} stroke="#5b6470" strokeWidth={2} markerEnd="url(#sketch-arrowhead)" />
              <circle cx={ax} cy={ay} r={2.5} fill="#5b6470" />
            </g>
          );
        })}

        {previewRect && (() => {
          const p = px(previewRect);
          const c = TOOL_COLOR(tool);
          return <rect x={p.x} y={p.y} width={p.w} height={p.h} fill={c} fillOpacity={0.2} stroke={c} strokeWidth={1.5} rx={3} />;
        })()}
        {drag && tool === "arrow" && (() => {
          const [ax, ay] = pt([drag.x0, drag.z0]);
          const [bx, by] = pt([drag.x1, drag.z1]);
          return <line x1={ax} y1={ay} x2={bx} y2={by} stroke="#5b6470" strokeWidth={2} markerEnd="url(#sketch-arrowhead)" />;
        })()}
      </svg>

      {marks.length > 0 ? (
        <div style={{ marginTop: 6, display: "grid", gap: 3 }}>
          {marks.map((m) => (
            <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5 }}>
              <span
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: 2,
                  flex: "0 0 auto",
                  background: m.kind === "area" ? INTENT_COLOR[m.intent] : "#5b6470",
                }}
              />
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {m.kind === "area"
                  ? `${INTENT_LABEL[m.intent]} — ${areaRoom(plan, m.rect)?.name ?? "the area you drew"}`
                  : "Air flow arrow"}
              </span>
              <button className="ghost" style={{ fontSize: 11 }} onClick={() => removeMark(m.id)} title="Remove this mark">
                ✕
              </button>
            </div>
          ))}
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
            <span className="muted-line" style={{ margin: 0, flex: 1 }}>
              {/* A plain box has nothing to read yet, and "Reads as: —" looks
                  like a failure rather than a half-finished sentence. */}
              {reading ? `Reads as: ${reading.text}` : "Now say what you want there, below."}
            </span>
            <button className="ghost" style={{ fontSize: 11 }} onClick={clearSketch}>
              Clear all
            </button>
          </div>
        </div>
      ) : (
        <p className="muted-line" style={{ marginTop: 5 }}>
          Drag a box over the area you mean, then type what you want there — or pick one of the
          four wishes instead, or drag an arrow from one room to another.
        </p>
      )}
    </div>
  );
}
