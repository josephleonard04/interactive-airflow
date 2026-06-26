import { useEffect, useMemo, useRef, useState } from "react";
import { buildSlice } from "../sim/sceneSlice";
import { useSceneStore } from "../scene/store";

// A self-contained top-down "airflow" panel overlaid on the viewport. Builds a 2D
// Euler slice from the current home and animates it: contaminant (red) advected by
// the vent-driven flow, arrows for direction, solids in brown. The marquee demo —
// pick the kitchen as the smell source, open a window, watch where the air carries
// it. Runs in the browser, no GPU.

const DISPLAY_W = 340;

export function FlowView() {
  const plan = useSceneStore((s) => s.plan);
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(true);
  const [sourceRoom, setSourceRoom] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const offRef = useRef<HTMLCanvasElement | null>(null);

  const slice = useMemo(() => (open ? buildSlice(plan) : null), [plan, open, resetKey]);

  // default the contaminant source to the kitchen if present
  useEffect(() => {
    if (!slice) return;
    const def = plan.rooms.find((r) => r.type === "kitchen") ?? plan.rooms[0];
    setSourceRoom((cur) => cur ?? def?.id ?? null);
  }, [slice, plan.rooms]);

  useEffect(() => {
    if (!slice) return;
    const room = plan.rooms.find((r) => r.id === sourceRoom);
    slice.setSource(room ? room.rect : null);
  }, [slice, sourceRoom, plan.rooms]);

  useEffect(() => {
    if (!slice || !open) return;
    const { sim, nx, ny } = slice;
    const display = canvasRef.current!;
    const H = Math.round((DISPLAY_W * ny) / nx);
    display.width = DISPLAY_W;
    display.height = H;
    const ctx = display.getContext("2d")!;
    if (!offRef.current) offRef.current = document.createElement("canvas");
    const off = offRef.current;
    off.width = nx;
    off.height = ny;
    const octx = off.getContext("2d")!;
    const img = octx.createImageData(nx, ny);
    const data = img.data;

    let raf = 0;
    const draw = () => {
      if (running) for (let k = 0; k < 2; k++) sim.step(0.05);
      const spd = sim.speedField();
      let smax = 1e-6;
      for (const v of spd) if (v > smax) smax = v;

      for (let c = 0; c < nx * ny; c++) {
        const o = c * 4;
        if (sim.solid[c]) {
          data[o] = 90; data[o + 1] = 74; data[o + 2] = 54; data[o + 3] = 255;
          continue;
        }
        const s = Math.min(1, sim.s[c]); // contaminant 0..1
        const sp = spd[c] / smax; // normalized speed 0..1
        // lerp warm panel (250,248,240) -> contaminant red (217,83,79), brighten faintly by speed
        data[o] = clamp255(lerp(250, 217, s) + sp * 5);
        data[o + 1] = clamp255(lerp(248, 83, s) - sp * 8);
        data[o + 2] = clamp255(lerp(240, 79, s) - sp * 4);
        data[o + 3] = 255;
      }
      octx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(off, 0, 0, DISPLAY_W, H);

      // flow arrows
      const step = Math.max(2, Math.floor(nx / 22));
      const sx = DISPLAY_W / nx;
      const sy = H / ny;
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(74,63,51,0.5)";
      for (let j = step >> 1; j < ny; j += step) {
        for (let i = step >> 1; i < nx; i += step) {
          if (sim.solid[sim.cIdx(i, j)]) continue;
          const uc = 0.5 * (sim.u[sim.uIdx(i, j)] + sim.u[sim.uIdx(i + 1, j)]);
          const vc = 0.5 * (sim.v[sim.vIdx(i, j)] + sim.v[sim.vIdx(i, j + 1)]);
          const m = Math.hypot(uc, vc);
          if (m < smax * 0.04) continue;
          const f = (step * 0.45) * Math.min(1, m / smax);
          const cx = (i + 0.5) * sx;
          const cy = (j + 0.5) * sy;
          ctx.beginPath();
          ctx.moveTo(cx - (uc / m) * f * sx, cy - (vc / m) * f * sy);
          ctx.lineTo(cx + (uc / m) * f * sx, cy + (vc / m) * f * sy);
          ctx.stroke();
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [slice, open, running]);

  if (!open) {
    return (
      <button className="primary" style={overlayBtn} onClick={() => setOpen(true)}>
        ▶ Simulate airflow
      </button>
    );
  }

  return (
    <div style={overlayPanel}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <strong style={{ fontSize: 13 }}>Airflow (top-down)</strong>
        <button className="ghost" onClick={() => setOpen(false)}>✕</button>
      </div>
      <canvas ref={canvasRef} style={{ width: DISPLAY_W, borderRadius: 10, border: "1px solid var(--line)", display: "block" }} />
      <div className="field" style={{ marginTop: 8 }}>
        <span>Smell source</span>
        <select value={sourceRoom ?? ""} onChange={(e) => setSourceRoom(e.target.value || null)} style={{ maxWidth: 150 }}>
          <option value="">(none)</option>
          {plan.rooms.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
      </div>
      <div className="btn-row">
        <button className={running ? "tool active" : "tool"} onClick={() => setRunning((r) => !r)}>
          {running ? "Pause" : "Play"}
        </button>
        <button className="tool" onClick={() => setResetKey((k) => k + 1)}>Reset</button>
      </div>
      <p className="muted-line">Red = contaminant · arrows = airflow. Open a window so the air can leave.</p>
    </div>
  );
}

function clamp255(x: number): number {
  return x < 0 ? 0 : x > 255 ? 255 : x | 0;
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

const overlayBtn: React.CSSProperties = {
  position: "absolute",
  top: 14,
  right: 14,
  zIndex: 10,
};

const overlayPanel: React.CSSProperties = {
  position: "absolute",
  top: 14,
  right: 14,
  zIndex: 10,
  width: DISPLAY_W + 28,
  background: "var(--panel)",
  border: "1px solid var(--line)",
  borderRadius: 14,
  padding: 14,
  boxShadow: "0 12px 30px rgba(120,90,50,0.18)",
};
