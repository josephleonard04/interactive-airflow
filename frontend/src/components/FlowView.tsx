import { useEffect, useMemo, useRef, useState } from "react";
import { buildSlice } from "../sim/sceneSlice";
import { useSceneStore } from "../scene/store";

// A self-contained top-down "airflow" panel overlaid on the viewport. Builds a 2D
// Euler slice from the current home and animates it in one of three modes:
//   - airflow      : flow-direction arrows coloured by speed
//   - temperature  : hot (red) vs cold (blue), driven by heater / AC
//   - contamination: a tracer (violet) from a chosen room — does the smell spread?
// Runs in the browser, no GPU.

const DISPLAY_W = 340;
type Mode = "airflow" | "temperature" | "contamination";

export function FlowView() {
  const plan = useSceneStore((s) => s.plan);
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(true);
  const [mode, setMode] = useState<Mode>("airflow");
  const [sourceRoom, setSourceRoom] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const offRef = useRef<HTMLCanvasElement | null>(null);

  const slice = useMemo(() => (open ? buildSlice(plan) : null), [plan, open, resetKey]);

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
    const sx = DISPLAY_W / nx;
    const sy = H / ny;

    // fixed arrow grid + temporal smoothing so arrows show direction steadily
    const di = Math.max(2, Math.round(22 / sx));
    const samples: Array<[number, number]> = [];
    for (let j = di >> 1; j < ny; j += di) for (let i = di >> 1; i < nx; i += di) samples.push([i, j]);
    const emaU = new Float32Array(samples.length);
    const emaV = new Float32Array(samples.length);
    let emaMax = 0.5;
    const aLen = di * sx * 0.55; // constant arrow length (direction only)

    let raf = 0;
    const draw = () => {
      if (running) for (let k = 0; k < 2; k++) sim.step(0.05);
      const spd = sim.speedField();
      let smax = 1e-6;
      for (const v of spd) if (v > smax) smax = v;

      for (let c = 0; c < nx * ny; c++) {
        const o = c * 4;
        data[o + 3] = 255;
        if (sim.solid[c]) {
          data[o] = 90; data[o + 1] = 74; data[o + 2] = 54;
          continue;
        }
        if (sim.open[c]) {
          data[o] = 198; data[o + 1] = 224; data[o + 2] = 240; // openings: faint sky
          continue;
        }
        if (mode === "temperature") {
          const t = clamp(sim.temp[c] / 12, -1, 1); // ±12 K scale
          if (t >= 0) {
            data[o] = lerp(245, 217, t); data[o + 1] = lerp(242, 83, t); data[o + 2] = lerp(235, 79, t);
          } else {
            const a = -t;
            data[o] = lerp(245, 59, a); data[o + 1] = lerp(242, 130, a); data[o + 2] = lerp(235, 246, a);
          }
        } else if (mode === "contamination") {
          const s = Math.min(1, sim.s[c]); // violet tracer (not red)
          data[o] = lerp(250, 124, s); data[o + 1] = lerp(248, 58, s); data[o + 2] = lerp(240, 237, s);
        } else {
          const sp = spd[c] / smax; // airflow: faint speed wash
          data[o] = lerp(250, 196, sp); data[o + 1] = lerp(248, 222, sp); data[o + 2] = lerp(240, 244, sp);
        }
      }
      octx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(off, 0, 0, DISPLAY_W, H);

      // flow arrows: fixed length + EMA-smoothed direction → steady, no jitter
      let curMax = 1e-6;
      for (let k = 0; k < samples.length; k++) {
        const [i, j] = samples[k];
        const [uc, vc] = sim.velocityAt(i, j);
        emaU[k] += 0.06 * (uc - emaU[k]);
        emaV[k] += 0.06 * (vc - emaV[k]);
        const m = Math.hypot(emaU[k], emaV[k]);
        if (m > curMax) curMax = m;
      }
      emaMax += 0.05 * (curMax - emaMax);
      for (let k = 0; k < samples.length; k++) {
        const [i, j] = samples[k];
        const c = sim.cIdx(i, j);
        if (sim.solid[c] || sim.open[c]) continue;
        const eu = emaU[k];
        const ev = emaV[k];
        const m = Math.hypot(eu, ev);
        if (m < emaMax * 0.08) continue;
        const t = Math.min(1, m / (emaMax + 1e-6));
        const cx = (i + 0.5) * sx;
        const cy = (j + 0.5) * sy;
        const col =
          mode === "airflow"
            ? `rgb(${lerp(150, 30, t) | 0},${lerp(170, 90, t) | 0},${lerp(190, 160, t) | 0})`
            : "rgba(60,50,40,0.6)";
        arrow(ctx, cx, cy, (eu / m) * aLen, (ev / m) * aLen, col);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [slice, open, running, mode]);

  if (!open) {
    return (
      <button className="primary" style={overlayBtn} onClick={() => setOpen(true)}>
        ▶ Simulate airflow
      </button>
    );
  }

  const noTemp = mode === "temperature" && slice && !slice.hasTemperature;

  return (
    <div style={overlayPanel}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <strong style={{ fontSize: 13 }}>Airflow (top-down)</strong>
        <button className="ghost" onClick={() => setOpen(false)}>✕</button>
      </div>

      <div className="tools" style={{ marginBottom: 8 }}>
        {(["airflow", "temperature", "contamination"] as Mode[]).map((m) => (
          <button key={m} className={mode === m ? "tool active" : "tool"} onClick={() => setMode(m)}>
            {m === "airflow" ? "Airflow" : m === "temperature" ? "Temp" : "Smell"}
          </button>
        ))}
      </div>

      <canvas ref={canvasRef} style={{ width: DISPLAY_W, borderRadius: 10, border: "1px solid var(--line)", display: "block" }} />

      {mode === "contamination" && (
        <div className="field" style={{ marginTop: 8 }}>
          <span>Smell source</span>
          <select value={sourceRoom ?? ""} onChange={(e) => setSourceRoom(e.target.value || null)} style={{ maxWidth: 150 }}>
            <option value="">(none)</option>
            {plan.rooms.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </div>
      )}

      <div className="btn-row">
        <button className={running ? "tool active" : "tool"} onClick={() => setRunning((r) => !r)}>
          {running ? "Pause" : "Play"}
        </button>
        <button className="tool" onClick={() => setResetKey((k) => k + 1)}>Reset</button>
      </div>

      <p className="muted-line">{legend(mode, !!noTemp)}</p>
    </div>
  );
}

function legend(mode: Mode, noTemp: boolean): string {
  if (mode === "temperature")
    return noTemp ? "Add a heater or AC to see hot/cold." : "Blue = cold · red = warm. Arrows = airflow.";
  if (mode === "contamination") return "Violet = the tracer. Open a window/door so it can move out.";
  return "Arrows show airflow — AC & fans push air; open windows/doors let it leave.";
}

function arrow(ctx: CanvasRenderingContext2D, x: number, y: number, dx: number, dy: number, color: string): void {
  const hx = x + dx / 2;
  const hy = y + dy / 2;
  const a = Math.atan2(dy, dx);
  const hl = 4;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.moveTo(x - dx / 2, y - dy / 2);
  ctx.lineTo(hx, hy);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(hx, hy);
  ctx.lineTo(hx - hl * Math.cos(a - 0.5), hy - hl * Math.sin(a - 0.5));
  ctx.lineTo(hx - hl * Math.cos(a + 0.5), hy - hl * Math.sin(a + 0.5));
  ctx.closePath();
  ctx.fill();
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

const overlayBtn: React.CSSProperties = { position: "absolute", top: 14, right: 14, zIndex: 10 };
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
