import type { DeviceState, StableFluidSnapshot } from '../stableFluidSolver'
import type { IntentGrounding } from '../intent/session.ts'
import { acFlowOrigin, acFlowTransform, deviceColors, streamlineColor } from '../state/appConstants'
import type { EditableObjectKey, FlowDisplayMode, ObjectTransform, ScalarOverlayMode, ScalarOverlaySlice, TransformMode } from '../state/appTypes'
import { getFanParticleOrigin, type AirflowSampler } from '../viz/airflowVizHelpers'
import { StableFluidParticles } from '../viz/StableFluidParticles'
import { StableFluidStreamlines } from '../viz/StableFluidStreamlines'
import { FurnitureSet } from './FurnitureSet'
import { ExhaustVent, WallAirConditioner } from './HvacDevices'
import { IntentGroundingHighlights } from './IntentGroundingHighlights'
import { RoomShell } from './RoomShell'
import { StandingFan } from './StandingFan'

export function AirflowScene({
  devices,
  flowDisplayMode,
  lineDensity,
  mode,
  onSelect,
  scalarOverlayMode,
  scalarOverlaySlice,
  intentGroundings,
  onTransformActiveChange,
  onTransformChange,
  sampler,
  selectedId,
  showFlowMap,
  snapshot,
  transforms,
  wallOpacity,
}: {
  devices: DeviceState
  flowDisplayMode: FlowDisplayMode
  lineDensity: number
  mode: TransformMode
  onSelect: (id: EditableObjectKey) => void
  scalarOverlayMode: ScalarOverlayMode
  scalarOverlaySlice: ScalarOverlaySlice
  intentGroundings: IntentGrounding[]
  onTransformActiveChange: (active: boolean) => void
  onTransformChange: (id: EditableObjectKey, transform: ObjectTransform) => void
  sampler: AirflowSampler
  selectedId: EditableObjectKey | null
  showFlowMap: boolean
  snapshot: StableFluidSnapshot
  transforms: Record<EditableObjectKey, ObjectTransform>
  wallOpacity: number
}) {
  return (
    <>
      <RoomShell
        scalarOverlayMode={scalarOverlayMode}
        scalarOverlaySlice={scalarOverlaySlice}
        showFlowMap={showFlowMap}
        snapshot={snapshot}
        wallOpacity={wallOpacity}
      />
      <IntentGroundingHighlights groundings={intentGroundings} />
      <FurnitureSet
        mode={mode}
        onSelect={onSelect}
        onTransformActiveChange={onTransformActiveChange}
        onTransformChange={onTransformChange}
        selectedId={selectedId}
        transforms={transforms}
      />
      <StandingFan
        enabled={devices.fan.enabled}
        mode={mode}
        onSelect={onSelect}
        onTransformActiveChange={onTransformActiveChange}
        onTransformChange={onTransformChange}
        selectedId={selectedId}
        speed={devices.fan.speed}
        transform={transforms.fan}
      />
      <WallAirConditioner enabled={devices.ac.enabled} speed={devices.ac.speed} />
      <ExhaustVent enabled={devices.vent.enabled} speed={devices.vent.speed} />

      {flowDisplayMode === 'particles' ? (
        <>
          <StableFluidParticles
            color={deviceColors.fan}
            count={300}
            enabled={devices.fan.enabled}
            fanTransform={transforms.fan}
            origin={getFanParticleOrigin(transforms.fan)}
            sampler={sampler}
            speed={devices.fan.speed}
            spread={0.72}
          />
          <StableFluidParticles
            color={deviceColors.ac}
            count={180}
            enabled={devices.ac.enabled}
            fanTransform={acFlowTransform}
            origin={acFlowOrigin}
            sampler={sampler}
            speed={devices.ac.speed}
            spread={0.58}
          />
        </>
      ) : (
        <>
          <StableFluidStreamlines
            color={streamlineColor}
            density={lineDensity}
            enabled={devices.fan.enabled}
            fanTransform={transforms.fan}
            origin={getFanParticleOrigin(transforms.fan)}
            sampler={sampler}
            speed={devices.fan.speed}
            spread={0.78}
          />
          <StableFluidStreamlines
            color={deviceColors.ac}
            density={Math.max(0.45, lineDensity * 0.82)}
            enabled={devices.ac.enabled}
            fanTransform={acFlowTransform}
            origin={acFlowOrigin}
            sampler={sampler}
            speed={devices.ac.speed}
            spread={0.68}
          />
        </>
      )}
    </>
  )
}
