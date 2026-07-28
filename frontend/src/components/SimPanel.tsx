import { useEffect, useRef, useState } from "react";
import { useSceneStore, type SimMode } from "../scene/store";
import { evaluateObjectives, resolveObjectives, type Evaluation } from "../intent/evaluate";
import type { FloorPlan } from "../floorplan/types";
import type { Solution } from "../intent/solutions";
import { SCENARIOS } from "../floorplan/scenarios";
import { TEMP_MAX_C, TEMP_MIN_C, TEMP_NEUTRAL_C, rgbCss, tempColor, tempGradientCss, tempLabel } from "../viz/temperature";
import { STREAMLINE_BLUE } from "../viz/streamlines";
import { SketchCanvas } from "./SketchCanvas";

const INTENT_TEMPLATES = [
  "Keep my bedroom cool",
  "Keep the kitchen smell out of the bedroom",
  "Warm up the living room",
];

// Controls for the in-scene 3D airflow simulation (the field itself renders in the
// 3D house via FlowField3D). Pressing Simulate runs the sim directly on the home
// the user built — no separate 2D view.
//
// ONE ENGINE, ONE WAY IN. The real-time / accurate toggle is gone: everything
// runs on the live in-browser solver. An engine choice is a question about the
// tool rather than about the home, and the OpenFOAM path also needed a local
// backend running to answer it. (The accurate engine itself is still in the
// codebase — engine/accurate.ts and backend/ — just not offered here.)
//
// The quick presets are gone too. They set every device and door at once from a
// fixed table, which meant the participant could reach a passing layout without
// ever forming an intention — and the study is about watching them form one.

