// Name a machine and that is the machine that moves.
//
//     node scripts/check-scoping.mjs
//
// "Move the fan into the bedroom" is a request about the fan. A search that also
// re-aims the air conditioner has not given a better answer, it has given a
// different one — and the participant now has to audit the layout to find what
// else changed.
//
// The trap on the other side is worse than the bug: "make it cooler" must NOT
// scope to the air conditioner, or the commonest phrasing there is silently
// forbids the fan. So this checks both directions — what the words catch, and
// what they must not.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const dir = mkdtempSync(join(tmpdir(), "scope-"));
const bundleOf = (entry, name) => {
  const out = join(dir, name);
  execFileSync(
    "npx",
    ["esbuild", entry, "--bundle", "--platform=node", "--format=esm", "--define:import.meta.env={}", "--log-level=error", `--outfile=${out}`],
    { stdio: "inherit", shell: process.platform === "win32" },
  );
  return `file:///${out.replaceAll("\\", "/")}`;
};

const optimize = await import(bundleOf("src/intent/optimize.ts", "optimize.mjs"));
const solutions = await import(bundleOf("src/intent/solutions.ts", "solutions.mjs"));
const home = await import(bundleOf("src/floorplan/home.ts", "home.mjs"));

const named = (t) => optimize.devicesNamedIn(t).sort();

try {
  // --- what the words catch ------------------------------------------------

  const catches = [
    ["move the fan into the bedroom", ["fan"]],
    ["turn the fan off", ["fan"]],
    ["point the ac at the window", ["ac"]],
    ["the air conditioner is blowing on me", ["ac"]],
    ["set the air-con lower", ["ac"]],
    ["put the heater under the window", ["heater"]],
    ["the radiator is in the wrong place", ["heater"]],
    ["move the exhaust vent nearer the shower", ["return"]],
    ["use the fan and the ac together", ["ac", "fan"]],
    // "vent" without saying which names both, because that is what a person
    // means when there is one vent in the room.
    ["move the vent", ["return", "supply"]],
  ];
  for (const [text, want] of catches) {
    assert.deepEqual(named(text), want.sort(), `"${text}" should name ${want.join("+")}`);
  }
  console.log(`ok  ${catches.length} sentences scope to the equipment they name`);

  // --- what they must NOT catch -------------------------------------------
  //
  // Every one of these is a comfort word or an ordinary sentence. Any of them
  // scoping the search would quietly remove devices from consideration on the
  // most natural phrasings in the study.
  const mustNotCatch = [
    "make it cooler in here",
    "i want the bedroom warmer",
    "it is too hot",
    "keep this area out of the draught",
    "the air is stuffy after cooking",
    "cool the living room and the bedroom",
    "keep the smell off the bed",
    "dry the bathroom out faster",
    "fantastic weather today",
    "the infant is too cold",
  ];
  for (const text of mustNotCatch) {
    assert.deepEqual(named(text), [], `"${text}" names no equipment and must not scope the search`);
  }
  console.log(`ok  ${mustNotCatch.length} comfort sentences leave the search free to use anything`);

  // --- and it actually binds the search ------------------------------------

  const plan = home.generateHome({ length: 9, width: 7, height: 2.7 });
  const rooms = plan.rooms.map((r) => r.id);
  const movedTypes = (before, after) => {
    const was = new Map(before.items.map((i) => [i.id, i]));
    const out = new Set();
    for (const it of after.items) {
      const b = was.get(it.id);
      if (!b) continue;
      const moved =
        Math.hypot(it.position[0] - b.position[0], it.position[2] - b.position[2]) > 1e-6 ||
        Math.abs(it.rotationY - b.rotationY) > 1e-6 ||
        (it.tilt ?? 0) !== (b.tilt ?? 0) ||
        it.on !== b.on ||
        it.power !== b.power;
      if (moved) out.add(it.type);
    }
    return out;
  };

  const search = (allowedDevices) =>
    solutions.findSolutions(plan, "cool", rooms, { outdoorTemp: 31, want: 3, allowedDevices });

  // Free play lets the search touch anything…
  const open = search(undefined);
  const touchedOpen = new Set();
  for (const s of open) for (const t of movedTypes(plan, s.plan)) touchedOpen.add(t);
  assert.ok(open.length > 0, "the unscoped search must offer something to compare against");

  // …and naming the fan confines it to the fan.
  const scoped = search(optimize.devicesNamedIn("just move the fan"));
  assert.ok(scoped.length > 0, "a scoped search must still offer something");
  const touchedScoped = new Set();
  for (const s of scoped) for (const t of movedTypes(plan, s.plan)) touchedScoped.add(t);
  for (const t of touchedScoped) {
    assert.equal(t, "fan", `naming the fan must not move the ${t}`);
  }
  console.log(
    `ok  the search obeys it: unscoped touched {${[...touchedOpen].join(", ") || "nothing"}}, ` +
      `"just move the fan" touched {${[...touchedScoped].join(", ") || "nothing"}}`,
  );

  console.log("\nscoping checks passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
