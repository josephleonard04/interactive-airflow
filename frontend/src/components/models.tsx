import { RoundedBox } from "@react-three/drei";
import { itemColor } from "../floorplan/palette";
import type { Vec3 } from "../floorplan/types";

// Composite furniture models built from primitives so items read as real
// furniture rather than plain boxes. Each model is authored in a local frame
// centred at the origin, spanning `size` = [width, height, depth], facing +z
// (its back is at −z, so it sits flush when placed against a wall). The parent
// <group> applies the world position and rotation.

type V = Vec3;

function Box({
  size,
  position = [0, 0, 0],
  color,
  roughness = 0.65,
  metalness = 0,
  emissive,
}: {
  size: V;
  position?: V;
  color: string;
  roughness?: number;
  metalness?: number;
  emissive?: string;
}) {
  const r = Math.min(0.03, Math.min(size[0], size[1], size[2]) * 0.45);
  return (
    <RoundedBox args={size} radius={r} smoothness={2} position={position} castShadow>
      <meshStandardMaterial
        color={color}
        roughness={roughness}
        metalness={metalness}
        emissive={emissive ?? "#000000"}
        emissiveIntensity={emissive ? 0.5 : 0}
      />
    </RoundedBox>
  );
}

function Cyl({ r, h, position = [0, 0, 0], color, metalness = 0.6 }: { r: number; h: number; position?: V; color: string; metalness?: number }) {
  return (
    <mesh position={position} castShadow>
      <cylinderGeometry args={[r, r, h, 12]} />
      <meshStandardMaterial color={color} roughness={0.4} metalness={metalness} />
    </mesh>
  );
}

const DARK = "#5b4a36";
const METAL = "#9aa3ad";

function Bed([w, h, d]: V) {
  const c = itemColor("bed");
  return (
    <group>
      <Box size={[w, h * 0.55, d]} position={[0, -h * 0.2, 0]} color={DARK} />
      <Box size={[w * 0.94, h * 0.5, d * 0.9]} position={[0, h * 0.06, d * 0.03]} color="#ece6da" roughness={0.9} />
      <Box size={[w, h * 1.3, d * 0.09]} position={[0, h * 0.25, -d / 2 + d * 0.045]} color={c} />
      <Box size={[w * 0.36, h * 0.18, d * 0.16]} position={[-w * 0.22, h * 0.3, -d / 2 + d * 0.17]} color="#ffffff" roughness={1} />
      <Box size={[w * 0.36, h * 0.18, d * 0.16]} position={[w * 0.22, h * 0.3, -d / 2 + d * 0.17]} color="#ffffff" roughness={1} />
    </group>
  );
}

function LegTable([w, h, d]: V, topFrac: number) {
  const c = itemColor("desk");
  const legH = h * (1 - topFrac);
  const lx = w / 2 - 0.06;
  const lz = d / 2 - 0.06;
  return (
    <group>
      <Box size={[w, h * topFrac, d]} position={[0, h / 2 - (h * topFrac) / 2, 0]} color={c} />
      {([[lx, lz], [-lx, lz], [lx, -lz], [-lx, -lz]] as Array<[number, number]>).map(([x, z], i) => (
        <Box key={i} size={[0.06, legH, 0.06]} position={[x, -h / 2 + legH / 2, z]} color={DARK} />
      ))}
    </group>
  );
}

function Closet([w, h, d]: V) {
  const c = itemColor("closet");
  return (
    <group>
      <Box size={[w, h, d]} position={[0, 0, 0]} color={c} />
      <Box size={[0.02, h * 0.86, 0.02]} position={[0, 0, d / 2]} color={DARK} />
      <Box size={[0.035, 0.14, 0.04]} position={[-0.07, 0, d / 2 + 0.01]} color={METAL} metalness={0.6} />
      <Box size={[0.035, 0.14, 0.04]} position={[0.07, 0, d / 2 + 0.01]} color={METAL} metalness={0.6} />
    </group>
  );
}

