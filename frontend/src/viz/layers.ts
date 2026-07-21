// Explicit draw order for the transparent parts of the scene.
//
// The house walls and the airflow lines are both transparent and neither writes
// to the depth buffer (walls must not, or they would hide the room behind them;
// lines must not, or they would z-fight with each other). That leaves three.js
// sorting them by centroid distance, which is unstable: it flips between lines
// and as the camera orbits, so the same frame could show one streamline painted
// over a wall and its neighbour painted under it. Read as a picture, that is air
// passing through a wall or a floor — even though the traced geometry never
// leaves the room.
//
// Giving each layer a fixed renderOrder makes the result deterministic: airflow
// is drawn first, the house shell over it, so a line beyond a wall consistently
// reads as being seen THROUGH the glass.

/** Airflow streamlines and particles — drawn first. */
export const FLOW_RENDER_ORDER = 1;
/** The semi-transparent wall shell — always drawn over the airflow. */
export const WALL_RENDER_ORDER = 10;
