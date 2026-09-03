// The apartment task: the AC must never come back switched off, and a correct
// answer has to actually cool both rooms.
//
//     node scripts/check-apartment-ac.mjs
//
// The brief for that task says the air conditioner runs on medium and the dial
// is fixed — the participant cannot turn it up, and the panel hides the power
// block entirely (ScenarioTools.lockPower). So a solution that hands back a
// home with the AC off hands back a home whose only cooling cannot be revived:
// there is no control anywhere that explains why the room is warm.
//
// Runs the real search — the same findSolutions the panel calls, with the same
// options the store passes — across every goal the task's own language can
// produce, and checks every offered arrangement.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const dir = mkdtempSync(join(tmpdir(), "ac-"));
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
const outcomes = await import(bundleOf("src/intent/outcomes.ts", "outcomes.mjs"));
const goals = await import(bundleOf("src/intent/goals.ts", "goals.mjs"));

const SC = scenarios.SCENARIOS.smell; // the apartment — see outcomes.ts on the ids
const plan = SC.build();
const OUT = SC.outdoorTemp;

const acOf = (p) => p.items.find((i) => i.type === "ac");
const roomTemps = (p) => {
  const r = outcomes.measureOutcomes("smell", p, OUT);
  return {
    living: r.find((x) => x.id === "living_temperature").value,
    bedroom: r.find((x) => x.id === "bedroom_temperature").value,
    bedAir: r.find((x) => x.id === "bed_airflow").value,
  };
};

// Exactly what the store passes for this scenario.
const allowedDevices = Array.from(new Set([...SC.tools.movable, ...SC.tools.addable, ...SC.tools.aimable]));
const movableDevices = Array.from(new Set([...SC.tools.movable, ...SC.tools.addable]));
const taskZones = (SC.goals ?? []).map((g) => {
  let zone = null;
  if (g.nearItem) {
    const it = plan.items.find((i) => i.type === g.nearItem);
    if (it) {
      const swapped = Math.abs(Math.round(it.rotationY / (Math.PI / 2))) % 2 === 1;
      const w = swapped ? it.size[2] : it.size[0];
      const d = swapped ? it.size[0] : it.size[2];
      zone = { x: it.position[0] - w / 2, z: it.position[2] - d / 2, w, d };
    }
  }
  return { metric: g.metric, zone, roomId: g.roomId, everywhere: g.everywhere, atLeast: g.atLeast, atMost: g.atMost };
});

// Every goal this task's language can reach: typing, sketching, and the
// combination all funnel into one of these before the search sees them.
const GOALS = ["cool", "circulate", "ventilate", "warm"];

try {
  const base = roomTemps(plan);
  console.log(`delivered:  living ${base.living}°C  bedroom ${base.bedroom}°C  bed air ${base.bedAir} m/s`);
  assert.equal(acOf(plan).on, true, "the task delivers the home with the AC running");

  let offered = 0;
  const acOff = [];
  let best = null;

  for (const goal of GOALS) {
    for (const targetIds of [["living", "bedroom"], ["bedroom"], ["living"]]) {
      const found = solutions.findSolutions(plan, goal, targetIds, {
        taskZones,
        outdoorTemp: OUT,
        want: 3,
        lockPower: SC.tools.lockPower === true,
        allowedDevices,
        movableDevices,
      });
      for (const sol of found) {
        offered++;
        const ac = acOf(sol.plan);
        if (!ac || ac.on === false || ac.on === undefined) {
          acOff.push({ goal, targets: targetIds.join("+"), label: sol.label, on: ac?.on });
        }
        if (goal === "cool" && targetIds.length === 2) {
          const t = roomTemps(sol.plan);
          const worst = Math.max(t.living, t.bedroom);
          if (!best || worst < best.worst) best = { ...t, worst, label: sol.label };
        }
      }
    }
  }

  console.log(`searched:   ${offered} arrangements across ${GOALS.length} goals`);

  if (acOff.length) {
    console.log(`\nAC OFF in ${acOff.length} of ${offered} offered arrangements:`);
    for (const r of acOff.slice(0, 8)) console.log(`   goal=${r.goal} targets=${r.targets} on=${r.on}  "${r.label}"`);
  } else {
    console.log("ok  the AC is on in every offered arrangement");
  }

  if (best) {
    console.log(`\nbest cooling found: living ${best.living}°C  bedroom ${best.bedroom}°C  ("${best.label}")`);
  }

  // THE GALLERY MUST NOT EMPTY ITSELF NOW THAT THE ROOMS ARE COOLER.
  //
  // The task's own temperature line is "everywhere at most 25 C", which a
  // stronger AC now meets on delivery. withholdComplete drops options that
  // finish the task, so the risk is a "Find solutions" button that finds
  // nothing on a home whose bed is still being blown on. Run the store's exact
  // path and check something comes back.
  {
    const taskGoals = SC.goals ?? [];
    const found = solutions.findSolutions(plan, "cool", ["living", "bedroom"], {
      taskZones, outdoorTemp: OUT, want: 3,
      lockPower: SC.tools.lockPower === true, allowedDevices, movableDevices,
    });
    const offeredAfterWithholding = solutions.withholdComplete(
      found,
      (p) => ({ met: goals.checkGoals(taskGoals, p, OUT).filter((r) => r.met).length, total: taskGoals.length }),
      "cool", plan, ["living", "bedroom"], OUT, 3, allowedDevices,
    );
    const met = goals.checkGoals(taskGoals, plan, OUT);
    console.log(`delivered meets ${met.filter((r) => r.met).length}/${met.length} of the task's own lines`);
    assert.ok(
      offeredAfterWithholding.length > 0,
      "the gallery must still offer something after withholding, or Find solutions finds nothing",
    );
    console.log(`ok  ${offeredAfterWithholding.length} arrangements survive withholding`);
  }

  assert.equal(acOff.length, 0, "a locked-power task must never hand back a home with its only cooling switched off");
  assert.ok(best, "the cooling goal must offer at least one arrangement");
  assert.ok(
    best.worst <= 21,
    `a correct solution should get both rooms to about 20 °C; warmest room was ${best.worst} °C`,
  );
  console.log("\napartment AC checks passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
