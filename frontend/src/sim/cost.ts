import type { FloorPlan, PlacedItem } from "../floorplan/types";

// Running cost of a configuration.
//
// Study tasks are given a budget, and the budget is what stops "turn everything
// to maximum" from being a valid answer: a comfort-maximising configuration can
// hit the target picture and still lose on cost. Without a number on screen the
// constraint is unenforceable and the participant cannot reason about it.
//
// Units are deliberately abstract ("per hour") rather than yen or watts — the
// ratios are what matter and they are roughly honest:
//   room air conditioner   ~1.0-1.5 kW
//   pedestal fan           ~50 W      (~1/20th)
//   extract fan            ~25 W
//   opening a window       free
// Anything finer would imply a precision the solver does not have.

export const COST_PER_HOUR = {
  /** AC / heater, indexed by power level 1-3. */
  climate: { 1: 1, 2: 2, 3: 3 } as Record<number, number>,
  fan: 0.2,
  vent: 0.1,
};

export interface CostLine {
  label: string;
  cost: number;
}

export interface CostBreakdown {
  total: number;
  lines: CostLine[];
}

const LABEL: Record<string, string> = {
  ac: "AC",
  heater: "Heater",
  fan: "Fan",
  supply: "Fresh-air inlet",
  return: "Extract vent",
};

function costOf(it: PlacedItem): number {
  if (it.on === false) return 0;
  if (it.type === "ac" || it.type === "heater") return COST_PER_HOUR.climate[it.power ?? 2] ?? 0;
  if (it.type === "fan") return COST_PER_HOUR.fan;
  if (it.type === "supply" || it.type === "return") return COST_PER_HOUR.vent;
  return 0; // furniture, smell sources, and every door and window: free
}

/** What this configuration costs to run, itemised. */
export function runningCost(plan: FloorPlan): CostBreakdown {
  const lines: CostLine[] = [];
  let total = 0;
  for (const it of plan.items) {
    const c = costOf(it);
    if (c <= 0) continue;
    total += c;
    const label = LABEL[it.type] ?? it.type;
    const existing = lines.find((l) => l.label === label);
    if (existing) existing.cost += c;
    else lines.push({ label, cost: c });
  }
  lines.sort((a, b) => b.cost - a.cost);
  return { total: Math.round(total * 10) / 10, lines };
}
