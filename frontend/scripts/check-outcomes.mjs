// Do the outcome measures actually measure anything?
//
//     node scripts/check-outcomes.mjs
//
// Bundles the real modules and runs them against the real scenario homes. The
// point is not that the numbers are right to three decimals — it is that each
// task's quantity RESPONDS to the thing that task is about, and in the right
// direction. A measure that returns the same value however the home is
// arranged would produce a session file full of zeroes and nobody would notice
// until the study was over.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const dir = mkdtempSync(join(tmpdir(), "outcomes-"));
const bundle = join(dir, "bundle.mjs");

// The modules import from "../sim/..." etc., so bundling is the only way to run
// them outside Vite. Same trick the README documents for measuring the solver.
execFileSync(
  "npx",
  [
    "esbuild",
    "src/intent/outcomes.ts",
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--define:import.meta.env={}",
    "--log-level=error",
    `--outfile=${bundle}`,
  ],
  { stdio: "inherit", shell: process.platform === "win32" },
);
const scenarioBundle = join(dir, "scenarios.mjs");
execFileSync(
  "npx",
  [
    "esbuild",
    "src/floorplan/scenarios.ts",
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--define:import.meta.env={}",
    "--log-level=error",
    `--outfile=${scenarioBundle}`,
  ],
  { stdio: "inherit", shell: process.platform === "win32" },
);

const { SCENARIO_OUTCOMES, measureOutcomes, compareOutcomes, summarizeOutcomes } = await import(
  `file:///${bundle.replaceAll("\\", "/")}`
);
const { SCENARIOS, SCENARIO_ORDER } = await import(`file:///${scenarioBundle.replaceAll("\\", "/")}`);

const val = (rs, id) => rs.find((r) => r.id === id)?.value ?? null;