function Couch([w, h, d]: V) {
  const c = itemColor("couch");
  const arm = w * 0.12;
  return (
    <group>
      <Box size={[w, h * 0.4, d]} position={[0, -h * 0.1, 0]} color={c} />
      <Box size={[w, h * 0.6, d * 0.26]} position={[0, h * 0.16, -d / 2 + d * 0.13]} color={c} />
      <Box size={[arm, h * 0.55, d]} position={[-w / 2 + arm / 2, h * 0.02, 0]} color={c} />
      <Box size={[arm, h * 0.55, d]} position={[w / 2 - arm / 2, h * 0.02, 0]} color={c} />
      <Box size={[(w - arm * 2) * 0.48, h * 0.16, d * 0.7]} position={[-(w - arm * 2) * 0.25, h * 0.12, d * 0.06]} color="#9aa6ba" roughness={0.9} />
      <Box size={[(w - arm * 2) * 0.48, h * 0.16, d * 0.7]} position={[(w - arm * 2) * 0.25, h * 0.12, d * 0.06]} color="#9aa6ba" roughness={0.9} />
    </group>
  );
}

function Tv([w, h, d]: V) {
  return (
    <group>
      <Box size={[w, h, Math.max(d, 0.05)]} position={[0, 0, 0]} color="#11161e" />
      <Box size={[w * 0.92, h * 0.86, 0.012]} position={[0, 0, Math.max(d, 0.05) / 2 + 0.007]} color="#2b6cb0" emissive="#1e3a8a" roughness={0.3} />
    </group>
  );
}

function Fridge([w, h, d]: V) {
  return (
    <group>
      <Box size={[w, h, d]} position={[0, 0, 0]} color={itemColor("fridge")} roughness={0.4} metalness={0.2} />
      <Box size={[w, 0.02, 0.02]} position={[0, h * 0.12, d / 2]} color="#b7c0c8" />
      <Box size={[0.04, h * 0.28, 0.04]} position={[w / 2 - 0.09, h * 0.28, d / 2]} color={METAL} metalness={0.6} />
      <Box size={[0.04, h * 0.22, 0.04]} position={[w / 2 - 0.09, -h * 0.08, d / 2]} color={METAL} metalness={0.6} />
    </group>
  );
}

function Sink([w, h, d]: V) {
  return (
    <group>
      <Box size={[w, h * 0.78, d]} position={[0, -h * 0.11, 0]} color={itemColor("sink")} />
      <Box size={[w, h * 0.1, d]} position={[0, h * 0.39, 0]} color="#eef2f5" roughness={0.4} />
      <Box size={[w * 0.5, h * 0.12, d * 0.55]} position={[0, h * 0.36, 0]} color="#c3ccd2" metalness={0.3} />
      <Cyl r={0.018} h={0.18} position={[0, h * 0.52, -d * 0.26]} color={METAL} />
      <Cyl r={0.016} h={0.14} position={[0, h * 0.6, -d * 0.2]} color={METAL} />
    </group>
  );
}

function Toilet([w, h, d]: V) {
  return (
    <group>
      {/* tank against the back (−z) */}
      <Box size={[w * 0.85, h * 0.6, d * 0.28]} position={[0, h * 0.1, -d / 2 + d * 0.14]} color="#eef3f6" />
      {/* bowl */}
      <mesh position={[0, -h * 0.05, d * 0.08]} castShadow>
        <cylinderGeometry args={[w * 0.42, w * 0.34, h * 0.5, 18]} />
        <meshStandardMaterial color="#f3f7fa" roughness={0.4} />
      </mesh>
      {/* seat / lid */}
      <Box size={[w * 0.8, h * 0.07, d * 0.55]} position={[0, h * 0.22, d * 0.08]} color="#fbfdff" />
    </group>
  );
}

function Bathtub([w, h, d]: V) {
  return (
    <group>
      <Box size={[w, h, d]} position={[0, 0, 0]} color={itemColor("bathtub")} roughness={0.35} />
      {/* recessed basin */}
      <Box size={[w * 0.86, h * 0.7, d * 0.78]} position={[0, h * 0.22, 0]} color="#cfdde6" roughness={0.25} />
      {/* faucet */}
      <Cyl r={0.02} h={0.16} position={[-w / 2 + 0.12, h * 0.55, -d / 2 + 0.12]} color={METAL} />
    </group>
  );
}

function Ac([w, h, d]: V) {
  return (
    <group>
      <Box size={[w, h, d]} position={[0, 0, 0]} color="#eef1f4" roughness={0.5} />
      <Box size={[w * 0.82, 0.03, 0.02]} position={[0, -h * 0.28, d / 2]} color="#c2cad2" />
      <Box size={[0.06, 0.03, 0.02]} position={[w * 0.3, h * 0.2, d / 2]} color="#34d399" emissive="#10b981" />
    </group>
  );
}

