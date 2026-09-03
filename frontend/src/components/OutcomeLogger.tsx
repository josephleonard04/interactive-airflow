import { useEffect } from "react";
import { SCENARIO_OUTCOMES, measureOutcomes } from "../intent/outcomes";
import { useSceneStore } from "../scene/store";

// The task's own quantities, read continuously and shown to NOBODY.
//
// This replaces the hidden tick-list, which itself replaced a visible one
// (Prof. Igarashi, 2026-08-03: a visible tick-box becomes the task — the
// participant optimises toward the box rather than toward a home they would
// want to live in, and stops the instant it goes green rather than when they
// are satisfied).
//
// Hiding the checklist fixed that and left a subtler problem: what got written
// down was still a VERDICT. "Bedroom is comfortable: false" is a statement
// about an 18 °C threshold somebody chose, and moving that threshold flips the
// same session from failure to success. It also flattens the interesting cases
// — a participant who takes a bedroom from 9 °C to 17 °C and one who leaves it
// at 9 °C both fail an 18 °C box, and the file cannot tell them apart.
//
// So what is recorded now is the quantity itself, each time it moves: bedroom
// 9.4 °C, 12.1 °C, 16.8 °C. The improvement against the home as delivered is
// computed at submit; how much of it counted as enough is a decision for the
// analysis, and it can be made — and remade — long after the session.
//
// Renders nothing. It lives in the panel only because it needs to be mounted
// while a scenario is open.

export function OutcomeLogger() {
  const scenarioId = useSceneStore((s) => s.scenarioId);
  const plan = useSceneStore((s) => s.plan);
  const outdoorTemp = useSceneStore((s) => s.outdoorTemp);
  const simActive = useSceneStore((s) => s.simActive);
  const simMode = useSceneStore((s) => s.simMode);
  const logOutcomeReading = useSceneStore((s) => s.logOutcomeReading);

  const measures = scenarioId ? SCENARIO_OUTCOMES[scenarioId] : undefined;

  // From the moment they press Simulate, and no earlier — a trace that starts
  // before that records the delivered home over and over.
  //
  // GATED ON NOTHING ELSE, and both of the old gates are worth explaining. The
  // tick-list waited for the participant to open the view matching the goal's
  // metric, because a verdict must not be read off a half-solved field; and it
  // waited for that field to converge. Neither applies here: this reading is its
  // own report-fidelity solve and never touches the on-screen field.
  //
  // Keeping them cost real data. Waiting on the view meant a participant who
  // worked in the airflow tab left no trajectory at all — exactly the
  // participant whose trajectory you would want. Waiting on convergence meant
  // the same on any machine slow enough that the display solve lagged, and on a
  // backgrounded tab, where the render loop stops entirely and the file would
  // have come back empty with nothing to say why.
  const unlocked = simActive;

  useEffect(() => {
    if (!scenarioId || !measures?.length || !unlocked) return;
    let cancelled = false;
    // Off the paint path — the reading is a full report-fidelity solve and runs
    // inline with the edit that triggered it otherwise, dropping a frame.
    const id = window.setTimeout(() => {
      const readings = measureOutcomes(scenarioId, plan, outdoorTemp);
      if (cancelled) return;
      // logOutcomeReading de-duplicates on the values, so this writes one entry
      // per real change rather than one per re-solve.
      logOutcomeReading(readings);
    }, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarioId, measures, plan, outdoorTemp, unlocked, simActive, simMode]);

  return null;
}
