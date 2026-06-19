// Core scene types for the interactive room editor.
//
// The room layout (walls/floor) is fixed per the advisor direction; what the
// user changes is the placement of objects and the supply-air ("AC") config.
// Each object is a movable axis-aligned box for now — enough to act as a flow
// obstacle / source when handed to the simulator.

export type Vec3 = [number, number, number];

export type ObjectKind =
  | "furniture" // a solid obstacle (bed, desk, sofa, ...)
  | "supply" // air supply / AC inlet (a flow source)
  | "return"; // return / exhaust vent (a flow sink)

export interface SceneObject {
  id: string;
  name: string;
  kind: ObjectKind;
  position: Vec3; // center, in metres, room-local coords
  size: Vec3; // full extents (w, h, d) in metres
  rotationY: number; // yaw in radians (axis-aligned editing for now)
  /** For supply/return vents: volumetric flow magnitude (m^3/s). Ignored for furniture. */
  flow?: number;
}

export interface Room {
  /** Interior dimensions in metres: width (x), height (y), depth (z). */
  size: Vec3;
}