function Heater([w, h, d]: V) {
  const c = itemColor("heater");
  const fins = 7;
  return (
    <group>
      <Box size={[w, h, d * 0.45]} position={[0, 0, -d * 0.22]} color={c} />
      {Array.from({ length: fins }, (_, i) => {
        const x = -w / 2 + (w / (fins - 1)) * i;
        return <Box key={i} size={[w * 0.07, h * 0.9, d]} position={[x, 0, 0]} color={c} roughness={0.5} metalness={0.3} />;
      })}
    </group>
  );
}

// Simple standing floor fan, facing +z (rotationY aims it). Just blades on a
// hub — no cage ring.
// Pedestal fan: wide overlapping paddle blades on a motor housing, on a
// pole + weighted base. Faces +z; no cage ring.
function Fan([w, h, d]: V) {
  const r = w * 0.6;
  const blades = 5;
  return (
    <group>
      {/* weighted base (disc + slight dome) + pole + neck */}
      <Cyl r={w * 0.44} h={0.05} position={[0, -h / 2 + 0.025, 0]} color="#5c6671" metalness={0.5} />
      <mesh position={[0, -h / 2 + 0.07, 0]}>
        <sphereGeometry args={[w * 0.22, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial color="#6b7480" metalness={0.45} roughness={0.45} />
      </mesh>
      <Cyl r={0.024} h={h * 0.66} position={[0, -h * 0.08, 0]} color="#c2c8cf" metalness={0.55} />
      {/* head */}
      <group position={[0, h * 0.32, 0]}>
        {/* motor housing behind the blades */}
        <mesh position={[0, 0, -d * 0.1]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[w * 0.17, w * 0.21, d * 0.26, 22]} />
          <meshStandardMaterial color="#7a828c" metalness={0.55} roughness={0.4} />
        </mesh>
        {/* overlapping paddle blades */}
        {Array.from({ length: blades }, (_, i) => (
          <group key={i} rotation={[0, 0, (i * Math.PI * 2) / blades]}>
            <mesh position={[0, r * 0.5, d * 0.02]} rotation={[0.42, 0, 0]}>
              <boxGeometry args={[r * 0.62, r * 0.98, 0.012]} />
              <meshStandardMaterial color="#eef3f8" roughness={0.4} metalness={0.05} side={2} />
            </mesh>
          </group>
        ))}
        {/* hub cap */}
        <mesh position={[0, 0, d * 0.05]}>
          <sphereGeometry args={[w * 0.12, 16, 16]} />
          <meshStandardMaterial color="#5c6671" metalness={0.6} roughness={0.35} />
        </mesh>
      </group>
    </group>
  );
}

/** A grille with a RUNNING LIGHT.
 *
 *  A vent gives nothing away by looking at it: the slats look identical whether
 *  air is pouring through them or nothing is happening at all. In the studio
 *  task the extract is the one part of the room the participant cannot switch,
 *  and the brief has to say so in words — "runs all night and cannot be switched
 *  off" — because the object itself was mute. A small indicator lamp is how
 *  every real extract fan says it: green while it runs, red when it does not. */
function Vent([w, h, d]: V, on = true) {
  const slats = 4;
  // Sized off the grille, not off a fraction of it. At 7.5% of the short side
  // the lamp came out ~1 cm across on a wall vent seen from across the room —
  // technically present, invisible in practice. It also gets a bezel, so the
  // colour reads against the grey slats instead of dissolving into them.
  const led = Math.max(0.035, Math.min(w, d) * 0.2);
  return (
    <group>
      <Box size={[w, h * 0.5, d]} position={[0, 0, 0]} color="#c7d0d8" metalness={0.3} />
      {Array.from({ length: slats }, (_, i) => {
        const z = -d / 2 + (d / (slats + 1)) * (i + 1);
        return <Box key={i} size={[w * 0.86, 0.012, 0.03]} position={[0, h * 0.2, z]} color="#8b95a1" />;
      })}
      {/* On the face, off to one side of the slats. Emissive so it reads as a
          lamp rather than a painted dot, and bright enough to see from the
          camera distances these rooms are viewed at. */}
      <group position={[w * 0.34, h * 0.24, d * 0.3]}>
        <mesh>
          <sphereGeometry args={[led * 1.45, 12, 12]} />
          <meshStandardMaterial color="#2b3138" roughness={0.8} />
        </mesh>
        <mesh position={[0, led * 0.5, 0]}>
          <sphereGeometry args={[led, 14, 14]} />
          <meshStandardMaterial
            color={on ? "#22c55e" : "#ef4444"}
            emissive={on ? "#4ade80" : "#f87171"}
            emissiveIntensity={2.6}
            roughness={0.25}
          />
        </mesh>
      </group>
    </group>
  );
}

// Kitchen unit: a counter combining a sink (left) and a stove cooktop with four
// burners + an oven (right). Clearly distinct from the small bathroom sink.
function KitchenSink([w, h, d]: V) {
  const burner = (x: number, z: number) => (
    <mesh position={[x, h * 0.46, z]} rotation={[Math.PI / 2, 0, 0]}>
      <cylinderGeometry args={[w * 0.08, w * 0.08, 0.02, 20]} />
      <meshStandardMaterial color="#3a3f47" metalness={0.3} roughness={0.6} />
    </mesh>
  );
  return (
    <group>
      {/* cabinet base + counter top */}
      <Box size={[w, h * 0.8, d]} position={[0, -h * 0.1, 0]} color="#d8c6a6" />
      <Box size={[w, h * 0.1, d]} position={[0, h * 0.4, 0]} color="#eef1f4" roughness={0.4} />
      {/* oven door on the stove (right) front */}
      <Box size={[w * 0.44, h * 0.5, 0.03]} position={[w * 0.24, -h * 0.08, d / 2]} color="#7d8893" metalness={0.4} roughness={0.4} />
      <Box size={[w * 0.34, 0.035, 0.04]} position={[w * 0.24, h * 0.12, d / 2 + 0.01]} color="#aab4bd" metalness={0.6} />
      {/* sink basin (left) */}
      <Box size={[w * 0.38, h * 0.16, d * 0.6]} position={[-w * 0.26, h * 0.36, 0]} color="#aab4bd" metalness={0.6} roughness={0.3} />
      <Cyl r={0.02} h={0.2} position={[-w * 0.26, h * 0.55, -d * 0.28]} color="#9aa3ad" />
      <Cyl r={0.016} h={0.14} position={[-w * 0.26, h * 0.63, -d * 0.22]} color="#9aa3ad" />
      {/* stove cooktop (right) with four burners */}
      <Box size={[w * 0.46, 0.04, d * 0.86]} position={[w * 0.24, h * 0.47, 0]} color="#2b2f36" roughness={0.5} />
      {burner(w * 0.13, -d * 0.2)}
      {burner(w * 0.35, -d * 0.2)}
      {burner(w * 0.13, d * 0.2)}
      {burner(w * 0.35, d * 0.2)}
    </group>
  );
}

// A placed "smell source": a glowing magenta orb on a small stem, plus rising
// wisp rings so it reads as an odor source.
function Smell(size: V): JSX.Element {
  const r = Math.min(size[0], size[2]) * 0.42;
  return (
    <group>
      <Box size={[0.05, size[1] * 0.5, 0.05]} position={[0, size[1] * 0.25, 0]} color="#7c3aed" />
      <mesh position={[0, size[1] * 0.6, 0]} castShadow>
        <sphereGeometry args={[r, 18, 18]} />
        <meshStandardMaterial color="#a855f7" emissive="#7c3aed" emissiveIntensity={0.7} toneMapped={false} />
      </mesh>
      <mesh position={[0, size[1] * 0.9, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[r * 0.7, 0.012, 8, 20]} />
        <meshStandardMaterial color="#c084fc" emissive="#a855f7" emissiveIntensity={0.5} toneMapped={false} transparent opacity={0.7} />
      </mesh>
    </group>
  );
}

/** Damp: a puddle with steam rising off it. The smell marker is a violet blob
 *  and reads as "something smells here", which is the wrong sentence in a
 *  bathroom — this has to say "this patch is wet" at a glance. */
function Damp(size: V): JSX.Element {
  const r = Math.min(size[0], size[2]) * 0.5;
  return (
    <group>
      {/* the wet patch itself, lying on the floor */}
      <mesh position={[0, -size[1] / 2 + 0.012, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[r, 24]} />
        <meshStandardMaterial color="#4a7f9e" roughness={0.15} metalness={0.2} transparent opacity={0.75} />
      </mesh>
      {/* three drifting wisps of steam */}
      {[0, 1, 2].map((i) => (
        <mesh key={i} position={[(i - 1) * r * 0.5, size[1] * (0.25 + i * 0.22), (i % 2 ? 1 : -1) * r * 0.2]}>
          <sphereGeometry args={[r * (0.38 - i * 0.06), 12, 12]} />
          <meshStandardMaterial
            color="#dbeaf2"
            emissive="#9fc4d6"
            emissiveIntensity={0.35}
            toneMapped={false}
            transparent
            opacity={0.42 - i * 0.1}
          />
        </mesh>
      ))}
    </group>
  );
}

/** Shower: a tiled tray with two glass panels and a head on the back wall. The
 *  glass is what makes it read as a shower rather than a tub from above, and it
 *  is a real flow obstacle — a screen in the corner is exactly the sort of thing
 *  that keeps air off the wall behind it. */
function Shower([w, h, d]: V): JSX.Element {
  const glass = { color: "#cfe3ea", roughness: 0.1, metalness: 0.05 };
  return (
    <group>
      {/* tray */}
      <Box size={[w, h * 0.06, d]} position={[0, -h / 2 + h * 0.03, 0]} color="#e9eef0" roughness={0.5} />
      {/* back and side glass, open toward +x/+z so the corner it sits in stays reachable */}
      <mesh position={[0, 0, -d / 2 + 0.02]} castShadow>
        <boxGeometry args={[w, h * 0.94, 0.03]} />
        <meshStandardMaterial {...glass} transparent opacity={0.35} />
      </mesh>
      <mesh position={[-w / 2 + 0.02, 0, 0]} castShadow>
        <boxGeometry args={[0.03, h * 0.94, d]} />
        <meshStandardMaterial {...glass} transparent opacity={0.35} />
      </mesh>
      {/* riser and head */}
      <Box size={[0.05, h * 0.55, 0.05]} position={[0, h * 0.1, -d / 2 + 0.08]} color="#b9c2c7" metalness={0.6} roughness={0.3} />
      <mesh position={[0, h * 0.36, -d / 2 + 0.16]} rotation={[Math.PI / 2.6, 0, 0]} castShadow>
        <cylinderGeometry args={[0.09, 0.09, 0.03, 16]} />
        <meshStandardMaterial color="#c8d0d4" metalness={0.7} roughness={0.25} />
      </mesh>
    </group>
  );
}

/** Kitchen bin: a tapered body with a lid, standing slightly open. The lid is
 *  the point — a closed bin is not a smell you have to design around, and the
 *  participant has to be able to see at a glance where the smell is coming
 *  from without reading a label. */
function Bin(size: V): JSX.Element {
  const r = Math.min(size[0], size[2]) * 0.5;
  const h = size[1];
  return (
    <group>
      <mesh position={[0, h * 0.45, 0]} castShadow>
        <cylinderGeometry args={[r, r * 0.82, h * 0.9, 20]} />
        <meshStandardMaterial color="#8d949b" roughness={0.55} metalness={0.25} />
      </mesh>
      {/* lid, tipped back so the bin reads as open */}
      <mesh position={[0, h * 0.95, -r * 0.25]} rotation={[-0.45, 0, 0]} castShadow>
        <cylinderGeometry args={[r * 1.06, r * 1.06, h * 0.07, 20]} />
        <meshStandardMaterial color="#6f767d" roughness={0.5} metalness={0.3} />
      </mesh>
      {/* the bag inside, just visible over the rim */}
      <mesh position={[0, h * 0.9, 0]}>
        <cylinderGeometry args={[r * 0.9, r * 0.9, h * 0.06, 16]} />
        <meshStandardMaterial color="#4b5563" roughness={0.9} />
      </mesh>
    </group>
  );
}

export function Model({ type, size, on = true }: { type: string; size: V; on?: boolean }) {
  switch (type) {
    case "bed":
      return Bed(size);
    case "kitchen_sink":
      return KitchenSink(size);
    case "desk":
      return LegTable(size, 0.08);
    case "table":
      return LegTable(size, 0.14);
    case "closet":
      return Closet(size);
    case "couch":
      return Couch(size);
    case "tv":
      return Tv(size);
    case "fridge":
      return Fridge(size);
    case "sink":
      return Sink(size);
    case "toilet":
      return Toilet(size);
    case "bathtub":
      return Bathtub(size);
    case "ac":
      return Ac(size);
    case "heater":
      return Heater(size);
    case "fan":
      return Fan(size);
    case "supply":
      return Vent(size, on);
    case "return":
      return Vent(size, on);
    case "shower":
      return Shower(size);
    case "damp":
      return Damp(size);
    case "bin":
      return Bin(size);
    case "smell":
      return Smell(size);
    default:
      return <Box size={size} color={itemColor(type)} />;
  }
}