export function SimPanel() {
  const plan = useSceneStore((s) => s.plan);
  const active = useSceneStore((s) => s.simActive);
  const mode = useSceneStore((s) => s.simMode);
  const ready = useSceneStore((s) => s.simReady);
  const sourceRoomId = useSceneStore((s) => s.simSourceRoomId);
  const toggleSim = useSceneStore((s) => s.toggleSim);
  const setSimMode = useSceneStore((s) => s.setSimMode);
  const airflowStyle = useSceneStore((s) => s.airflowStyle);
  const setAirflowStyle = useSceneStore((s) => s.setAirflowStyle);
  const setSource = useSceneStore((s) => s.setSimSource);
  const addItem = useSceneStore((s) => s.addItem);
  const selectItem = useSceneStore((s) => s.selectItem);
  const applyBestSolution = useSceneStore((s) => s.applyBestSolution);
  const optimizing = useSceneStore((s) => s.optimizing);
  const pendingChange = useSceneStore((s) => s.pendingChange);
  const recheckGoal = useRef<string | null>(null);
  const acceptChange = useSceneStore((s) => s.acceptChange);
  const cancelChange = useSceneStore((s) => s.cancelChange);
  const sketchRegion = useSceneStore((s) => s.sketchRegion);
  const outdoorTemp = useSceneStore((s) => s.outdoorTemp);
  const setOutdoorTemp = useSceneStore((s) => s.setOutdoorTemp);
  const tempRoomId = useSceneStore((s) => s.tempRoomId);
  const setTempRoom = useSceneStore((s) => s.setTempRoom);
  const roomTempDeltas = useSceneStore((s) => s.roomTempDeltas);
  const solutionOptions = useSceneStore((s) => s.solutionOptions);
  const solutionGoal = useSceneStore((s) => s.solutionGoal);
  const solutionTargets = useSceneStore((s) => s.solutionTargets);
  const chooseSolution = useSceneStore((s) => s.chooseSolution);
  const dismissSolutions = useSceneStore((s) => s.dismissSolutions);
  const logCount = useSceneStore((s) => s.sessionLog.length);
  const scenarioId = useSceneStore((s) => s.scenarioId);
  const [showSketch, setShowSketch] = useState(false);
  const smellCount = plan.items.filter((it) => it.type === "smell").length;

  // After the placement search finishes, re-check the goal against the NEW plan.
  useEffect(() => {
    if (!optimizing && recheckGoal.current) {
      const g = recheckGoal.current;
      recheckGoal.current = null;
      checkGoalText(g);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optimizing]);

  const [goal, setGoal] = useState("");
  const [results, setResults] = useState<Evaluation[]>([]);
  const checklistScenario = useSceneStore((s) => s.scenarioId);
  const hasChecklist = !!(checklistScenario && SCENARIOS[checklistScenario].goals?.length);

  // Plain-language goal → physical objectives → checked against the result, and
  // the matching view is shown so the user sees what's happening.
  const checkGoalText = async (text: string) => {
    if (!text.trim()) return;
    // Read the plan from the store, not the render closure: this is called
    // immediately after applying a solution, and the closed-over `plan` is still
    // the pre-apply one — which made the verdict report the old temperatures.
    const livePlan = useSceneStore.getState().plan;
    // Keyword parser first; the LLM only sees wording it couldn't match, so a
    // recognised phrase is still resolved instantly and offline.
    const { objectives } = await resolveObjectives(text, livePlan, sketchRegion);
    const evals = evaluateObjectives(objectives, livePlan, { outdoorTemp });
    useSceneStore.getState().logEvent("check", {
      text,
      results: evals.map((e) => ({ summary: e.summary, satisfied: e.satisfied, value: e.value })),
    });
    setResults(evals);
    const first = evals[0]?.objective;
    if (first) {
      if (first.scalar === "temperature") setSimMode("temperature");
      else if (first.scalar === "draft") setSimMode("airflow");
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

      {optimizing && (
        <p className="muted-line" style={{ marginBottom: 10, color: "var(--accent-ink-soft)", fontWeight: 700 }}>
          ⏳ Comparing layouts with the simulator to find the best setup for your home…
        </p>
      )}

      {pendingChange && (
        <div style={{ marginBottom: 14, padding: 12, borderRadius: 12, border: "1px solid var(--accent)", background: "var(--accent-soft)" }}>
          <div style={{ fontSize: 12.5, fontWeight: 800, color: "var(--accent-ink-soft)", marginBottom: 6 }}>
            “{pendingChange.title}” — review changes
          </div>
          <ul style={{ margin: "0 0 10px", paddingLeft: 16, fontSize: 12, color: "var(--text)", lineHeight: 1.6 }}>
            {pendingChange.lines.map((l, i) => <li key={i}>{l}</li>)}
          </ul>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="primary" style={{ flex: 1 }} onClick={acceptChange}>Accept</button>
            <button className="tool" style={{ flex: 1 }} onClick={acceptChange} title="Keep the changes and tweak them yourself">Modify</button>
            <button className="tool" style={{ flex: 1 }} onClick={cancelChange} title="Undo this preset">Cancel</button>
          </div>
        </div>
      )}

      <div style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <span style={{ fontSize: 12, color: "var(--muted)", fontWeight: 700 }}>Ask in plain language</span>
          <button
            className={showSketch || sketchRegion ? "toggle on" : "toggle"}
            onClick={() => setShowSketch((v) => !v)}
            title="Draw the area a goal refers to — then say “keep this area cool”"
          >
            ✏️ Sketch an area
          </button>
        </div>
        {(showSketch || sketchRegion != null) && (
          <div style={{ marginBottom: 8 }}>
            <SketchCanvas />
          </div>
        )}
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) checkGoal(); }}
          placeholder="e.g. keep my bedroom cool, and keep the kitchen smell out of it"
          rows={3}
          style={{ width: "100%", resize: "vertical", minHeight: 64, background: "#fff", border: "1px solid var(--line)", borderRadius: 10, padding: "9px 11px", fontSize: 13, color: "var(--text)", fontFamily: "inherit", lineHeight: 1.4 }}
        />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 7 }}>
          {INTENT_TEMPLATES.map((t) => (
            <button key={t} className="chip" style={{ fontSize: 11 }} onClick={() => { setGoal(t); checkGoalText(t); }}>
              {t}
            </button>
          ))}
          {sketchRegion && (
            <button
              className="chip"
              style={{ fontSize: 11, borderColor: "var(--accent)" }}
              onClick={() => { setGoal("Keep this area cool"); checkGoalText("Keep this area cool"); }}
            >
              Keep this area cool
            </button>
          )}
          <button
            className="primary"
            style={{ marginLeft: "auto" }}
            disabled={optimizing}
            onClick={() => {
              if (goal.trim() && applyBestSolution(goal)) recheckGoal.current = goal;
            }}
            title="Search your layout with the simulator and offer the setups that work best"
          >
            {optimizing ? "⏳ Searching…" : "✨ Find solutions"}
          </button>
        </div>
        {solutionOptions.length > 0 && (
          <SolutionOptions
            options={solutionOptions}
            goal={solutionGoal}
            targets={solutionTargets}
            rooms={plan.rooms}
            outdoorTemp={outdoorTemp}
            onChoose={(i) => {
              const g = solutionGoal;
              chooseSolution(i);
              // Re-check straight away so the verdict reflects the layout just
              // applied. (The optimizing-flag effect doesn't fire here — picking
              // an already-computed option never sets it.)
              if (g) checkGoalText(g);
            }}
            onDismiss={dismissSolutions}
          />
        )}
        {/* The prose verdict is suppressed whenever the task has a tick-list —
            two answers to "am I done?" in one panel, one of them contradicting
            the other's thresholds, is worse than either alone. */}
        {!hasChecklist && results.map((r, i) => (
          <div
            key={i}
            style={{
              marginTop: 8,
              padding: "9px 11px",
              borderRadius: 10,
              border: "1px solid var(--line)",
              background: "#fff",
              borderLeft: `3px solid ${r.satisfied === null ? "var(--muted)" : r.satisfied ? "#2a9d8f" : "#c0392b"}`,
            }}
          >
            <span style={{ fontSize: 12.5, fontWeight: 700, color: r.satisfied === null ? "var(--muted)" : r.satisfied ? "#156d63" : "#c0392b" }}>
              {r.summary}
            </span>
          </div>
        ))}
      </div>

      <div className="tools">
        {(["airflow", "temperature", "contamination", "noise"] as SimMode[]).map((m) => (
          <button key={m} className={mode === m ? "tool active" : "tool"} onClick={() => setSimMode(m)}>
            {m === "airflow" ? "Airflow" : m === "temperature" ? "Temp" : m === "contamination" ? "Smell" : "Noise"}
          </button>
        ))}
      </div>
      {mode === "airflow" && (
        <div className="tools" style={{ marginTop: 6 }}>
          <button className={airflowStyle === "dots" ? "tool active" : "tool"} onClick={() => setAirflowStyle("dots")}>
            • Particle dots
          </button>
          <button className={airflowStyle === "lines" ? "tool active" : "tool"} onClick={() => setAirflowStyle("lines")}>
            ⌇ Streamlines
          </button>
        </div>
      )}
      {mode === "temperature" && (
        <TempControls
          rooms={plan.rooms}
          outdoorTemp={outdoorTemp}
          setOutdoorTemp={setOutdoorTemp}
          tempRoomId={tempRoomId}
          setTempRoom={setTempRoom}
          deltas={roomTempDeltas}
          ready={ready}
          locked={scenarioId !== null}
        />
      )}
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
      <Legend mode={mode} outdoorTemp={outdoorTemp} />
      <button
        className="ghost"
        style={{ marginTop: 10, fontSize: 11, width: "100%" }}
        title="Download the session log (every goal, parse, review decision & change) as JSON — for the user study"
        onClick={() => {
          const log = useSceneStore.getState().sessionLog;
          const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), events: log }, null, 2)], { type: "application/json" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `airflow-session-${Date.now()}.json`;
          a.click();
          URL.revokeObjectURL(a.href);
        }}
      >
        ⬇ Study log ({logCount} events)
      </button>
    </div>
  );
}