try {
  // --- every task has measures, and every measure reads on its own home ------

  for (const id of SCENARIO_ORDER) {
    const sc = SCENARIOS[id];
    const plan = sc.build();
    const readings = measureOutcomes(id, plan, sc.outdoorTemp);
    assert.ok(readings.length > 0, `${id} has no outcome measures`);
    for (const r of readings) {
      assert.notEqual(r.value, null, `${id}: ${r.id} could not be read on its own scenario home`);
      assert.ok(Number.isFinite(r.value), `${id}: ${r.id} is not a finite number`);
    }
    // The bathroom is read as % RH now, and it has to be a percentage: a value
    // outside 0-100 would mean the mapping had broken, not that the room was
    // unusually damp.
    if (id === "humidity") {
      assert.equal(readings[0].unit, "% RH");
      assert.ok(readings[0].value > 50 && readings[0].value <= 100, `bathroom RH out of range: ${readings[0].value}`);
    }
    console.log(
      `ok  ${id.padEnd(9)} ${readings.map((r) => `${r.id}=${r.value}${r.unit === "°C" ? "°C" : ""}`).join("  ")}`,
    );
  }

  // --- winter: turning the heater off must make it measurably colder ---------

  {
    const sc = SCENARIOS.winter;
    const warm = sc.build();
    const cold = { ...warm, items: warm.items.map((it) => (it.type === "heater" ? { ...it, on: false, power: 1 } : it)) };

    const before = measureOutcomes("winter", cold, sc.outdoorTemp);
    const after = measureOutcomes("winter", warm, sc.outdoorTemp);
    const deltas = compareOutcomes(before, after);

    for (const d of deltas) {
      assert.equal(d.betterWhen, "higher", "winter wants rooms warmer");
      assert.ok(d.improvement > 0, `${d.id}: heater on should read warmer than heater off (got ${d.improvement})`);
      // Celsius has an arbitrary zero, so a percentage of it is not a quantity.
      assert.equal(d.percentImprovement, null, "no percentages on an interval scale");
    }
    const summary = summarizeOutcomes("winter", deltas);
    assert.equal(summary.unit, "°C");
    assert.ok(summary.value > 0);
    console.log(
      `ok  winter    heater on vs off: living ${deltas[0].improvement}°C, bedroom ${deltas[1].improvement}°C, mean ${summary.value}°C`,
    );
  }

  // --- apartment (id "smell"): the draft measure must see the fan -----------

  {
    const sc = SCENARIOS.smell;
    const still = sc.build();
    const bed = still.items.find((i) => i.type === "bed");
    // Put the fan on the bed and switch it on — the exact thing this task is
    // about not doing.
    const blown = {
      ...still,
      items: still.items.map((it) =>
        it.type === "fan"
          ? { ...it, on: true, power: 3, position: [bed.position[0], it.position[1], bed.position[2] + 0.9] }
          : it,
      ),
    };

    const a = measureOutcomes("smell", still, sc.outdoorTemp);
    const b = measureOutcomes("smell", blown, sc.outdoorTemp);
    assert.ok(
      val(b, "bed_airflow") > val(a, "bed_airflow"),
      `a fan aimed at the bed must read as more air over it (${val(a, "bed_airflow")} -> ${val(b, "bed_airflow")})`,
    );

    // Improvement is signed so that positive is always better, whichever way
    // the measure runs — here more air over the bed is worse.
    const worse = compareOutcomes(a, b).find((d) => d.id === "bed_airflow");
    assert.ok(worse.improvement < 0, "more draft on the bed must score as negative improvement");
    assert.ok(worse.percentImprovement < 0, "and as a negative percentage, since m/s has a real zero");

    const cooling = compareOutcomes(a, b).filter((d) => d.id.endsWith("_temperature"));
    for (const d of cooling) assert.equal(d.betterWhen, "lower", "the apartment task wants rooms cooler");
    // Averaging °C with m/s would be arithmetic on unlike units.
    assert.equal(summarizeOutcomes("smell", compareOutcomes(a, b)), null, "no single summary for a three-way tradeoff");
    console.log(`ok  smell     fan on the bed: air over bed ${val(a, "bed_airflow")} -> ${val(b, "bed_airflow")} m/s`);
  }

  // --- studio (id "summer"): odour at the bed responds to ventilation -------

  {
    const sc = SCENARIOS.summer;
    const shut = sc.build();
    // Airing the studio out is the move this task is about. (Relocating the bin
    // is the other one, but a source dragged onto the bed lands inside the bed's
    // own solid and stops emitting entirely — which reads as zero odour and is
    // an artefact of the test, not a finding.)
    const aired = {
      ...shut,
      windows: shut.windows.map((w) => ({ ...w, open: true })),
      doors: shut.doors.map((d) => ({ ...d, open: true })),
    };

    const a = measureOutcomes("summer", shut, sc.outdoorTemp);
    const b = measureOutcomes("summer", aired, sc.outdoorTemp);
    assert.ok(
      val(b, "bed_odor") < val(a, "bed_odor"),
      `airing the studio must read as less odour at the bed (${val(a, "bed_odor")} -> ${val(b, "bed_odor")})`,
    );

    const d = compareOutcomes(a, b).find((x) => x.id === "bed_odor");
    assert.ok(d.improvement > 0, "less odour at the bed must score as an improvement");
    assert.ok(d.percentImprovement > 0, "and odour is a ratio scale, so a percentage is meaningful");
    assert.equal(d.improvementIsLowerBound, false, "nothing censored here");

    // The other direction must score negative, or "improvement" is just a
    // magnitude with a hopeful name.
    const backwards = compareOutcomes(b, a).find((x) => x.id === "bed_odor");
    assert.ok(backwards.improvement < 0, "shutting it back up must score as negative");

    const summary = summarizeOutcomes("summer", compareOutcomes(a, b));
    assert.equal(summary.unit, "%");
    console.log(
      `ok  summer    aired out: odour at the bed ${val(a, "bed_odor")} -> ${val(b, "bed_odor")} ` +
        `(${summary.value}% reduction)`,
    );
  }

  // --- bathroom: the right arrangement must lower the humidity -------------
  //
  // Opening the window where it is built does almost nothing — the extract
  // beside it short-circuits the make-up air — and that is the lesson, so it is
  // checked. Moving the extract across the room with the window open is the
  // fix, and it has to read as a real drop in RH points.

  {
    const sc = SCENARIOS.humidity;
    const shut = { ...sc.build(), outdoorTemp: sc.outdoorTemp };
    const opened = { ...shut, windows: shut.windows.map((w) => ({ ...w, open: true })) };
    const room = shut.rooms.find((r) => r.id === "bathroom").rect;
    const fixedVent = {
      ...opened,
      items: opened.items.map((it) =>
        it.type === "return" ? { ...it, position: [room.x + 0.12, it.position[1], room.z + room.d * 0.2], rotationY: Math.PI / 2 } : it,
      ),
    };

    const a = measureOutcomes("humidity", shut, sc.outdoorTemp);
    const onlyOpened = measureOutcomes("humidity", opened, sc.outdoorTemp);
    const b = measureOutcomes("humidity", fixedVent, sc.outdoorTemp);
    const goal = sc.goals[0].atMost;
    assert.equal(sc.goals[0].metric, "humidity", "the bathroom task is scored on humidity, not drying time");
    assert.ok(val(a, "bathroom_humidity") > goal, "the bathroom as delivered must start above the goal");
    assert.ok(val(onlyOpened, "bathroom_humidity") > goal, "opening the window alone must not solve it — the short circuit is the lesson");

    const d = compareOutcomes(a, b).find((x) => x.id === "bathroom_humidity");
    assert.equal(d.betterWhen, "lower", "lower humidity is better");
    assert.ok(val(b, "bathroom_humidity") <= goal, `the fix must meet the goal (${val(b, "bathroom_humidity")} vs ${goal})`);
    assert.ok(d.improvement > 5, `and read as a real drop in RH points (got ${d.improvement})`);
    assert.equal(d.percentImprovement, null, "no percentage of a percentage");
    const summary = summarizeOutcomes("humidity", compareOutcomes(a, b));
    assert.equal(summary.unit, "RH points");
    console.log(
      `ok  humidity  delivered ${val(a, "bathroom_humidity")}% RH, window opened ${val(onlyOpened, "bathroom_humidity")}%, ` +
        `extract moved ${val(b, "bathroom_humidity")}% (${summary.label.toLowerCase()} ${summary.value} points)`,
    );
  }

  // --- an unmeasurable reading stays null rather than becoming a zero --------

  {
    const sc = SCENARIOS.summer;
    const noBed = sc.build();
    const stripped = { ...noBed, items: noBed.items.filter((i) => i.type !== "bed") };
    const readings = measureOutcomes("summer", stripped, sc.outdoorTemp);
    assert.equal(val(readings, "bed_odor"), null, "no bed means no bed-zone reading");

    const d = compareOutcomes(measureOutcomes("summer", sc.build(), sc.outdoorTemp), readings)[0];
    assert.equal(d.improvement, null, "an improvement against a missing reading is not zero, it is unknown");
    assert.equal(summarizeOutcomes("summer", [d]), null);
    console.log("ok  a measure that cannot be read reports null, never a fake zero");
  }

  console.log("\noutcome checks passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
