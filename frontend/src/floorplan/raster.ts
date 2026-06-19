import { rectContains } from "./geometry";
import type { OccupancyGrid, Rect, RoomDef } from "./types";

// Rasterise rooms onto a labelled cell grid so the simulator knows which cells
// belong to which room (living / bedroom / kitchen / ...). Cells outside every
// room are null. This is the structured room hierarchy the airflow / CO2 /
// humidity solver consumes alongside the vector geometry.

export function rasterize(rooms: RoomDef[], bounds: Rect, cell = 0.2): OccupancyGrid {
  const cols = Math.ceil(bounds.w / cell);
  const rows = Math.ceil(bounds.d / cell);
  const labels: (string | null)[] = new Array(cols * rows).fill(null);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = bounds.x + (c + 0.5) * cell;
      const z = bounds.z + (r + 0.5) * cell;
      const room = rooms.find((rm) => rectContains(rm.rect, x, z));
      labels[r * cols + c] = room ? room.id : null;
    }
  }

  return { cell, cols, rows, origin: [bounds.x, bounds.z], labels };
}

/** Count cells per room id — handy for sanity checks / area reporting. */
export function cellCounts(grid: OccupancyGrid): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const label of grid.labels) {
    if (label) counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}
