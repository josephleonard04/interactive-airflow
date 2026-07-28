import { useEffect, useState } from "react";
import { SCENARIOS } from "../floorplan/scenarios";
import { checkGoals, type GoalStatus } from "../intent/goals";
import { useSceneStore } from "../scene/store";

// The task as a live tick-list.
//
// The verdict used to arrive as prose — "Bedroom is 15.7 °C (13.7 °C above the
// 2 °C outside) — not warm enough. Aim for 21 °C or above — add a heater there,
// raise its power, or open a door to a warmer room." That buries the one bit
// the participant wants ("am I done?") inside a paragraph of advice, and it only
// appears after they ask. A tick-box answers it at a glance and keeps the goal
// on screen the whole time, so progress is visible while they work.
//
// Deliberately no advice text: telling people which fix to apply would hand
// them the answer the study is trying to observe them find.

export function TaskChecklist() {
  const scenarioId = useSceneStore((s) => s.scenarioId);
  const plan = useSceneStore((s) => s.plan);
  const outdoorTemp = useSceneStore((s) => s.outdoorTemp);
  const [rows, setRows] = useState<GoalStatus[]>([]);
  const [checking, setChecking] = useState(false);

  const goals = scenarioId ? SCENARIOS[scenarioId].goals : undefined;

  useEffect(() => {
    if (!goals?.length) {
      setRows([]);
      return;
    }
    let cancelled = false;
    setChecking(true);
    // Off the paint path: solving the field is heavy enough to drop a frame if
    // it runs inline with the edit that triggered it.
    const id = window.setTimeout(() => {
      const next = checkGoals(goals, plan, outdoorTemp);
      if (!cancelled) {
        setRows(next);
        setChecking(false);
      }
    }, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [goals, plan, outdoorTemp]);

  if (!goals?.length) return null;
  const done = rows.filter((r) => r.met).length;

  return (
    <section className="selected-box">
      <h2 style={{ marginBottom: 6 }}>
        Task {rows.length > 0 && <span style={{ fontWeight: 400, color: "var(--muted)" }}>· {done} of {rows.length}</span>}
      </h2>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
        {(rows.length ? rows : goals.map((g) => ({ label: g.label, met: false, detail: "" }))).map((r) => (
          <li key={r.label} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <span
              aria-hidden
              style={{
                flex: "0 0 auto",
                width: 17,
                height: 17,
                marginTop: 1,
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
            <span style={{ fontSize: 12.5, lineHeight: 1.45 }}>
              <span style={{ color: r.met ? "var(--muted)" : "var(--ink)" }}>{r.label}</span>
              {r.detail && (
                <span style={{ color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}> — {r.detail}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
      {checking && <p className="muted-line" style={{ marginTop: 6 }}>Checking…</p>}
    </section>
  );
}
