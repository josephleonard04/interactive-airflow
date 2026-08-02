import { useEffect } from "react";
import { SCENARIOS } from "../floorplan/scenarios";
import { checkGoals } from "../intent/goals";
import { useSceneStore } from "../scene/store";

// The task's success conditions, scored continuously and shown to NOBODY.
//
// This replaces the live tick-list (Prof. Igarashi, 2026-08-03). His objection:
// a visible tick-box becomes the task. The participant optimises toward the box
// rather than toward a home they would want to live in, and stops the instant it
// goes green instead of when they are actually satisfied — which is the very
// judgement the study is trying to observe. The brief now states the situation,
// the goal, and what may and may not be changed; when they are done is their
// call, and Submit is how they say so.
//
// Nothing is lost from the data. The goals are still evaluated on every change,
// and every transition is written to the session log with a timestamp, so the
// file still answers "did they reach it, and when?" — better than the checklist
// did, because now the moment they reached it is not also the moment they were
// told. That gap is exactly the calibration measure (do they believe the goal
// held?) the post-study questionnaire asks about.
//
// Renders nothing. It lives in the panel only because it needs to be mounted
// while a scenario is open.

/** Which simulation view has to have been watched before a goal can be scored. */
const MODE_FOR = {
  temperature: "temperature",
  smell: "contamination",
  draft: "airflow",
  drying: "contamination",
} as const;

export function GoalLogger() {
  const scenarioId = useSceneStore((s) => s.scenarioId);
  const plan = useSceneStore((s) => s.plan);
  const outdoorTemp = useSceneStore((s) => s.outdoorTemp);
  const recorded = useSceneStore((s) => s.simulatedModes);
  const simActive = useSceneStore((s) => s.simActive);
  const simReady = useSceneStore((s) => s.simReady);
  const simMode = useSceneStore((s) => s.simMode);
  const logGoalStatus = useSceneStore((s) => s.logGoalStatus);

  const goals = scenarioId ? SCENARIOS[scenarioId].goals : undefined;

  // Same gate the checklist used: a goal is only scored once its view has
  // actually converged, so the log never records a verdict computed from a
  // half-solved field.
  const simulated = simActive && simReady && !recorded.includes(simMode) ? [...recorded, simMode] : recorded;
  const unlocked = (goals ?? []).some((g) => simulated.includes(MODE_FOR[g.metric]));

  useEffect(() => {
    if (!goals?.length || !unlocked) return;
    let cancelled = false;
    // Off the paint path — the scoring solve is heavy enough to drop a frame if
    // it runs inline with the edit that triggered it.
    const id = window.setTimeout(() => {
      const ready = goals.filter((g) => simulated.includes(MODE_FOR[g.metric]));
      const scored = new Map(checkGoals(ready, plan, outdoorTemp).map((r) => [r.label, r]));
      if (cancelled) return;
      // logGoalStatus de-duplicates, so this writes one entry per CHANGE of
      // verdict rather than one per re-solve.
      logGoalStatus(
        goals.map((g) => {
          const r = scored.get(g.label);
          return { label: g.label, met: r?.met ?? false, detail: r?.detail ?? "" };
        }),
      );
    }, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goals, plan, outdoorTemp, unlocked, recorded, simActive, simReady, simMode]);

  return null;
}