/** The alternatives gallery: several complete configurations, best first, each
 *  showing what it does and what the target rooms actually reach. The user picks
 *  the trade-off — a single "best" answer hides the fact that there IS one. */
function SolutionOptions({
  options,
  goal,
  targets,
  rooms,
  outdoorTemp,
  onChoose,
  onDismiss,
}: {
  options: Solution[];
  goal: string | null;
  targets: string[];
  rooms: FloorPlan["rooms"];
  outdoorTemp: number;
  onChoose: (i: number) => void;
  onDismiss: () => void;
}) {
  const nameOf = (id: string) => rooms.find((r) => r.id === id)?.name ?? id;
  return (
    <div style={{ marginTop: 8, border: "1px solid var(--line)", borderRadius: 10, padding: 9, background: "#fff" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 6 }}>
        <span style={{ fontSize: 12.5, fontWeight: 700 }}>
          {options.length} option{options.length > 1 ? "s" : ""} for “{(goal ?? "").trim().slice(0, 32)}”
        </span>
        <button className="ghost" style={{ marginLeft: "auto", fontSize: 11 }} onClick={onDismiss}>
          ✕
        </button>
      </div>
      {options.map((o, i) => (
        <div
          key={o.id}
          style={{
            marginBottom: 6, padding: "8px 9px", borderRadius: 9,
            border: `1px solid ${i === 0 ? "var(--accent)" : "var(--line)"}`,
            background: i === 0 ? "rgba(42,157,143,0.06)" : "transparent",
          }}
        >
          <div style={{ fontSize: 12.5, fontWeight: 700 }}>
            {i === 0 ? "★ " : ""}{o.label}
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 1 }}>{o.detail.join(" · ")}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, margin: "6px 0 7px" }}>
            {(targets.length ? targets : rooms.map((r) => r.id)).map((id) => {
              const t = o.metrics.roomTempC.get(id);
              return (
                <span
                  key={id}
                  style={{
                    fontSize: 11, padding: "2px 6px", borderRadius: 999,
                    border: "1px solid var(--line)",
                    background: t != null ? rgbCss(tempColor(t)) : "transparent",
                    color: t != null && (t < 19 || t > 30) ? "#fff" : "inherit",
                  }}
                  title={`${nameOf(id)} — predicted air temperature`}
                >
                  {nameOf(id)} {t != null ? `${t.toFixed(1)} °C` : "—"}
                </span>
              );
            })}
          </div>
          <button className={i === 0 ? "primary" : "tool"} style={{ width: "100%", fontSize: 11.5 }} onClick={() => onChoose(i)}>
            Use this
          </button>
        </div>
      ))}
      <p className="muted-line" style={{ marginTop: 2 }}>
        Predicted with the simulator at the outdoor {outdoorTemp.toFixed(0)} °C. Applying one still shows a review you can undo.
      </p>
    </div>
  );
}

