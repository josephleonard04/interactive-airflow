import { useState } from "react";
import { useSceneStore, type SimMode } from "../scene/store";
import { evaluateGoal, type Evaluation } from "../intent/evaluate";

// Controls for the in-scene 3D airflow simulation (the field itself renders in the
// 3D house via FlowField3D). Pressing Simulate runs the sim directly on the home
// the user built — no separate 2D view.

export function SimPanel() {
  const plan = useSceneStore((s) => s.plan);
  const active = useSceneStore((s) => s.simActive);
  const mode = useSceneStore((s) => s.simMode);
  const ready = useSceneStore((s) => s.simReady);
  const sourceRoomId = useSceneStore((s) => s.simSourceRoomId);
  const toggleSim = useSceneStore((s) => s.toggleSim);
  const setSimMode = useSceneStore((s) => s.setSimMode);
  const setSource = useSceneStore((s) => s.setSimSource);
  const addItem = useSceneStore((s) => s.addItem);
  const selectItem = useSceneStore((s) => s.selectItem);
  const smellCount = plan.items.filter((it) => it.type === "smell").length;

  const [goal, setGoal] = useState("");
  const [results, setResults] = useState<Evaluation[]>([]);

  // Plain-language goal → physical objectives → checked against the result, and
  // the matching view is shown so the user sees what's happening.
  const checkGoal = () => {
    if (!goal.trim()) return;
    const evals = evaluateGoal(goal, plan);
    setResults(evals);
    const first = evals[0]?.objective;
    if (first) {
      if (first.scalar === "temperature") setSimMode("temperature");
      else { setSimMode("contamination"); if (first.sourceId) setSource(first.sourceId); }
    }
  };

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

      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 4, fontWeight: 600 }}>Ask in plain language</div>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") checkGoal(); }}
            placeholder="e.g. keep my bedroom cool"
            style={{ flex: 1, minWidth: 0, background: "#fff", border: "1px solid var(--line)", borderRadius: 8, padding: "6px 8px", fontSize: 12, color: "var(--text)" }}
          />
          <button className="tool" onClick={checkGoal}>Check</button>
        </div>
        {results.map((r, i) => (
          <p key={i} className="muted-line" style={{ marginTop: 6, color: r.satisfied === null ? "var(--muted)" : r.satisfied ? "#2e7d32" : "#c0392b" }}>
            {r.summary}
          </p>
        ))}
      </div>

      <div className="tools">
        {(["airflow", "temperature", "contamination"] as SimMode[]).map((m) => (
          <button key={m} className={mode === m ? "tool active" : "tool"} onClick={() => setSimMode(m)}>
            {m === "airflow" ? "Airflow" : m === "temperature" ? "Temp" : "Smell"}
          </button>
        ))}
      </div>
      {mode === "contamination" && (
        <div style={{ marginTop: 8 }}>
          <div className="btn-row">
            <button
              className="tool"
              onClick={() => { const id = addItem("smell"); if (id) selectItem(id); }}
            >
              ＋ Place a smell source
            </button>
          </div>
          <p className="muted-line" style={{ marginTop: 4 }}>
            {smellCount > 0
              ? `${smellCount} smell source${smellCount > 1 ? "s" : ""} placed — drag the purple markers where you want.`
              : "Drop one or more purple markers; smell spreads from each."}
          </p>
          <div className="field" style={{ marginTop: 4 }}>
            <span>or whole room</span>
            <select value={sourceRoomId ?? ""} onChange={(e) => setSource(e.target.value || null)} style={{ maxWidth: 140 }}>
              <option value="">(none)</option>
              {plan.rooms.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>
        </div>
      )}
      {!ready && (
        <p className="muted-line" style={{ marginTop: 10, color: "var(--accent-ink)" }}>
          ⏳ Computing the steady state…
        </p>
      )}
      <Legend mode={mode} />
    </div>
  );
}

function Legend({ mode }: { mode: SimMode }) {
  if (mode === "temperature") {
    return (
      <div style={{ marginTop: 10 }}>
        <div style={{ height: 10, borderRadius: 5, background: "linear-gradient(90deg,#3b82f6,#f3eee6,#d9534f)" }} />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--muted)", marginTop: 3 }}>
          <span>Cool</span>
          <span>Warm</span>
        </div>
        <p className="muted-line" style={{ marginTop: 6 }}>Spreads to rooms with an open door; walls &amp; closed doors block it.</p>
      </div>
    );
  }
  if (mode === "contamination") {
    return (
      <p className="muted-line" style={{ marginTop: 10 }}>
        <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 5, background: "#8b3aed", marginRight: 6, verticalAlign: "middle" }} />
        Violet = the smell. It reaches rooms with an open door; closed doors keep it out.
      </p>
    );
  }
  return (
    <p className="muted-line" style={{ marginTop: 10 }}>
      Drifting dots follow the settled airflow — watch where the air moves. AC &amp; fans push it; open windows let it out.
    </p>
  );
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
