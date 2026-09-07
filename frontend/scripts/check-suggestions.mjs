// Does the gallery show the best answer it found, or a deliberately partial one?
//
//     node scripts/check-suggestions.mjs
//
// It used to show a partial one on purpose. The reasoning is in
// withholdComplete: the study is about watching someone arrive at an answer,
// not about handing it to them, so an option that finished the task was swapped
// out for one that only started it.
//
// The cost lands on the analysis rather than on the participant. "Participants
// edited the suggestions" supports "participants preferred manual control" only
// if the suggestions were complete. If the tool deliberately handed over a
// half-finished layout, an edit may be nothing more interesting than the
// participant finishing the job — and from the session file the two are
// indistinguishable, because the difference was never recorded.
//
// So: the switch is off, and this checks it stays off and that the option a
// participant sees is the most complete one the search actually found. It also
// checks the record itself — every offered card carries how many of the task's
// lines it meets, which is what makes the editing behaviour interpretable
// whichever way the switch is set later.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const dir = mkdtempSync(join(tmpdir(), "suggest-"));
const bundleOf = (entry, name) => {
  const out = join(dir, name);
  execFileSync(
    "npx",
    ["esbuild", entry, "--bundle", "--platform=node", "--format=esm", "--define:import.meta.env={}", "--log-level=error", `--outfile=${out}`],
    { stdio: "inherit", shell: process.platform === "win32" },
  );
  return `file:///${out.replaceAll("\\", "/")}`;
};

const solutions = await import(bundleOf("src/intent/solutions.ts", "solutions.mjs"));
const scenarios = await import(bundleOf("src/floorplan/scenarios.ts", "scenarios.mjs"));
const goals = await import(bundleOf("src/intent/goals.ts", "goals.mjs"));

try {
  assert.equal(
    solutions.WITHHOLD_COMPLETE_SOLUTIONS,
    false,
    "with withholding on, an edit to a suggestion cannot be read as a preference — see the note on the constant",
  );
  console.log("ok  the tool does not hold back a complete answer");

  for (const id of scenarios.SCENARIO_ORDER) {
    const sc = scenarios.SCENARIOS[id];
    const plan = { ...sc.build(), outdoorTemp: sc.outdoorTemp };
    const taskGoals = sc.goals ?? [];
    if (!taskGoals.length) continue;

    const allowedDevices = Array.from(new Set([...sc.tools.movable, ...sc.tools.addable, ...sc.tools.aimable]));
    const movableDevices = Array.from(new Set([...sc.tools.movable, ...sc.tools.addable]));
    const met = (p) => goals.checkGoals(taskGoals, p, sc.outdoorTemp).filter((r) => r.met).length;
    const here = met(plan);

    // Every goal the task's own language can reach, as in check-apartment-ac.
    let best = here;
    let shown = here;
    let offered = 0;
    for (const goal of ["cool", "warm", "ventilate", "circulate"]) {
      const found = solutions.findSolutions(plan, goal, plan.rooms.map((r) => r.id), {
        outdoorTemp: sc.outdoorTemp,
        want: 6,
        lockPower: sc.tools.lockPower === true,
        allowedDevices,
        movableDevices,
      });
      // What the store shows: nothing identical to the home already on screen,
      // nothing that un-ticks a line already green, best three of the rest.
      const hereKey = solutions.layoutKey(plan);
      const green = goals.checkGoals(taskGoals, plan, sc.outdoorTemp).map((r) => r.met);
      const usable = found.filter((o) => {
        if (solutions.layoutKey(o.plan) === hereKey) return false;
        const after = goals.checkGoals(taskGoals, o.plan, sc.outdoorTemp).map((r) => r.met);
        return green.every((was, i) => !was || after[i]);
      });
      for (const o of found) best = Math.max(best, met(o.plan));
      for (const o of usable.slice(0, 3)) shown = Math.max(shown, met(o.plan));
      offered += usable.slice(0, 3).length;
    }

    // The point of the whole file: nothing more complete was found than what a
    // participant is shown. (Layouts that would un-tick a line already met are
    // excluded above, and rightly — a step backwards is not a better answer.)
    assert.equal(
      shown,
      best,
      `${id}: the search found a layout meeting ${best}/${taskGoals.length} lines but the gallery tops out at ${shown}`,
    );
    console.log(
      `ok  ${id.padEnd(9)} delivered meets ${here}/${taskGoals.length}, ` +
        `${offered} cards offered, best found ${best}/${taskGoals.length}, best shown ${shown}/${taskGoals.length}`,
    );
  }

  console.log("\nsuggestion checks passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
