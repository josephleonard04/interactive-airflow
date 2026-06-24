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

// Simple standing floor fan, facing +z (rotationY aims it).
function Fan([w, h, d]: V) {
  const r = w * 0.5;
  return (
    <group>
      {/* round base + thin pole */}
      <Cyl r={w * 0.4} h={0.05} position={[0, -h / 2 + 0.025, 0]} color="#6b7480" metalness={0.4} />
      <Cyl r={0.022} h={h * 0.72} position={[0, -h * 0.06, 0]} color="#aab2bb" metalness={0.5} />
      {/* round head facing +z */}
      <group position={[0, h * 0.3, 0]}>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[r * 0.82, r * 0.82, 0.1, 24]} />
          <meshStandardMaterial color="#d3d9e0" metalness={0.2} roughness={0.55} />
        </mesh>
        <mesh position={[0, 0, d * 0.1]}>
          <sphereGeometry args={[w * 0.1, 12, 12]} />
          <meshStandardMaterial color="#9aa3ad" metalness={0.4} />
        </mesh>
        {[0, 1, 2].map((i) => (
          <group key={i} rotation={[0, 0, (i * Math.PI * 2) / 3]}>
            <Box size={[w * 0.16, r * 0.68, 0.01]} position={[0, r * 0.36, d * 0.09]} color="#eef2f6" />
          </group>
        ))}
        <mesh position={[0, 0, d * 0.13]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[r, 0.012, 8, 28]} />
          <meshStandardMaterial color="#aeb6c0" metalness={0.4} />
        </mesh>
      </group>
    </group>
  );
}

function Vent([w, h, d]: V) {
  const slats = 4;
  return (
    <group>
      <Box size={[w, h * 0.5, d]} position={[0, 0, 0]} color="#c7d0d8" metalness={0.3} />
      {Array.from({ length: slats }, (_, i) => {
        const z = -d / 2 + (d / (slats + 1)) * (i + 1);
        return <Box key={i} size={[w * 0.86, 0.012, 0.03]} position={[0, h * 0.2, z]} color="#8b95a1" />;
      })}
    </group>
  );
}

export function Model({ type, size }: { type: string; size: V }) {
  switch (type) {
    case "bed":
      return Bed(size);
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
      return Vent(size);
    default:
      return <Box size={size} color={itemColor(type)} />;
  }
}
