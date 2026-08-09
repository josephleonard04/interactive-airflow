import { useEffect, useRef, useState } from "react";
import { useSceneStore, type SimMode } from "../scene/store";
import { evaluateObjectives, resolveObjectives, type Evaluation } from "../intent/evaluate";
import type { LlmReason } from "../intent/llmGoal";
import type { FloorPlan } from "../floorplan/types";
import type { Solution } from "../intent/solutions";
import { SCENARIOS } from "../floorplan/scenarios";
import { objectivesFromScenario } from "../intent/fallback";
import { isAdjustment } from "../intent/objectives";
import { TEMP_MAX_C, TEMP_MIN_C, TEMP_NEUTRAL_C, flowGradientCss, rgbCss, tempColor, tempGradientCss, tempLabel } from "../viz/temperature";
import { contaminantGradientCss, smellColor } from "../viz/smell";
import { drySwatch } from "../intent/goals";
import { SketchCanvas } from "./SketchCanvas";

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
  const applyObjectives = useSceneStore((s) => s.applyObjectives);
  const optimizing = useSceneStore((s) => s.optimizing);
  const pendingChange = useSceneStore((s) => s.pendingChange);
  const recheckGoal = useRef<string | null>(null);
  const acceptChange = useSceneStore((s) => s.acceptChange);
  const cancelChange = useSceneStore((s) => s.cancelChange);
  const sketchRegion = useSceneStore((s) => s.sketchRegion);
  const intentInput = useSceneStore((s) => s.intentInput);
  const setIntentInput = useSceneStore((s) => s.setIntentInput);
  const sketchMarks = useSceneStore((s) => s.sketchMarks);
  const applySketchSolution = useSceneStore((s) => s.applySketchSolution);
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
  const smellCount = plan.items.filter((it) => it.type === "smell").length;

  // After the placement search finishes, re-check the goal against the NEW plan.
  useEffect(() => {
    if (!optimizing && recheckGoal.current) {
      const g = recheckGoal.current;
      recheckGoal.current = null;
      void checkGoalText(g);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optimizing]);

  const [goal, setGoal] = useState("");
  /** Set when a typed sentence could not be turned into an objective, so the
   *  panel can say so instead of doing nothing. `reason` distinguishes "we read
   *  it and there is no comfort goal in it" from "the parser was not reachable",
   *  which need completely different words in front of a participant. */
  const [unparsed, setUnparsed] = useState<{ text: string; reason: LlmReason } | null>(null);
  /** The model is a network round trip, so the button has to say it is thinking
   *  — otherwise a two-second pause reads as a dead button and gets clicked
   *  again, which is a second round trip and a second log entry. */
  const [reading, setReading] = useState(false);
  /** Set when the search ran on the TASK's goals because the sentence could not
   *  be read. Saying so matters: the alternative is a gallery of options that
   *  silently answers a different question from the one that was asked, which is
   *  worse than the dead end it replaced. */
  const [guessedGoal, setGuessedGoal] = useState<string | null>(null);
  const [results, setResults] = useState<Evaluation[]>([]);
  const checklistScenario = useSceneStore((s) => s.scenarioId);
  // A task with scored goals never shows a prose verdict: the goals are graded
  // silently into the log, and telling the participant "not warm enough yet" is
  // the tick-box back by another name.
  const hasScoredGoals = !!(checklistScenario && SCENARIOS[checklistScenario].goals?.length);
  // A task can narrow the views to the ones that answer it, and the contaminant
  // view takes its name from what the task is actually about — the same field
  // carries kitchen odour in one scenario and bathroom moisture in another, and
  // calling it "Smell" in a task about mould just reads as a bug.
  const views: SimMode[] =
    (checklistScenario ? SCENARIOS[checklistScenario].views : undefined) ??
    (["airflow", "temperature", "contamination", "noise"] as SimMode[]);
  const contaminantLabel = checklistScenario === "humidity" ? "Humidity" : "Smell";

  // Plain-language goal → physical objectives → checked against the result, and
  // the matching view is shown so the user sees what's happening.
  const checkGoalText = async (text: string) => {
    if (!text.trim()) return;
    // Read the plan from the store, not the render closure: this is called
    // immediately after applying a solution, and the closed-over `plan` is still
    // the pre-apply one — which made the verdict report the old temperatures.
    const livePlan = useSceneStore.getState().plan;
    // Keyword parser first; the model only sees wording it couldn't match, so a
    // recognised phrase is still resolved instantly and offline.
    const { objectives, via, reason } = await resolveObjectives(text, livePlan, sketchRegion, { outdoorTemp });
    const evals = evaluateObjectives(objectives, livePlan, { outdoorTemp });
    useSceneStore.getState().logEvent("check", {
      what: "check-goal",
      text,
      via,
      reason,
      // What the sentence was UNDERSTOOD as, not only what it produced. RQ2 is
      // about how people phrase intent, and "keep the bedroom warm" reading as
      // temperature/high@Bedroom is the interesting half of that.
      objectives: objectives.map((o) => ({
        scalar: o.scalar,
        direction: o.direction,
        region: o.regionName,
        regionId: o.regionId,
        source: o.sourceName ?? null,
        fromSketchArea: !!o.regionRect,
      })),
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

  // FIND SOLUTIONS, THROUGH THE SAME PARSER THE CHECK USES. The button used to
  // call the keyword lexicon directly, so the backend's language model — the
  // whole point of which is to read sentences the lexicon cannot — was wired
  // into the verdict path and nowhere near the button that actually does
  // something. "I want fresh air near the bed" matched no keyword, the search
  // silently refused to run, and starting the backend did not help.
  const findSolutionsFor = async (text: string) => {
    const t = text.trim();
    if (!t || optimizing || reading) return;
    setUnparsed(null);
    setReading(true);
    const livePlan = useSceneStore.getState().plan;
    let objectives, via, reason;
    try {
      ({ objectives, via, reason } = await resolveObjectives(t, livePlan, sketchRegion, { outdoorTemp }));
      // THE UTTERANCE ITSELF, verbatim, with how it was read — logged before
      // anything is done with it, so the record survives whichever branch the
      // sentence takes below (understood, guessed at, or refused).
      useSceneStore.getState().logEvent("check", {
        what: "typed-goal",
        text: t,
        via,
        reason,
        objectives: objectives.map((o) => ({
          scalar: o.scalar,
          direction: o.direction,
          region: o.regionName,
          regionId: o.regionId,
          fromSketchArea: !!o.regionRect,
        })),
      });
    } finally {
      setReading(false);
    }
    // A FOLLOW-UP IS NOT A NEW QUESTION. "Move it a bit further along" parses to
    // nothing groundable and would fall through to the scenario-goal fallback,
    // which re-runs the whole search and comes back with somewhere else — the
    // one answer that reads as not having listened. Routed straight through, it
    // nudges the layout on screen instead. See isAdjustment / refineOnly.
    if (isAdjustment(t) && useSceneStore.getState().lastSearch) {
      setGuessedGoal(null);
      if (applyObjectives(objectives, t)) recheckGoal.current = t;
      return;
    }

    // The sentence itself is the finding — it is the coverage gap, verbatim, and
    // the only record of a wording neither the dictionary nor the model could
    // turn into a goal. `reason` says which of those two it was, which is the
    // difference between "add this word" and "start the backend". It is logged
    // whether or not the fallback below rescues the search, because the fallback
    // rescuing it is exactly what would otherwise hide the gap.
    let objs = objectives;
    let guessed = false;
    if (!objs.length) {
      useSceneStore.getState().logEvent("unparsed", { what: "not-understood", text: t, via, reason });
      // NEVER A DEAD END. Falling back to the task's own goals is a defensible
      // reading of "adjust it" or "something better", and strictly better than a
      // shrug for everything else — a participant who gets nothing back stops
      // typing, and we lose every sentence after this one. See intent/fallback.
      const sid = useSceneStore.getState().scenarioId;
      objs = objectivesFromScenario(sid ? SCENARIOS[sid].goals : undefined, livePlan, t);
      guessed = objs.length > 0;
      if (!objs.length) {
        setUnparsed({ text: t.slice(0, 60), reason });
        return;
      }
    }
    setGuessedGoal(guessed ? t.slice(0, 60) : null);
    if (applyObjectives(objs, t)) recheckGoal.current = t;
  };

  // A search that returns nothing is not the same as one that was never run,
  // and on screen they looked identical: the gallery simply did not appear.
  // That happens when every layout the search found already satisfies the task
  // and is therefore withheld — a real state, and one worth a sentence.
  const searchedButEmpty =
    !optimizing && !reading && solutionGoal !== null && solutionOptions.length === 0;

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
        {/* Two ways to say the same thing. Typing suits "keep the kitchen smell
            out of the bedroom"; drawing suits "warm THIS corner" and "bring the
            air from here to there", which are sentences about geometry that is
            already on screen. Either one alone is enough to search — the sketch
            does not need a sentence to go with it. */}
        <div style={{ display: "flex", gap: 4, marginBottom: 8, background: "#eef0ea", borderRadius: 8, padding: 3 }}>
          {(["text", "sketch"] as const).map((m) => (
            <button
              key={m}
              className={intentInput === m ? "tool active" : "tool"}
              style={{ flex: 1 }}
              onClick={() => setIntentInput(m)}
              title={m === "text" ? "Type what you want" : "Draw what you want on a plan of your home"}
            >
              {m === "text" ? "⌨️ Type it" : "✏️ Draw it"}
            </button>
          ))}
        </div>

        {intentInput === "text" ? (
          <>
            <textarea
              value={goal}
              onChange={(e) => { setGoal(e.target.value); if (unparsed) setUnparsed(null); if (guessedGoal) setGuessedGoal(null); }}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void checkGoal(); }}
              placeholder="e.g. keep my bedroom cool, and keep the kitchen smell out of it"
              rows={3}
              style={{ width: "100%", resize: "vertical", minHeight: 64, background: "#fff", border: "1px solid var(--line)", borderRadius: 10, padding: "9px 11px", fontSize: 13, color: "var(--text)", fontFamily: "inherit", lineHeight: 1.4 }}
            />
            {/* No example goals. Three ready-made sentences under the box are
                three sentences a participant will pick instead of writing their
                own — and what they would have written is the data. */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 7 }}>
              <button
                className="primary"
                style={{ marginLeft: "auto" }}
                disabled={optimizing || reading}
                onClick={() => { void findSolutionsFor(goal); }}
                title="Search your layout with the simulator and offer the setups that work best"
              >
                {reading ? "⏳ Reading…" : optimizing ? "⏳ Searching…" : "✨ Find solutions"}
              </button>
            </div>
            {/* SAY SOMETHING WHEN IT DID NOT UNDERSTAND. This button used to
                return false and stop: no search, no message, nothing moved.
                From the outside that is indistinguishable from a broken button,
                and in a session it would read as the tool ignoring the
                participant. */}
            {unparsed && (
              <p
                style={{
                  marginTop: 8,
                  padding: "8px 10px",
                  borderRadius: 9,
                  border: "1px solid rgba(196,110,84,0.45)",
                  background: "rgba(196,110,84,0.10)",
                  fontSize: 12,
                  lineHeight: 1.45,
                  color: "var(--ink)",
                }}
              >
                {unparsed.reason === "no-goal" || unparsed.reason === "ok" ? (
                  <>
                    I read “{unparsed.text}” but couldn't find a comfort goal in it. Say which room
                    or thing it is about and what you want there — for example “keep the bedroom
                    cool”, “fresh air near the bed”, or “no air blowing on the bed”.
                  </>
                ) : (
                  // Not the participant's fault and not fixable by rephrasing —
                  // say so, and give them the wording that still works. Telling
                  // someone to rephrase a perfectly clear sentence, when the
                  // real problem is an unstarted backend, wastes their session
                  // and reads as the tool blaming them.
                  <>
                    I couldn't reach the part that reads sentences freely, so I only understood
                    “{unparsed.text}” as far as my built-in words go — and none of them are in it.
                    Try naming the room or thing and what you want there, like “keep the bedroom
                    cool”, “fresh air near the bed”, or “no air blowing on the bed”. Drawing it
                    works too.
                  </>
                )}
              </p>
            )}
            {guessedGoal && !unparsed && (
              <p
                style={{
                  marginTop: 8,
                  padding: "8px 10px",
                  borderRadius: 9,
                  border: "1px solid var(--line)",
                  background: "rgba(0,0,0,0.035)",
                  fontSize: 12,
                  lineHeight: 1.45,
                  color: "var(--muted)",
                }}
              >
                I wasn't sure what “{guessedGoal}” was asking for, so I searched against this
                task's own goals instead. If that isn't what you meant, name the room or thing
                and what you want there.
              </p>
            )}
          </>
        ) : (
          <>
            <SketchCanvas />
            <div style={{ display: "flex", gap: 6, marginTop: 7 }}>
              <button
                className="primary"
                style={{ marginLeft: "auto" }}
                disabled={optimizing || sketchMarks.length === 0}
                onClick={() => { applySketchSolution(); }}
                title="Search your layout for setups that match what you drew"
              >
                {optimizing ? "⏳ Searching…" : "✨ Find solutions"}
              </button>
            </div>
          </>
        )}
        {searchedButEmpty && (
          <p
            style={{
              marginTop: 8, padding: "8px 10px", borderRadius: 9,
              border: "1px solid var(--line)", background: "#fff",
              fontSize: 12, lineHeight: 1.45, color: "var(--muted)",
            }}
          >
            I searched your layout for “{(solutionGoal ?? "").trim().slice(0, 40)}” and did not find a
            change worth offering — what you have is already doing the job. Try moving things yourself
            and running the simulation again.
          </p>
        )}
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
              if (g) void checkGoalText(g);
            }}
            onDismiss={dismissSolutions}
          />
        )}
        {/* The prose verdict is suppressed whenever the task has a tick-list —
            two answers to "am I done?" in one panel, one of them contradicting
            the other's thresholds, is worse than either alone. */}
        {!hasScoredGoals && results.map((r, i) => (
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
        {views.map((m) => (
          <button key={m} className={mode === m ? "tool active" : "tool"} onClick={() => setSimMode(m)}>
            {m === "airflow" ? "Airflow" : m === "temperature" ? "Temp" : m === "contamination" ? contaminantLabel : "Noise"}
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
      {/* Adding and relocating sources is an authoring tool, not a move in a
          task: the bin and the damp corner are the PROBLEM, and being able to
          drag the problem somewhere else is not a solution to it. */}
      {mode === "contamination" && !scenarioId && (
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
      <Legend mode={mode} outdoorTemp={outdoorTemp} contaminant={contaminantLabel} />
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
              // A task about a bin gets a freshness reading, not a temperature.
              // Every card on the studio task read "Studio 31.0 °C" — the same
              // outdoor number three times over, telling the participant nothing
              // about the thing they asked about.
              if (o.readout === "drying") {
                const m = o.metrics.roomDryMin.get(id);
                return (
                  <span
                    key={id}
                    style={{
                      fontSize: 11, padding: "2px 6px", borderRadius: 999,
                      border: "1px solid var(--line)",
                      background: m != null ? drySwatch(m) : "transparent",
                    }}
                    title={`${nameOf(id)} — predicted time for the slowest part to dry`}
                  >
                    {nameOf(id)} {m == null ? "—" : m >= 179 ? "stays wet" : `dry in ~${Math.round(m)} min`}
                  </span>
                );
              }
              if (o.readout === "freshness") {
                const f = o.metrics.roomFresh.get(id);
                return (
                  <span
                    key={id}
                    style={{
                      fontSize: 11, padding: "2px 6px", borderRadius: 999,
                      border: "1px solid var(--line)",
                      background: f != null ? rgbCss(smellColor(1 - f)) : "transparent",
                    }}
                    title={`${nameOf(id)} — predicted freshness (100% = swept clean)`}
                  >
                    {nameOf(id)} {f != null ? `${Math.round(f * 100)}% fresh` : "—"}
                  </span>
                );
              }
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
  // `locked` also pins the readout to every room, so a selection left over from
  // free play cannot follow the participant into a task.
  const selected = !locked && tempRoomId ? rooms.find((r) => r.id === tempRoomId) ?? null : null;
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

      {/* In a task, every room is always shown. The picker only ever narrowed
          the readout to one room, which hides the comparison the task is about —
          a bedroom is "warm enough" relative to the room next door, and you
          cannot see that one room at a time. */}
      {!locked && (
        <div className="field" style={{ marginTop: 8 }}>
          <span>show room</span>
          <select value={tempRoomId ?? ""} onChange={(e) => setTempRoom(e.target.value || null)} style={{ maxWidth: 140 }}>
            <option value="">All rooms</option>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </div>
      )}

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

function Legend({ mode, outdoorTemp, contaminant }: { mode: SimMode; outdoorTemp: number; contaminant: string }) {
  if (mode === "temperature") {
    const ticks = [TEMP_MIN_C, 16, TEMP_NEUTRAL_C, 27, TEMP_MAX_C];
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
        <div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600, marginBottom: 4 }}>
          {contaminant === "Humidity" ? "Moisture in the air" : "Contaminant concentration"}
        </div>
        <div style={{ height: 11, borderRadius: 6, background: contaminantGradientCss(contaminant === "Humidity" ? "humidity" : "smell") }} />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--muted)", marginTop: 3 }}>
          <span>{contaminant === "Humidity" ? "Dry" : "Fresh air"}</span>
          <span>{contaminant === "Humidity" ? "Damp" : "Strongest smell"}</span>
        </div>
        <p className="muted-line" style={{ marginTop: 6 }}>
          {contaminant === "Humidity"
            ? "Carried by the airflow, and it only leaves where the air does — dries out near an open window or an extract, and sits where the air is still."
            : "Carried by the airflow: it spreads where the air goes and leaves where the air leaves, so the floor turns green wherever fresh air is reaching and magenta where the smell collects. The scale is fixed, so the same colour always means the same strength — open a window or move the fan, run it again, and the floor greens out as the room actually clears."}
        </p>
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
  // Airflow. The lines are coloured by the temperature of the air they carry, on
  // the same ramp the Temp view uses — so "the warm air off the heater goes
  // straight up and out of the door" is one picture instead of two.
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11.5 }}>
        <span
          style={{
            width: 22,
            height: 3,
            borderRadius: 2,
            flex: "0 0 auto",
            background: `linear-gradient(90deg, ${rgbCss(tempColor(TEMP_MIN_C))}, ${rgbCss(tempColor(TEMP_NEUTRAL_C))}, ${rgbCss(tempColor(TEMP_MAX_C))})`,
          }}
        />
        <span style={{ color: "var(--muted)" }}>one path the air actually takes</span>
      </div>
      <div style={{ height: 9, borderRadius: 5, background: flowGradientCss(), marginTop: 6 }} />
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: "var(--muted)", marginTop: 3 }}>
        <span>coldest air here</span>
        <span>warmest air here</span>
      </div>
      <p className="muted-line" style={{ marginTop: 6 }}>
        The colour of a line is how warm that air is: <b>red</b> where it is carrying heat from the
        heater, <b>blue</b> where it is cold off the glass, and blending through the middle where the
        two have mixed. The two ends are the warmest and coldest air in this home right now, so the
        scale stretches to whatever is actually going on — use the <b>Temp</b> view for real degrees.
        The moving dashes travel the way the air flows — through open doors, out of open windows and
        the entrance, and never through a wall.
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
