import { useEffect, useState } from "react";
import { SCENARIOS } from "../floorplan/scenarios";
import { checkGoals, type GoalStatus } from "../intent/goals";
import { useSceneStore } from "../scene/store";
import { tempGradientCss } from "../viz/temperature";

// The task as a live tick-list.
//
// Two deliberate omissions.
//
// No advice. The old prose verdict ended "add a heater there, raise its power,
// or open a door to a warmer room" — which hands over the answer the study is
// trying to watch the participant find.
//
// No numbers, and no thresholds. "Bedroom is comfortable (18–24 °C) — 17.7 °C"
// turns the task into hitting a number, and the number is the very thing the
// tool is supposed to be explaining. The row says whether the room is
// comfortable; "view" shows the room's warmth as a picture on the same colour
// scale the Temp view uses. The bands are still enforced underneath.

export function TaskChecklist() {
  const scenarioId = useSceneStore((s) => s.scenarioId);
  const plan = useSceneStore((s) => s.plan);
  const outdoorTemp = useSceneStore((s) => s.outdoorTemp);
  const setSimMode = useSceneStore((s) => s.setSimMode);
  const recorded = useSceneStore((s) => s.simulatedModes);
  const simActive = useSceneStore((s) => s.simActive);
  const simReady = useSceneStore((s) => s.simReady);
  const simMode = useSceneStore((s) => s.simMode);
  const [rows, setRows] = useState<GoalStatus[]>([]);
  const [checking, setChecking] = useState(false);
  const [shown, setShown] = useState<string | null>(null);

  const goals = scenarioId ? SCENARIOS[scenarioId].goals : undefined;

  // A goal is only scored once the participant has actually watched the
  // matching simulation converge — a box that ticks itself off a background
  // solve gives away the verdict before they have run anything. The mode being
  // viewed right now counts as soon as the solve is ready, so the gate never
  // depends on whether setSimMode fired before or after setSimReady.
  const modeFor = { temperature: "temperature", smell: "contamination", draft: "airflow" } as const;
  const simulated = simActive && simReady && !recorded.includes(simMode) ? [...recorded, simMode] : recorded;
  const unlocked = (goals ?? []).some((g) => simulated.includes(modeFor[g.metric]));
  const pending = (goals ?? []).filter((g) => !simulated.includes(modeFor[g.metric]));

  useEffect(() => {
    if (!goals?.length || !unlocked) {
      setRows([]);
      return;
    }
    let cancelled = false;
    setChecking(true);
    // Off the paint path: the solve is heavy enough to drop a frame if it runs
    // inline with the edit that triggered it.
    const id = window.setTimeout(() => {
      const ready = goals.filter((g) => simulated.includes(modeFor[g.metric]));
      const scored = new Map(checkGoals(ready, plan, outdoorTemp).map((r) => [r.label, r]));
      if (!cancelled) {
        setRows(goals.map((g) => scored.get(g.label) ?? { label: g.label, met: false, detail: "", word: "" }));
        setChecking(false);
      }
    }, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goals, plan, outdoorTemp, unlocked, recorded, simActive, simReady, simMode]);

  if (!goals?.length) return null;
  const done = rows.filter((r) => r.met).length;
  const display: GoalStatus[] = rows.length
    ? rows
    : goals.map((g) => ({ label: g.label, met: false, detail: "", word: "" }));

  return (
    <section className="selected-box">
      <h2 style={{ marginBottom: 6 }}>
        Task{" "}
        {rows.length > 0 && (
          <span style={{ fontWeight: 400, color: "var(--muted)" }}>
            · {done} of {rows.length}
          </span>
        )}
      </h2>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 7 }}>
        {display.map((r) => {
          const open = shown === r.label;
          return (
            <li key={r.label}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span
                  aria-hidden
                  style={{
                    flex: "0 0 auto",
                    width: 17,
                    height: 17,
                    borderRadius: 4,
                    border: `1.5px solid ${r.met ? "#2a9d8f" : "var(--line, #c9d3d6)"}`,
                    background: r.met ? "#2a9d8f" : "transparent",
                    color: "#fff",
                    fontSize: 12,
                    lineHeight: "15px",
                    textAlign: "center",
                    fontWeight: 700,
                  }}
                >
                  {r.met ? "✓" : ""}
                </span>
                <span style={{ fontSize: 12.5, lineHeight: 1.4, color: r.met ? "var(--muted)" : "var(--ink)" }}>
                  {r.label}
                </span>
                {r.color && (
                  <button
                    className="toggle"
                    style={{ marginLeft: "auto", fontSize: 11, padding: "1px 8px" }}
                    onClick={() => {
                      // Show the real thing too, not just the swatch.
                      setSimMode("temperature");
                      setShown(open ? null : r.label);
                    }}
                  >
                    {open ? "hide" : "view"}
                  </button>
                )}
              </div>
              {open && r.color && (
                <div style={{ marginTop: 6, marginLeft: 25 }}>
                  {/* The room's warmth, as a picture on the Temp view's scale. */}
                  <div
                    style={{
                      height: 44,
                      borderRadius: 8,
                      border: "1px solid var(--line)",
                      background: r.color,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "#12212a",
                      fontSize: 12,
                      fontWeight: 600,
                      textShadow: "0 1px 0 rgba(255,255,255,.35)",
                    }}
                  >
                    {r.word}
                  </div>
                  {/* Where that colour sits between cold and warm — still no numbers. */}
                  <div
                    style={{
                      marginTop: 4,
                      height: 7,
                      borderRadius: 4,
                      background: tempGradientCss(),
                      border: "1px solid var(--line)",
                    }}
                  />
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: "var(--muted)" }}>
                    <span>cold</span>
                    <span>warm</span>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {checking && <p className="muted-line" style={{ marginTop: 6 }}>Checking…</p>}
      {pending.length > 0 && (
        <p className="muted-line" style={{ marginTop: 6 }}>
          Run the simulation to check {pending.length === goals.length ? "these" : "the rest"}.
        </p>
      )}
    </section>
  );
}
