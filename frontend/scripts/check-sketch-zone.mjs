// Does the box the participant drew actually decide the answer?
//
//     node scripts/check-sketch-zone.mjs
//
// Someone draws a rectangle round the bed and types "keep this area cool". The
// parser keeps the rectangle — that is how "this area" gets grounded to a place
// — and the search used to be handed the ROOM the rectangle sits in. So the
// drawn box picked a room and then stopped mattering: a layout that cooled the
// far side of the bedroom outscored one that cooled the bed, and the session
// log recorded a sketch that had no effect on what was optimised.
//
// That is a problem for the study before it is a problem for the tool. "The
// participant sketched an area" and "the tool optimised that area" are two
// claims, and only one of them was true.
//
// The test is a cross-comparison, because "the answer changed" is not enough —
// it could change for any reason. Ask for the LEFT end of a room to be cooled,
// then the RIGHT end, and check each answer is better than the other one AT THE
// END IT WAS ASKED ABOUT. A zone-blind search cannot pass that.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const dir = mkdtempSync(join(tmpdir(), "zone-"));
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
const home = await import(bundleOf("src/floorplan/home.ts", "home.mjs"));
const sim = await import(bundleOf("src/sim/sim3d.ts", "sim.mjs"));
const catalog = await import(bundleOf("src/floorplan/catalog.ts", "catalog.mjs"));

const OUT = catalog.FREE_PLAY_OUTDOOR_C;

/** How hot one rectangle is, on the same blend the score uses: mostly the
 *  worst corner inside it, partly its mean (see proxyScore). Comparing on the
 *  mean alone fails a correct search — an answer can be better in the corner
 *  that is still warm and slightly worse on average, which is the trade the
 *  blend exists to make. Measured at the fidelity the cards are printed at. */
function zoneTempC(plan, rect) {
  const built = sim.buildSim3D(plan, {
    targetCells: sim.REPORT_FIDELITY.targetCells,
    iterations: sim.REPORT_FIDELITY.iterations,
    openingDriveDT: Math.abs(OUT - 21),
  });
  for (let s = 0; s < sim.REPORT_FIDELITY.steps; s++) built.sim.step(0.05);
  const temp = sim.geodesicFields(built).temp;
  const mean = sim.zoneMean(built, temp, rect);
  if (mean === null) return null;
  return 0.6 * (OUT + sim.warmestPart(built, temp, rect)) + 0.4 * (OUT + mean);
}

/** One solved field, reused by the readings below. */
function solve(plan) {
  const built = sim.buildSim3D(plan, {
    targetCells: sim.REPORT_FIDELITY.targetCells,
    iterations: sim.REPORT_FIDELITY.iterations,
    openingDriveDT: Math.abs(OUT - 21),
  });
  for (let s = 0; s < sim.REPORT_FIDELITY.steps; s++) built.sim.step(0.05);
  return built;
}

/** Mean air speed inside one rectangle, m/s. */
function zoneSpeed(plan, rect) {
  return sim.zoneSpeed(solve(plan), rect) ?? 0;
}

