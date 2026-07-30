import { useEffect, useState } from "react";
import { SCENARIOS } from "../floorplan/scenarios";
import {
  SWATCH_SCALE_CSS,
  checkGoals,
  drySwatch,
  dryingMap,
  goalPicture,
  type DryMap,
  type GoalStatus,
} from "../intent/goals";
import { useSceneStore } from "../scene/store";


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
const MODE_FOR = {
  temperature: "temperature",
  smell: "contamination",
  draft: "airflow",
  // Drying is read off the same moisture field the contamination view draws.
  drying: "contamination",
} as const;

/** Ink that stays legible on the swatch it sits on. The cold end of the ramp is
 *  a deep navy, and dark text on it was unreadable — the one word the picture
 *  exists to say. Rec. 709 luminance, flipped at the usual mid-grey. */
function inkOn(color: string): { color: string; textShadow: string } {
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(color);
  const [r, g, b] = m
    ? [Number(m[1]), Number(m[2]), Number(m[3])]
    : // hex fallback (#rgb / #rrggbb) for the smell/draught swatches
      (() => {
        const h = color.replace("#", "");
        const f = h.length === 3 ? h.split("").map((c) => c + c) : [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)];
        return f.map((v) => parseInt(v, 16) || 0);
      })();
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum < 0.55
    ? { color: "#ffffff", textShadow: "0 1px 2px rgba(0,0,0,.45)" }
    : { color: "#12212a", textShadow: "0 1px 0 rgba(255,255,255,.35)" };
}

/** The room, drawn as a plan, shaded by how long each patch stays wet.
 *
 *  No numbers on it, and no "high"/"low" either: the participant reads a dark
 *  patch behind the bath and a pale floor by the door, which is the finding.
 *  The caption is the one number that IS the goal — a time in minutes, because
 *  "still wet two hours later" is a sentence about a bathroom in a way that
 *  0.27 on a contaminant scale is not. */
function DryPlan({ map, limit }: { map: DryMap; limit: number }) {
  const W = 190;
  const H = Math.round((W * map.d) / map.w);
  const cw = W / map.cols;
  const ch = H / map.rows;
  const worst = map.minutes.reduce<number>((a, m) => (m != null && m > a ? m : a), 0);
  return (
    <div>
      <svg width={W} height={H} style={{ display: "block", borderRadius: 8, border: "1px solid var(--line)", background: "#fff" }}>
        {map.minutes.map((m, i) => {
          if (m == null) return null;
          const c = i % map.cols;
          const r = (i / map.cols) | 0;
          return <rect key={i} x={c * cw} y={r * ch} width={cw + 0.6} height={ch + 0.6} fill={drySwatch(m)} />;
        })}
      </svg>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 5 }}>
        <div style={{ flex: 1, height: 7, borderRadius: 4, border: "1px solid var(--line)", background: `linear-gradient(90deg, ${drySwatch(0)}, ${drySwatch(60)}, ${drySwatch(140)})` }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: "var(--muted)" }}>
        <span>dries quickly</span>
        <span>stays wet</span>
      </div>
      <p className="muted-line" style={{ marginTop: 5 }}>
        {worst >= 999
          ? `The slowest corner never really dries. Goal: everywhere dry within ${limit} minutes.`
          : `The slowest corner takes about ${worst >= 90 ? `${(worst / 60).toFixed(1)} hours` : `${Math.round(worst)} minutes`}. Goal: under ${limit} minutes, everywhere.`}
      </p>
    </div>
  );
}

/** One end of the before/after picture: a colour, what it is called, and which
 *  end of the story it is. */
function Swatch({ caption, color, word, accent }: { caption: string; color: string; word: string; accent?: boolean }) {
  const ink = inkOn(color);
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
          fontSize: 11.5,
          fontWeight: 600,
          lineHeight: 1.2,
          ...ink,
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
  const logGoalStatus = useSceneStore((s) => s.logGoalStatus);
  const [rows, setRows] = useState<GoalStatus[]>([]);
  const [checking, setChecking] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const [dryMap, setDryMap] = useState<DryMap | null>(null);

  const goals = scenarioId ? SCENARIOS[scenarioId].goals : undefined;

  // A goal is only scored once the participant has actually watched the
  // matching simulation converge — a box that ticks itself off a background
  // solve gives away the verdict before they have run anything. The mode being
  // viewed right now counts as soon as the solve is ready, so the gate never
  // depends on whether setSimMode fired before or after setSimReady.
  const simulated = simActive && simReady && !recorded.includes(simMode) ? [...recorded, simMode] : recorded;
  const unlocked = (goals ?? []).some((g) => simulated.includes(MODE_FOR[g.metric]));
  const pending = (goals ?? []).filter((g) => !simulated.includes(MODE_FOR[g.metric]));
  const dryingGoal = (goals ?? []).find((g) => g.metric === "drying");

  // The room's drying map, computed only while its picture is actually open —
  // it is a full solve, and paying for one on every edit to draw something
  // nobody is looking at would cost a frame each time.
  useEffect(() => {
    if (!dryingGoal || !shown) {
      setDryMap(null);
      return;
    }
    let cancelled = false;
    const id = window.setTimeout(() => {
      const m = dryingMap(plan, outdoorTemp, dryingGoal.roomId);
      if (!cancelled) setDryMap(m);
    }, 40);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dryingGoal, shown, plan, outdoorTemp]);

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
        const next = goals.map((g) => scored.get(g.label) ?? { label: g.label, met: false, detail: "", word: "" });
        setRows(next);
        setChecking(false);
        // The verdict is part of the story, so it goes in the log next to the
        // edit that produced it — see logGoalStatus (it de-duplicates).
        logGoalStatus(next.map((r) => ({ label: r.label, met: r.met, detail: r.detail })));
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
                  {/* A drying goal gets a plan of the room instead of two
                      swatches: WHERE the slow patch is happens to be the whole
                      lesson, and no pair of colour chips can say that. */}
                  {goal.metric === "drying" && dryMap ? (
                    <DryPlan map={dryMap} limit={goal.atMost ?? 45} />
                  ) : (
                    <div style={{ display: "flex", alignItems: "stretch", gap: 6 }}>
                      <Swatch caption={r.color ? "now" : "at the start"} color={now.color} word={now.word} />
                      <span style={{ alignSelf: "center", color: "var(--muted)", fontSize: 15 }}>→</span>
                      <Swatch caption="goal" color={pic.after.color} word={pic.after.word} accent />
                    </div>
                  )}
                  {pic.onTempScale && (
                    <>
                      {/* Where those colours sit between cold and warm — still no numbers. */}
                      <div
                        style={{
                          marginTop: 6,
                          height: 7,
                          borderRadius: 4,
                          background: SWATCH_SCALE_CSS,
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
