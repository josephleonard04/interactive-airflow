// A dial marked 22 has to produce 22.
//
//     node scripts/check-setpoint.mjs
//
// The air conditioner in a free-play home is set to a TEMPERATURE rather than to
// a power level, which is only an improvement if the number means something. The
// solver's field is a delta from outdoors and it decays away from the unit, so
// pinning the unit's own cells to the setpoint leaves the room several degrees
// above it — a dial marked 22 that produces 26 is worse than the 1-2-3 it
// replaced, because it looks like it should be exact.
//
// SETPOINT_GAIN undoes the decay and SETPOINT_BIAS the room's own gains. Both
// were measured here; this keeps them honest, across the range and across
// weather, and checks the study scenarios still take the other path.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const dir = mkdtempSync(join(tmpdir(), "setpoint-"));
const bundleOf = (entry, name) => {
  const out = join(dir, name);
  execFileSync(
    "npx",
    ["esbuild", entry, "--bundle", "--platform=node", "--format=esm", "--define:import.meta.env={}", "--log-level=error", `--outfile=${out}`],
    { stdio: "inherit", shell: process.platform === "win32" },
  );
  return `file:///${out.replaceAll("\\", "/")}`;
};

const home = await import(bundleOf("src/floorplan/home.ts", "home.mjs"));
const sim = await import(bundleOf("src/sim/sim3d.ts", "sim.mjs"));
const scenarios = await import(bundleOf("src/floorplan/scenarios.ts", "scenarios.mjs"));
const catalog = await import(bundleOf("src/floorplan/catalog.ts", "catalog.mjs"));

/** Mean temperature of the room the unit is in, in °C. */
function roomTemp(plan, roomId, outdoorTemp) {
  const built = sim.buildSim3D(plan, {
    targetCells: sim.REPORT_FIDELITY.targetCells,
    iterations: sim.REPORT_FIDELITY.iterations,
    openingDriveDT: Math.abs(outdoorTemp - 21),
  });
  for (let s = 0; s < sim.REPORT_FIDELITY.steps; s++) built.sim.step(0.05);
  const delta = sim.roomMeans(built, sim.geodesicFields(built).temp).get(roomId);
  return outdoorTemp + (delta ?? 0);
}

try {
  const base = home.generateHome({ length: 9, width: 7, height: 2.7 });
  const ac = base.items.find((i) => i.type === "ac");
  assert.ok(ac, "the example home should come with an air conditioner");
  assert.equal(
    ac.setpoint,
    catalog.DEFAULT_AC_SETPOINT,
    "and it should arrive set to a temperature, not to a power level",
  );
  // One unit only: coldMag takes the MAX across cold sources rather than summing
  // them, so a second AC would mask the first and this measurement would be of
  // whichever happened to be colder.
  assert.equal(base.items.filter((i) => i.type === "ac").length, 1);
  console.log(`ok  the example home's AC arrives set to ${ac.setpoint} °C`);

  const set = (plan, setpoint, outdoorTemp) => ({
    ...plan,
    outdoorTemp,
    items: plan.items.map((i) => (i.type === "ac" ? { ...i, on: true, setpoint } : i)),
  });

  // ACROSS THE RANGE AND ACROSS THE WEATHER. The gain is a slope and the bias an
  // intercept, so a single measurement cannot tell a wrong pair from a right one.
  for (const outdoorTemp of [28, 31, 35]) {
    const errors = [];
    for (const setpoint of [18, 20, 22, 24, 26, 28]) {
      const got = roomTemp(set(base, setpoint, outdoorTemp), ac.roomId, outdoorTemp);
      errors.push({ setpoint, got: Number(got.toFixed(2)), off: Number((got - setpoint).toFixed(2)) });
    }
    const worst = errors.reduce((a, b) => (Math.abs(b.off) > Math.abs(a.off) ? b : a));
    console.log(
      `ok  outdoor ${outdoorTemp} °C: ` +
        errors.map((e) => `${e.setpoint}->${e.got}`).join("  ") +
        `  (worst ${worst.off > 0 ? "+" : ""}${worst.off})`,
    );
    assert.ok(
      Math.abs(worst.off) <= 1,
      `set ${worst.setpoint} °C produced ${worst.got} °C — a dial that misses by more than a degree is not a setting`,
    );
  }

  // Monotone: colder setting, colder room. Non-monotonicity here would mean the
  // clamps are biting somewhere inside the offered range.
  const outdoorTemp = 31;
  const temps = [16, 20, 24, 28, 30].map((sp) => roomTemp(set(base, sp, outdoorTemp), ac.roomId, outdoorTemp));
  for (let i = 1; i < temps.length; i++) {
    assert.ok(temps[i] > temps[i - 1], `a warmer setting must not produce a colder room (${temps.join(", ")})`);
  }
  console.log(`ok  monotone across the whole offered range (${catalog.AC_SETPOINT_MIN}-${catalog.AC_SETPOINT_MAX} °C)`);

  // An air conditioner set above the outdoor temperature has nothing to do, and
  // must never come back as a heater.
  //
  // Compared against the room with the unit OFF, not against the outdoor
  // temperature: a home sits about 2 K above outdoors on its own gains, which is
  // what SETPOINT_BIAS exists to cancel. Comparing to outdoors would fail a
  // correct model for a reason that has nothing to do with the air conditioner.
  const idle = roomTemp({ ...base, outdoorTemp: 24, items: base.items.map((i) => (i.type === "ac" ? { ...i, on: false } : i)) }, ac.roomId, 24);
  const setWarm = roomTemp(set(base, 30, 24), ac.roomId, 24);
  // The tolerance is for the JET, not for slop. A unit set above the outdoor
  // temperature stops cooling but keeps blowing — it is still a fan — and
  // stirring the room mixes warmer air down, worth about a tenth of a degree
  // here. What must not happen is the setpoint turning into a heat SOURCE,
  // which would show up as degrees rather than tenths.
  assert.ok(
    setWarm <= idle + 0.3,
    `set above outdoors it must not heat the room: ${setWarm.toFixed(2)} °C against ${idle.toFixed(2)} °C with it off`,
  );
  console.log(
    `ok  set above the outdoor temperature it stops cooling ` +
      `(${setWarm.toFixed(2)} °C, against ${idle.toFixed(2)} with it off — the difference is its jet stirring the room)`,
  );

  // THE STUDY SCENARIOS TAKE THE OTHER PATH. Their units are fixed deliberately
  // and are calibrated against AC_T; a setpoint leaking in would silently
  // recalibrate the apartment task.
  for (const id of scenarios.SCENARIO_ORDER) {
    for (const it of scenarios.SCENARIOS[id].build().items) {
      assert.equal(it.setpoint, undefined, `${id}: ${it.type} must not carry a setpoint`);
    }
  }
  console.log("ok  no study scenario carries a setpoint, so none is recalibrated by this");

  console.log("\nsetpoint checks passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