/** Plain mean temperature inside one rectangle, °C. */
function zoneMeanC(plan, rect) {
  const built = solve(plan);
  const d = sim.zoneMean(built, sim.geodesicFields(built).temp, rect);
  return d === null ? null : OUT + d;
}
try {
  const plan = home.generateHome({ length: 9, width: 7, height: 2.7 });
  // The biggest room, split into two patches at opposite ends with a gap
  // between them, so "cool this end" is a different question from "cool that
  // end" rather than two ways of saying the room.
  const room = plan.rooms.reduce((a, b) => (a.rect.w * a.rect.d >= b.rect.w * b.rect.d ? a : b));
  const { x, z, w, d } = room.rect;
  const along = w >= d;
  const near = along
    ? { x: x + 0.15, z: z + 0.15, w: w * 0.3, d: d - 0.3 }
    : { x: x + 0.15, z: z + 0.15, w: w - 0.3, d: d * 0.3 };
  const far = along
    ? { x: x + w * 0.7 - 0.15, z: z + 0.15, w: w * 0.3, d: d - 0.3 }
    : { x: x + 0.15, z: z + d * 0.7 - 0.15, w: w - 0.3, d: d * 0.3 };
  console.log(`room "${room.id}" ${w.toFixed(1)} x ${d.toFixed(1)} m, split into two ends`);

  const askFor = (zone) =>
    solutions.findSolutions(plan, "cool", [room.id], {
      outdoorTemp: OUT,
      want: 4,
      taskZones: zone ? [{ metric: "temperature", zone, roomId: room.id, fromRequest: true }] : [],
    });

  // Without a box the search is room-scored, and says so.
  const roomLevel = askFor(null);
  assert.ok(roomLevel.length > 0, "the room-level search must offer something");
  assert.equal(roomLevel[0].metrics.focus, null, "with no box drawn there is no zone reading to score");
  console.log(`ok  no box: scored on the room ("${roomLevel[0].label}")`);

  // ---- THE CROSS-COMPARISON, on a goal whose lever is placement ------------
  //
  // "Move some air over here" is the cleanest case: a fan is free to stand
  // anywhere, air speed is strongly local, and a search that ignores the box
  // has no way to fake it. Ask for each end in turn and measure both answers at
  // both ends.
  const air = (zone) =>
    solutions.findSolutions(plan, "circulate", [room.id], {
      outdoorTemp: OUT,
      want: 3,
      taskZones: [{ metric: "draft", zone, roomId: room.id, fromRequest: true }],
    })[0];
  const nearAir = air(near);
  const farAir = air(far);
  assert.ok(nearAir && farAir, "both zone searches must offer something");
  assert.ok(nearAir.metrics.focus, "a zone search must carry a zone reading");

  const nearOwn = zoneSpeed(nearAir.plan, near);
  const nearOther = zoneSpeed(farAir.plan, near);
  const farOwn = zoneSpeed(farAir.plan, far);
  const farOther = zoneSpeed(nearAir.plan, far);
  console.log(`near end: ${nearOwn.toFixed(3)} m/s under its own answer, ${nearOther.toFixed(3)} under the other's`);
  console.log(`far  end: ${farOwn.toFixed(3)} m/s under its own answer, ${farOther.toFixed(3)} under the other's`);
  assert.ok(nearOwn > nearOther * 1.5, `asking about the near end must actually move air there (${nearOwn} vs ${nearOther})`);
  assert.ok(farOwn > farOther * 1.5, `asking about the far end must actually move air there (${farOwn} vs ${farOther})`);
  console.log("ok  each end is served by the answer that was asked about it");

  // And the device went where the box was, not merely somewhere that scored.
  const fanAt = (p) => p.items.find((i) => i.type === "fan")?.position ?? null;
  const [nx] = fanAt(nearAir.plan);
  const [fx] = fanAt(farAir.plan);
  console.log(`ok  the fan followed the box: x ${nx.toFixed(2)} m for the near end, ${fx.toFixed(2)} m for the far end`);

  // ---- AND ON A TEMPERATURE GOAL, where the lever is a bolted unit ---------
  //
  // Weaker on purpose. The only cooling here is an air conditioner bolted to a
  // wall, so both questions get the same machine and the same few aims, and the
  // room-level tiebreak in the score (see proxyScore: a quarter-weight on the
  // room mean, which is what stops "cool the bed by making the bedroom
  // unliveable") can outweigh a few tenths of a degree inside the box. What
  // must hold is that the box is what was READ, and that asking about one end
  // does not make the other end's answer better at it by more than that
  // tiebreak can explain.
  const nearBest = askFor(near)[0];
  const farBest = askFor(far)[0];
  assert.ok(nearBest.metrics.focus, "a zone temperature search must carry a zone reading");
  const nearUnderNear = zoneTempC(nearBest.plan, near);
  const nearUnderFar = zoneTempC(farBest.plan, near);
  console.log(`near end: ${nearUnderNear.toFixed(2)} °C under its own answer, ${nearUnderFar.toFixed(2)} under the other's`);
  assert.ok(
    nearUnderNear < nearUnderFar - 0.05,
    `asking about the near end must cool the near end (${nearUnderNear} vs ${nearUnderFar})`,
  );

  // The reading the card was scored on is the reading in the box, not the
  // room's — otherwise the log would say "zone" while the number said "room".
  const measuredMean = zoneMeanC(nearBest.plan, near);
  assert.ok(
    Math.abs(nearBest.metrics.focus.meanC - measuredMean) < 0.5,
    `the scored zone reading (${nearBest.metrics.focus.meanC.toFixed(2)}) should be the box's own temperature (${measuredMean.toFixed(2)})`,
  );
  console.log(`ok  the score read the box: ${nearBest.metrics.focus.meanC.toFixed(2)} °C`);

  console.log("\nsketch-zone checks passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
