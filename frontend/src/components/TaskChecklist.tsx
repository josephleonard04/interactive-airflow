import { useEffect, useState } from "react";
import { SCENARIOS } from "../floorplan/scenarios";
import { checkGoals, goalPicture, type GoalStatus } from "../intent/goals";
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
//
// "view" is on every row from the moment the task opens — it is the GOAL, and a
// goal you can only see after you have already run the simulation is not much
// of a goal. Before the first run it shows where the home starts and where it
// has to get to; once a run has landed, the left half becomes the room as it
// actually is now, so the same picture doubles as progress.

/** Which simulation view answers each kind of goal. */
const MODE_FOR = { temperature: "temperature", smell: "contamination", draft: "airflow" } as const;

/** One end of the before/after picture: a colour, what it is called, and which
 *  end of the story it is. */
function Swatch({ caption, color, word, accent }: { caption: string; color: string; word: string; accent?: boolean }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 2 }}>{caption}</div>
      <div
        style={{
          height: 40,
          borderRadius: 8,
          border: `1px solid ${accent ? "#2a9d8f" : "var(--line)"}`,
          background: color,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "0 4px",
          textAlign: "center",
          color: "#12212a",
          fontSize: 11.5,
          fontWeight: 600,
          lineHeight: 1.2,
          textShadow: "0 1px 0 rgba(255,255,255,.35)",
        }}
      >
        {word}
      </div>
    </div>
  );
}

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
  const simulated = simActive && simReady && !recorded.includes(simMode) ? [...recorded, simMode] : recorded;
  const unlocked = (goals ?? []).some((g) => simulated.includes(MODE_FOR[g.metric]));
  const pending = (goals ?? []).filter((g) => !simulated.includes(MODE_FOR[g.metric]));

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
      const ready = goals.filter((g) => simulated.includes(MODE_FOR[g.metric]));
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
        {display.map((r, i) => {
          const open = shown === r.label;
          const goal = goals[i];
          const pic = goalPicture(goal, outdoorTemp);
          // Before any run there is nothing measured, so "now" is where the home
          // starts; after one, it is the room as it stands.
          const now = r.color ? { color: r.color, word: r.word } : pic.before;
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
                <button
                  className="toggle"
                  style={{ marginLeft: "auto", fontSize: 11, padding: "1px 8px" }}
                  title="See what this goal looks like"
                  onClick={() => {
                    // Show the real thing too, not just the swatch.
                    setSimMode(MODE_FOR[goal.metric]);
                    setShown(open ? null : r.label);
                  }}
                >
                  {open ? "hide" : "view"}
                </button>
              </div>
              {open && (
                <div style={{ marginTop: 6, marginLeft: 25 }}>
                  {/* Where it is now → where it has to get to. */}
                  <div style={{ display: "flex", alignItems: "stretch", gap: 6 }}>
                    <Swatch caption={r.color ? "now" : "at the start"} color={now.color} word={now.word} />
                    <span style={{ alignSelf: "center", color: "var(--muted)", fontSize: 15 }}>→</span>
                    <Swatch caption="goal" color={pic.after.color} word={pic.after.word} accent />
                  </div>
                  {pic.onTempScale && (
                    <>
                      {/* Where those colours sit between cold and warm — still no numbers. */}
                      <div
                        style={{
                          marginTop: 6,
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
                    </>
                  )}
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
