import { useEffect } from "react";
import { useSceneStore, type SimMode } from "../scene/store";

// Controls for the in-scene 3D airflow simulation (the field itself renders in the
// 3D house via FlowField3D). Pressing Simulate runs the sim directly on the home
// the user built — no separate 2D view.

export function SimPanel() {
  const plan = useSceneStore((s) => s.plan);
  const active = useSceneStore((s) => s.simActive);
  const mode = useSceneStore((s) => s.simMode);
  const paused = useSceneStore((s) => s.simPaused);
  const sourceRoomId = useSceneStore((s) => s.simSourceRoomId);
  const toggleSim = useSceneStore((s) => s.toggleSim);
  const setSimMode = useSceneStore((s) => s.setSimMode);
  const togglePause = useSceneStore((s) => s.toggleSimPause);
  const setSource = useSceneStore((s) => s.setSimSource);

  // default the smell source to the kitchen the first time
  useEffect(() => {
    if (active && sourceRoomId == null) {
      const def = plan.rooms.find((r) => r.type === "kitchen") ?? plan.rooms[0];
      if (def) setSource(def.id);
    }
  }, [active, sourceRoomId, plan.rooms, setSource]);

  if (!active) {
    return (
      <button className="primary" style={btn} onClick={toggleSim}>
        ▶ Simulate airflow
      </button>
    );
  }

  return (
    <div style={panel}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <strong style={{ fontSize: 13 }}>Airflow simulation</strong>
        <button className="ghost" onClick={toggleSim}>✕</button>
      </div>
      <div className="tools">
        {(["airflow", "temperature", "contamination"] as SimMode[]).map((m) => (
          <button key={m} className={mode === m ? "tool active" : "tool"} onClick={() => setSimMode(m)}>
            {m === "airflow" ? "Airflow" : m === "temperature" ? "Temp" : "Smell"}
          </button>
        ))}
      </div>
      {mode === "contamination" && (
        <div className="field" style={{ marginTop: 8 }}>
          <span>Smell source</span>
          <select value={sourceRoomId ?? ""} onChange={(e) => setSource(e.target.value || null)} style={{ maxWidth: 150 }}>
            <option value="">(none)</option>
            {plan.rooms.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </div>
      )}
      <div className="btn-row">
        <button className={paused ? "tool" : "tool active"} onClick={togglePause}>
          {paused ? "Play" : "Pause"}
        </button>
      </div>
      <p className="muted-line">{legend(mode)}</p>
    </div>
  );
}

function legend(mode: SimMode): string {
  if (mode === "temperature") return "Blue = cold · red = warm (warm air rises). Add a heater or AC.";
  if (mode === "contamination") return "Violet = the smell. Open a window/door so it can leave.";
  return "Darts show airflow — AC & fans push air; open windows/doors let it leave.";
}

const btn: React.CSSProperties = { position: "absolute", top: 14, right: 14, zIndex: 10 };
const panel: React.CSSProperties = {
  position: "absolute",
  top: 14,
  right: 14,
  zIndex: 10,
  width: 250,
  background: "var(--panel)",
  border: "1px solid var(--line)",
  borderRadius: 14,
  padding: 14,
  boxShadow: "0 12px 30px rgba(120,90,50,0.18)",
};
