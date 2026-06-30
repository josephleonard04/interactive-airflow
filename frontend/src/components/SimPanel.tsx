import { useEffect, useState } from "react";
import { useSceneStore, PRESETS, type SimMode, type SimEngine, type AirflowPreset } from "../scene/store";
import { evaluateGoal, type Evaluation } from "../intent/evaluate";

const PRESET_IDS = Object.keys(PRESETS) as AirflowPreset[];

const INTENT_TEMPLATES = [
  "Keep my bedroom cool",
  "Keep the kitchen smell out of the bedroom",
  "Warm up the living room",
];

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
  const engine = useSceneStore((s) => s.engine);
  const accurate = useSceneStore((s) => s.accurate);
  const accurateRunning = useSceneStore((s) => s.accurateRunning);
  const accurateHealth = useSceneStore((s) => s.accurateHealth);
  const setEngine = useSceneStore((s) => s.setEngine);
  const runAccurate = useSceneStore((s) => s.runAccurate);
  const refreshAccurateHealth = useSceneStore((s) => s.refreshAccurateHealth);
  const applyAirflowPreset = useSceneStore((s) => s.applyAirflowPreset);
  const smellCount = plan.items.filter((it) => it.type === "smell").length;

  useEffect(() => {
    if (engine === "openfoam") refreshAccurateHealth();
  }, [engine, refreshAccurateHealth]);

  const [goal, setGoal] = useState("");
  const [results, setResults] = useState<Evaluation[]>([]);

  // Plain-language goal → physical objectives → checked against the result, and
  // the matching view is shown so the user sees what's happening.
  const checkGoalText = (text: string) => {
    if (!text.trim()) return;
    const evals = evaluateGoal(text, plan);
    setResults(evals);
    const first = evals[0]?.objective;
    if (first) {
      if (first.scalar === "temperature") setSimMode("temperature");
      else { setSimMode("contamination"); if (first.sourceId) setSource(first.sourceId); }
    }
  };
  const checkGoal = () => checkGoalText(goal);

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

      <div style={{ display: "flex", gap: 4, marginBottom: 10, background: "#eef0ea", borderRadius: 8, padding: 3 }}>
        {(["realtime", "openfoam"] as SimEngine[]).map((e) => (
          <button
            key={e}
            className={engine === e ? "tool active" : "tool"}
            style={{ flex: 1 }}
            onClick={() => setEngine(e)}
            title={e === "realtime" ? "Live in-browser solver" : "Accurate OpenFOAM CFD (runs on the local backend)"}
          >
            {e === "realtime" ? "⚡ Real-time" : "🧪 Accurate"}
          </button>
        ))}
      </div>

      {engine === "openfoam" && (
        <div style={{ marginBottom: 12, padding: 10, borderRadius: 10, background: "#f7f5ef", border: "1px solid var(--line)" }}>
          <button className="primary" style={{ width: "100%" }} disabled={accurateRunning} onClick={runAccurate}>
            {accurateRunning ? "Running CFD…" : accurate ? "↻ Re-run accurate (OpenFOAM)" : "▶ Run accurate (OpenFOAM)"}
          </button>
          {accurate && (
            <div style={{ marginTop: 8 }}>
              <span
                style={{
                  display: "inline-block",
                  padding: "2px 8px",
                  borderRadius: 999,
                  fontSize: 10.5,
                  fontWeight: 700,
                  background: accurate.status === "ok" ? "#def3ed" : accurate.status === "mock" ? "#fdf0d8" : "#fadbd8",
                  color: accurate.status === "ok" ? "#146a5f" : accurate.status === "mock" ? "#9a6a16" : "#a23226",
                }}
              >
                {accurate.status === "ok" ? "CFD result" : accurate.status === "mock" ? "preview (no OpenFOAM)" : "error"}
              </span>
              {accurate.message && <p className="muted-line" style={{ marginTop: 6 }}>{accurate.message}</p>}
              <p className="muted-line" style={{ marginTop: 6 }}>
                Flux balance: {accurate.balance.inflow.toFixed(2)} in / {accurate.balance.outflow.toFixed(2)} out m³/s
                {accurate.balance.balanced ? " ✓" : " ⚠"}
              </p>
              {accurate.balance.note && <p className="muted-line" style={{ marginTop: 4, color: "#9a6a16" }}>{accurate.balance.note}</p>}
              {accurate.seconds != null && (
                <p className="muted-line" style={{ marginTop: 4 }}>
                  {accurate.status === "ok" ? "Solved" : "Computed"} in {accurate.seconds}s
                </p>
              )}
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 10, fontSize: 11, color: "var(--muted)" }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                background: accurateHealth?.reachable ? (accurateHealth.openfoam ? "#2a9d8f" : "#d9a514") : "#c0392b",
              }}
            />
            {accurateHealth == null
              ? "Checking backend…"
              : !accurateHealth.reachable
                ? "Backend offline — run backend\\run.ps1"
                : accurateHealth.openfoam
                  ? `Backend online · OpenFOAM ready${accurateHealth.version ? ` (${accurateHealth.version})` : ""}`
                  : "Backend online · OpenFOAM not installed (preview)"}
          </div>
        </div>
      )}

      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 4, fontWeight: 600 }}>Quick presets</div>
        <div className="chips">
          {PRESET_IDS.map((id) => (
            <button key={id} className="chip" onClick={() => applyAirflowPreset(id)} title={PRESETS[id].hint}>
              {PRESETS[id].label}
            </button>
          ))}
        </div>
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
        <div className="chips" style={{ marginTop: 6 }}>
          {INTENT_TEMPLATES.map((t) => (
            <button key={t} className="chip" style={{ fontSize: 11 }} onClick={() => { setGoal(t); checkGoalText(t); }}>
              {t}
            </button>
          ))}
        </div>
        {results.map((r, i) => (
          <div
            key={i}
            style={{
              marginTop: 8,
              padding: "8px 10px",
              borderRadius: 9,
              border: "1px solid var(--line)",
              background: "#fff",
              borderLeft: `3px solid ${r.satisfied === null ? "var(--muted)" : r.satisfied ? "#2a9d8f" : "#c0392b"}`,
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 700, color: r.satisfied === null ? "var(--muted)" : r.satisfied ? "#156d63" : "#c0392b" }}>
              {r.summary}
            </span>
          </div>
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
        <div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600, marginBottom: 4 }}>Air temperature</div>
        <div style={{ height: 11, borderRadius: 6, background: "linear-gradient(90deg,#1f5fe0,#bcd0f0,#f4efe8,#f0a06a,#d63b22)" }} />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--muted)", marginTop: 3 }}>
          <span>Cooler</span>
          <span>Warmer</span>
        </div>
        <p className="muted-line" style={{ marginTop: 6 }}>Carried by the airflow; reaches rooms with an open door, blocked by walls.</p>
      </div>
    );
  }
  if (mode === "contamination") {
    return (
      <div style={{ marginTop: 10 }}>
        <div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600, marginBottom: 4 }}>Contaminant concentration</div>
        <div style={{ height: 11, borderRadius: 6, background: "linear-gradient(90deg,#efe7fb,#c9a0f0,#8a3fd0,#5a1d96)" }} />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--muted)", marginTop: 3 }}>
          <span>Low</span>
          <span>High</span>
        </div>
        <p className="muted-line" style={{ marginTop: 6 }}>Carried by the airflow; reaches rooms with an open door, blocked by walls.</p>
      </div>
    );
  }
  return (
    <p className="muted-line" style={{ marginTop: 10 }}>
      Dots show air streaming from the AC; it travels through open doors and leaves by open windows &amp; the entrance.
    </p>
  );
}

const btn: React.CSSProperties = { position: "absolute", top: 14, left: 14, zIndex: 10 };
const panel: React.CSSProperties = {
  position: "absolute",
  top: 14,
  left: 14,
  zIndex: 10,
  width: 250,
  background: "var(--panel)",
  border: "1px solid var(--line)",
  borderRadius: 14,
  padding: 14,
  boxShadow: "0 12px 30px rgba(120,90,50,0.18)",
};
