import { useRef } from "react";

// A circular rotation dial — drag the handle around the ring to set the yaw.
// Nicer than a left-right slider for an angle. 0° is at the top.
export function RotationDial({ valueRad, onChange }: { valueRad: number; onChange: (rad: number) => void }) {
  const ref = useRef<SVGSVGElement>(null);
  const size = 104;
  const c = size / 2;
  const r = 38;
  const deg = (((valueRad * 180) / Math.PI) % 360 + 360) % 360;
  const a = ((deg - 90) * Math.PI) / 180;
  const hx = c + r * Math.cos(a);
  const hy = c + r * Math.sin(a);
  // arrowhead just past the handle, showing the way the air blows
  const ux = Math.cos(a), uy = Math.sin(a);
  const tip = [c + (r + 12) * ux, c + (r + 12) * uy];
  const b1 = [hx - uy * 6, hy + ux * 6];
  const b2 = [hx + uy * 6, hy - ux * 6];

  const update = (e: React.PointerEvent) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left - c;
    const y = e.clientY - rect.top - c;
    let d = (Math.atan2(y, x) * 180) / Math.PI + 90;
    d = (d % 360 + 360) % 360;
    onChange((d * Math.PI) / 180);
  };

  return (
    <div className="dial-wrap">
      <svg
        ref={ref}
        width={size}
        height={size}
        className="dial"
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture?.(e.pointerId);
          update(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons) update(e);
        }}
      >
        <circle cx={c} cy={c} r={r} className="dial-track" />
        <line x1={c} y1={c} x2={hx} y2={hy} className="dial-needle" />
        <polygon points={`${tip[0]},${tip[1]} ${b1[0]},${b1[1]} ${b2[0]},${b2[1]}`} className="dial-handle" />
        <circle cx={hx} cy={hy} r={9} className="dial-handle" />
        <text x={c} y={c + 5} textAnchor="middle" className="dial-label">
          {Math.round(deg)}°
        </text>
      </svg>
      <span className="dial-cap">horizontal aim — arrow = way it blows</span>
    </div>
  );
}