/** Outdoor temperature + the per-room readout. Outdoor temperature is a real
 *  design input, not decoration: "keep my bedroom cool" is a different problem
 *  at 22 °C outside than at 35 °C, and the answer (open a window vs. run the AC)
 *  flips between them. */
function TempControls({
  rooms,
  outdoorTemp,
  setOutdoorTemp,
  tempRoomId,
  setTempRoom,
  deltas,
  ready,
  locked,
}: {
  rooms: FloorPlan["rooms"];
  outdoorTemp: number;
  setOutdoorTemp: (c: number) => void;
  tempRoomId: string | null;
  setTempRoom: (id: string | null) => void;
  deltas: Map<string, number>;
  ready: boolean;
  locked: boolean;
}) {
  const absOf = (id: string) => (deltas.has(id) ? outdoorTemp + deltas.get(id)! : null);
  const selected = tempRoomId ? rooms.find((r) => r.id === tempRoomId) ?? null : null;
  const selectedT = selected ? absOf(selected.id) : null;

  return (
    <div style={{ marginTop: 8 }}>
      <div className="field">
        <span>outdoor air</span>
        <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>{outdoorTemp.toFixed(0)} °C</span>
      </div>
      {locked ? (
        // In a study task the weather is part of the scenario. Leaving the
        // slider live would let a participant "solve" a cooling task by dragging
        // the outdoor temperature down.
        <p className="muted-line" style={{ margin: "2px 0 0" }}>Today's weather — fixed for this task.</p>
      ) : (
        <>
          <input
            type="range"
            min={-5}
            max={40}
            step={1}
            value={outdoorTemp}
            onChange={(e) => setOutdoorTemp(Number(e.target.value))}
            style={{ width: "100%", marginTop: 2 }}
            title="Outdoor air temperature — the baseline the whole house sits at"
          />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: "var(--muted)" }}>
            <span>−5 °C winter</span>
            <span>40 °C heatwave</span>
          </div>
        </>
      )}

      <div className="field" style={{ marginTop: 8 }}>
        <span>show room</span>
        <select value={tempRoomId ?? ""} onChange={(e) => setTempRoom(e.target.value || null)} style={{ maxWidth: 140 }}>
          <option value="">All rooms</option>
          {rooms.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
      </div>

      {!ready ? (
        <p className="muted-line" style={{ marginTop: 6 }}>Waiting for the steady state…</p>
      ) : selected ? (
        <div
          style={{
            marginTop: 6, padding: "9px 11px", borderRadius: 10,
            border: "1px solid var(--line)", background: "#fff",
            borderLeft: `4px solid ${selectedT != null ? rgbCss(tempColor(selectedT)) : "var(--muted)"}`,
          }}
        >
          <div style={{ fontSize: 12.5, fontWeight: 700 }}>
            {selected.name}: {selectedT != null ? `${selectedT.toFixed(1)} °C` : "—"}
          </div>
          {selectedT != null && (
            <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
              {tempLabel(selectedT)} · {(selectedT - outdoorTemp >= 0 ? "+" : "") + (selectedT - outdoorTemp).toFixed(1)} °C vs outside
            </div>
          )}
        </div>
      ) : (
        <div style={{ marginTop: 6, display: "grid", gap: 3 }}>
          {rooms.map((r) => {
            const t = absOf(r.id);
            return (
              <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12 }}>
                <span
                  style={{
                    width: 12, height: 12, borderRadius: 3, flex: "0 0 auto",
                    background: t != null ? rgbCss(tempColor(t)) : "var(--line)",
                    border: "1px solid rgba(0,0,0,0.14)",
                  }}
                />
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
                  {t != null ? `${t.toFixed(1)} °C` : "—"}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Legend({ mode, outdoorTemp }: { mode: SimMode; outdoorTemp: number }) {
  if (mode === "temperature") {
    const ticks = [TEMP_MIN_C, 18, TEMP_NEUTRAL_C, 30, TEMP_MAX_C];
    return (
      <div style={{ marginTop: 10 }}>
        <div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600, marginBottom: 4 }}>Air temperature (°C)</div>
        <div style={{ height: 11, borderRadius: 6, background: tempGradientCss() }} />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: "var(--muted)", marginTop: 3 }}>
          {ticks.map((t) => (
            <span key={t}>{t === TEMP_MIN_C ? `≤${t}` : t === TEMP_MAX_C ? `≥${t}` : t}</span>
          ))}
        </div>
        <p className="muted-line" style={{ marginTop: 6 }}>
          Absolute temperature on a fixed scale, so the same colour always means the same reading.
          The house starts at the outdoor {outdoorTemp.toFixed(0)} °C; heating and cooling are carried
          from there by the airflow, through open doors and blocked by walls.
        </p>
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
        <p className="muted-line" style={{ marginTop: 6 }}>Carried by the airflow; reaches rooms with an open door, blocked by walls. Lower near open windows &amp; vents.</p>
      </div>
    );
  }
  if (mode === "noise") {
    return (
      <div style={{ marginTop: 10 }}>
        <div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600, marginBottom: 4 }}>Appliance noise</div>
        <div style={{ height: 11, borderRadius: 6, background: "linear-gradient(90deg,#22c55e,#facc15,#dc2626)" }} />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--muted)", marginTop: 3 }}>
          <span>Quiet</span>
          <span>Loud</span>
        </div>
        <p className="muted-line" style={{ marginTop: 6 }}>Radiates from running appliances (AC, fan, heater, fridge, TV); fades with distance and through walls.</p>
      </div>
    );
  }
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11.5 }}>
        <span style={{ width: 22, height: 3, borderRadius: 2, background: STREAMLINE_BLUE, flex: "0 0 auto" }} />
        <span style={{ color: "var(--muted)" }}>one path the air actually takes</span>
      </div>
      <p className="muted-line" style={{ marginTop: 6 }}>
        The moving dashes travel the way the air flows. Air passes through open doors and leaves by
        open windows &amp; the entrance — nothing crosses a wall.
      </p>
    </div>
  );
}

const btn: React.CSSProperties = { position: "absolute", top: 14, left: 14, zIndex: 10 };
const panel: React.CSSProperties = {
  position: "absolute",
  top: 14,
  left: 14,
  zIndex: 10,
  width: 300,
  maxHeight: "calc(100vh - 28px)",
  overflowY: "auto",
  background: "var(--panel)",
  border: "1px solid var(--line)",
  borderRadius: 14,
  padding: 14,
  boxShadow: "0 12px 30px rgba(120,90,50,0.18)",
};
