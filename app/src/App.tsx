import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { ContactShadows, Environment, OrbitControls } from '@react-three/drei'
import {
  Activity,
  BoxSelect,
  Download,
  Eye,
  Gauge,
  Home,
  Maximize2,
  Move3D,
  PanelRightClose,
  PanelRightOpen,
  RotateCcw,
  Rotate3D,
  Upload,
  Sofa,
  Waves,
  Wind,
} from 'lucide-react'
import './App.css'
import type { DeviceKey, DeviceState } from './stableFluidSolver'
import { useStableFluidAirflow } from './hooks/useStableFluidAirflow'
import { bindSketchToIntent } from './intent/bind'
import { mapIntentsToDeviceConfig, type IntentMapperMode } from './intent/heuristicMapper'
import { describeIntentParseResult, parseAirflowIntents } from './intent/parse'
import { intentTemplates, type IntentTemplate } from './intent/templates'
import {
  buildIntentGroundings,
  buildSessionParseResult,
  emptyIntentSession,
  reduceIntentSession,
  type IntentSessionState,
} from './intent/session'
import { AirflowScene } from './scene/AirflowScene'
import { SceneCameraRig } from './scene/SceneCameraRig'
import { readZoneMetrics } from './solver/zoneMetrics'
import { PlanCanvas } from './sketch/PlanCanvas'
import type { SketchHeightBand, SketchMode, SketchPrimitive } from './sketch/primitives'
import {
  cameraViews,
  deviceColors,
  deviceCopy,
  editableObjectNames,
  initialObjectTransforms,
  presets,
  scalarOverlayCopy,
  scalarOverlaySliceCopy,
  streamlineColor,
} from './state/appConstants'
import type {
  AirflowPreset,
  CameraView,
  EditableObjectKey,
  FlowDisplayMode,
  ObjectTransform,
  ScalarOverlayMode,
  ScalarOverlaySlice,
  TransformMode,
} from './state/appTypes'
import { buildFlowLayout } from './state/flowLayout'
import {
  buildResearchLog,
  buildRoomDesignProject,
  downloadJson,
  parseRoomDesignProject,
} from './state/projectPersistence'
import { buildGoalFeedbackItems } from './ui/goalFeedbackModel'
import { GoalFeedback } from './ui/GoalFeedback'
import { IntentChat } from './ui/IntentChat'
import { IntentEcho } from './ui/IntentEcho'

type PanelTab = 'intent' | 'scene' | 'devices' | 'project'

const panelTabs: Array<{ id: PanelTab; label: string; icon: typeof Activity }> = [
  { id: 'intent', label: 'Intent', icon: Activity },
  { id: 'scene', label: 'Scene', icon: Eye },
  { id: 'devices', label: 'Devices', icon: Gauge },
  { id: 'project', label: 'Project', icon: Download },
]

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  )
}

function App() {
  const [preset, setPreset] = useState<AirflowPreset>('comfort')
  const [devices, setDevices] = useState<DeviceState>(presets.comfort)
  const [showFlowMap, setShowFlowMap] = useState(true)
  const [flowDisplayMode, setFlowDisplayMode] = useState<FlowDisplayMode>('streamlines')
  const [scalarOverlayMode, setScalarOverlayMode] = useState<ScalarOverlayMode>('airflow')
  const [scalarOverlaySlice, setScalarOverlaySlice] = useState<ScalarOverlaySlice>('seated')
  const [cameraView, setCameraView] = useState<CameraView>('fit')
  const [isPanelCollapsed, setIsPanelCollapsed] = useState(false)
  const [activePanelTab, setActivePanelTab] = useState<PanelTab>('intent')
  const [lineDensity, setLineDensity] = useState(1)
  const [wallOpacity, setWallOpacity] = useState(0.18)
  const [selectedObject, setSelectedObject] = useState<EditableObjectKey | null>(null)
  const [transformMode, setTransformMode] = useState<TransformMode>('translate')
  const [sketchMode, setSketchMode] = useState<SketchMode>('circle')
  const [sketchHeightBand, setSketchHeightBand] = useState<SketchHeightBand>('seated')
  const [sketchPrimitives, setSketchPrimitives] = useState<SketchPrimitive[]>([])
  const [intentSession, setIntentSession] = useState<IntentSessionState>(emptyIntentSession)
  const [mapperMode, setMapperMode] = useState<IntentMapperMode>('optimized')
  const [showExpertPanel, setShowExpertPanel] = useState(false)
  const [isTransforming, setIsTransforming] = useState(false)
  const [objectTransforms, setObjectTransforms] =
    useState<Record<EditableObjectKey, ObjectTransform>>(initialObjectTransforms)
  const [autoFanSweep, setAutoFanSweep] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const fanSweepCenterRef = useRef(initialObjectTransforms.fan.rotation[1])
  const flowLayout = useMemo(() => buildFlowLayout(objectTransforms), [objectTransforms])
  const { sampler, snapshot, status } = useStableFluidAirflow(devices, flowLayout)
  const zoneMetrics = useMemo(
    () => readZoneMetrics(snapshot, objectTransforms),
    [snapshot, objectTransforms],
  )
  const intentGroundings = useMemo(
    () => buildIntentGroundings(intentSession, objectTransforms),
    [intentSession, objectTransforms],
  )

  const fanSpeed = devices.fan.enabled ? devices.fan.speed : 0
  const comfortScore = Math.max(42, Math.min(96, 100 - Math.abs(fanSpeed - 52) * 0.9))

  const applyPreset = (nextPreset: AirflowPreset) => {
    setPreset(nextPreset)
    setDevices(structuredClone(presets[nextPreset]))
  }

  const updateDevice = (device: DeviceKey, speed: number) => {
    setDevices((current) => ({
      ...current,
      [device]: {
        ...current[device],
        speed,
      },
    }))
  }

  const toggleDevice = (device: DeviceKey) => {
    setDevices((current) => ({
      ...current,
      [device]: {
        ...current[device],
        enabled: !current[device].enabled,
      },
    }))
  }

  const toggleAutoFanSweep = () => {
    setAutoFanSweep((current) => {
      const next = !current

      if (next) {
        fanSweepCenterRef.current = objectTransforms.fan.rotation[1]
      }

      return next
    })
  }

  const updateObjectTransform = (id: EditableObjectKey, transform: ObjectTransform) => {
    if (id === 'fan' && transformMode === 'rotate') {
      fanSweepCenterRef.current = transform.rotation[1]
      setAutoFanSweep(false)
    }

    setObjectTransforms((current) => ({
      ...current,
      [id]: transform,
    }))
  }

  const applySessionMapping = (session: IntentSessionState, mode: IntentMapperMode = mapperMode) => {
    const baseTransforms = {
      ...objectTransforms,
      fan: {
        ...objectTransforms.fan,
        rotation: initialObjectTransforms.fan.rotation,
      },
    }
    const activeResult = buildSessionParseResult(session)
    const mapped = mapIntentsToDeviceConfig({
      devices: presets.comfort,
      objectTransforms: baseTransforms,
      parseResult: activeResult,
      sketchBindings: session.sketchBindings,
      mapperMode: mode,
    })

    setPreset('comfort')
    setDevices(mapped.devices)
    setObjectTransforms(mapped.objectTransforms)
    setAutoFanSweep(mapped.autoFanSweep)
    setSelectedObject(mapped.selectedObject)
    fanSweepCenterRef.current = mapped.objectTransforms.fan.rotation[1]

    return mapped
  }

  const changeMapperMode = (mode: IntentMapperMode) => {
    setMapperMode(mode)

    if (intentSession.entries.length > 0) {
      applySessionMapping(intentSession, mode)
    }
  }

  const applyIntentTemplate = (template: IntentTemplate) => {
    const nextSession = reduceIntentSession(intentSession, {
      type: 'add-turn',
      sourceText: template.sourceText,
      result: template.parseResult,
    })

    setIntentSession(nextSession)
    applySessionMapping(nextSession)
  }

  const saveProject = () => {
    downloadJson('room-airflow-project.json', buildRoomDesignProject({
      devices,
      intentSession,
      mapperMode,
      objectTransforms,
      preset,
      sketchPrimitives,
    }))
  }

  const exportResearchLog = () => {
    downloadJson('room-airflow-research-log.json', buildResearchLog({
      devices,
      goalFeedback: buildGoalFeedbackItems({
        devices,
        metrics: zoneMetrics,
        session: intentSession,
        transforms: objectTransforms,
      }),
      intentSession,
      mapperMode,
      objectTransforms,
      preset,
      sketchPrimitives,
      zoneMetrics,
    }))
  }

  const loadProjectFile = async (file: File) => {
    const loaded = parseRoomDesignProject(await file.text())

    setPreset(loaded.preset)
    setDevices(loaded.devices)
    setObjectTransforms(loaded.objectTransforms)
    setSketchPrimitives(loaded.sketchPrimitives)
    setIntentSession(loaded.intentSession)
    setMapperMode(loaded.mapperMode)
    setAutoFanSweep(false)
    setSelectedObject(null)
    fanSweepCenterRef.current = loaded.objectTransforms.fan.rotation[1]
  }

  const parseIntentText = async (text: string) => {
    const result = await parseAirflowIntents(text, {
      transforms: objectTransforms,
    })
    const boundResult = bindSketchToIntent(result, sketchPrimitives)
    const nextSession = reduceIntentSession(intentSession, {
      type: 'add-turn',
      sourceText: text,
      result: boundResult,
      sketchBindings: boundResult.sketchBindings,
    })
    const mapped = applySessionMapping(nextSession)
    setIntentSession(nextSession)

    const bindingSummary = boundResult.sketchBindings.length > 0
      ? ` Bound sketch ${boundResult.sketchBindings[0].mode} at ${boundResult.sketchBindings[0].height.label}.`
      : ''

    return `${describeIntentParseResult(boundResult)}${bindingSummary} ${mapped.summary}`
  }

  const updateSession = (action: Parameters<typeof reduceIntentSession>[1]) => {
    const next = reduceIntentSession(intentSession, action)
    setIntentSession(next)
    applySessionMapping(next)
  }

  useEffect(() => {
    if (!autoFanSweep || !devices.fan.enabled || isTransforming) {
      return undefined
    }

    const interval = window.setInterval(() => {
      const sweep = Math.sin(performance.now() * 0.00115) * 0.62
      const yaw = fanSweepCenterRef.current + sweep

      setObjectTransforms((current) => ({
        ...current,
        fan: {
          ...current.fan,
          rotation: [0, yaw, 0],
        },
      }))
    }, 72)

    return () => window.clearInterval(interval)
  }, [autoFanSweep, devices.fan.enabled, isTransforming])

  return (
    <main className={isPanelCollapsed ? 'app-shell panel-collapsed' : 'app-shell'}>
      <section className="workspace">
        <header className="topbar">
          <div>
            <span className="eyebrow">
              <Home size={15} />
              Indoor airflow studio
            </span>
            <h1>Living Room Airflow Designer</h1>
          </div>
          <div className="toolbar" aria-label="View controls">
            <div className="view-segmented" aria-label="Camera views">
              {(['iso', 'top', 'front', 'fit'] as CameraView[]).map((view) => (
                <button
                  key={view}
                  type="button"
                  className={cameraView === view ? 'selected' : ''}
                  onClick={() => setCameraView(view)}
                  title={`${cameraViews[view].label} view`}
                >
                  {cameraViews[view].label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className={transformMode === 'translate' ? 'icon-button active' : 'icon-button'}
              onClick={() => setTransformMode('translate')}
              title="Move selected object"
            >
              <Move3D size={18} />
            </button>
            <button
              type="button"
              className={transformMode === 'rotate' ? 'icon-button active' : 'icon-button'}
              onClick={() => setTransformMode('rotate')}
              title="Rotate selected object"
            >
              <Rotate3D size={18} />
            </button>
            <button type="button" className={showFlowMap ? 'icon-button active' : 'icon-button'} onClick={() => setShowFlowMap((value) => !value)} title="Toggle flow map">
              <Eye size={19} />
            </button>
            <button
              type="button"
              className={flowDisplayMode === 'particles' ? 'icon-button active' : 'icon-button'}
              onClick={() => setFlowDisplayMode('particles')}
              title="Show particles"
            >
              <Wind size={18} />
            </button>
            <button
              type="button"
              className={flowDisplayMode === 'streamlines' ? 'icon-button active' : 'icon-button'}
              onClick={() => setFlowDisplayMode('streamlines')}
              title="Show streamlines"
            >
              <Waves size={18} />
            </button>
            <button type="button" className="icon-button" onClick={() => applyPreset('comfort')} title="Reset comfort preset">
              <RotateCcw size={18} />
            </button>
            <button
              type="button"
              className={isPanelCollapsed ? 'icon-button active' : 'icon-button'}
              onClick={() => setIsPanelCollapsed((value) => !value)}
              title={isPanelCollapsed ? 'Show controls' : 'Hide controls'}
            >
              {isPanelCollapsed ? <PanelRightOpen size={18} /> : <PanelRightClose size={18} />}
            </button>
          </div>
        </header>

        <div className="scene-panel">
          <Canvas
            camera={{ position: cameraViews.fit.position, fov: 50 }}
            shadows
            gl={{ antialias: true }}
            data-testid="room-canvas"
            onPointerMissed={() => setSelectedObject(null)}
          >
            <SceneCameraRig view={cameraView} />
            <color attach="background" args={['#eef1ea']} />
            <ambientLight intensity={0.72} />
            <directionalLight castShadow position={[3, 5.5, 4]} intensity={1.25} shadow-mapSize={[2048, 2048]} />
            <spotLight position={[-4.5, 4.5, 2.5]} angle={0.48} penumbra={0.45} intensity={0.56} />
            <AirflowScene
              devices={devices}
              flowDisplayMode={flowDisplayMode}
              lineDensity={lineDensity}
              mode={transformMode}
              onSelect={setSelectedObject}
              scalarOverlayMode={scalarOverlayMode}
              scalarOverlaySlice={scalarOverlaySlice}
              intentGroundings={intentGroundings}
              onTransformActiveChange={setIsTransforming}
              onTransformChange={updateObjectTransform}
              sampler={sampler}
              selectedId={selectedObject}
              showFlowMap={showFlowMap}
              snapshot={snapshot}
              transforms={objectTransforms}
              wallOpacity={wallOpacity}
            />
            <ContactShadows position={[0, 0.015, 0]} opacity={0.22} scale={9} blur={2.5} far={3.2} />
            <Environment preset="apartment" />
            <OrbitControls
              enablePan={false}
              enabled={!isTransforming}
              maxDistance={16}
              maxPolarAngle={Math.PI / 2.05}
              minDistance={4.2}
              target={cameraViews[cameraView].target}
            />
          </Canvas>
        </div>
      </section>

      <aside className={isPanelCollapsed ? 'control-panel collapsed' : 'control-panel'}>
        <button
          type="button"
          className="panel-collapse-button"
          onClick={() => setIsPanelCollapsed((value) => !value)}
          title={isPanelCollapsed ? 'Show controls' : 'Hide controls'}
        >
          {isPanelCollapsed ? <PanelRightOpen size={18} /> : <PanelRightClose size={18} />}
        </button>
        {isPanelCollapsed ? null : (
          <>
            <nav className="panel-tabbar" aria-label="Control panel sections">
              {panelTabs.map((tab) => {
                const Icon = tab.icon

                return (
                  <button
                    key={tab.id}
                    type="button"
                    className={activePanelTab === tab.id ? 'selected' : ''}
                    onClick={() => setActivePanelTab(tab.id)}
                  >
                    <Icon size={15} />
                    {tab.label}
                  </button>
                )
              })}
            </nav>

            <div className="panel-scroll">
              {activePanelTab === 'intent' ? (
                <>
                  <IntentChat onSubmitIntent={parseIntentText} />

                  <IntentEcho
                    onAccept={(entryId) => updateSession({ type: 'accept', entryId })}
                    onAdjust={(entryId) => updateSession({ type: 'adjust', entryId })}
                    onUndo={(entryId) => updateSession({ type: 'undo', entryId })}
                    session={intentSession}
                  />

                  <GoalFeedback
                    devices={devices}
                    metrics={zoneMetrics}
                    session={intentSession}
                    transforms={objectTransforms}
                  />

                  <div className="panel-section">
                    <div className="section-title">
                      <Activity size={18} />
                      Intent presets
                    </div>
                    <div className="intent-template-grid" aria-label="Intent templates">
                      {intentTemplates.map((template) => (
                        <button
                          key={template.id}
                          type="button"
                          onClick={() => applyIntentTemplate(template)}
                        >
                          <strong>{template.title}</strong>
                          <span>{template.description}</span>
                        </button>
                      ))}
                    </div>
                    <div className="segmented mapper-segmented" aria-label="Intent solver mode">
                      {(['optimized', 'heuristic'] as IntentMapperMode[]).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          className={mapperMode === mode ? 'selected' : ''}
                          onClick={() => changeMapperMode(mode)}
                        >
                          {mode}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              ) : null}

              {activePanelTab === 'scene' ? (
                <>
                  <PlanCanvas
                    heightBand={sketchHeightBand}
                    mode={sketchMode}
                    onChangeHeightBand={setSketchHeightBand}
                    onChangeMode={setSketchMode}
                    onChangePrimitives={setSketchPrimitives}
                    primitives={sketchPrimitives}
                  />

                  <div className="panel-section">
                    <div className="section-title">
                      <Maximize2 size={18} />
                      View detail
                    </div>
                    <label className="slider-row detail-slider-row">
                      <span>Walls</span>
                      <input
                        type="range"
                        min="0"
                        max="0.34"
                        step="0.02"
                        value={wallOpacity}
                        onChange={(event) => setWallOpacity(Number(event.currentTarget.value))}
                      />
                      <output>{Math.round(wallOpacity * 100)}%</output>
                    </label>
                    <label className="slider-row detail-slider-row">
                      <span>Lines</span>
                      <input
                        type="range"
                        min="0.5"
                        max="1.8"
                        step="0.1"
                        value={lineDensity}
                        onChange={(event) => setLineDensity(Number(event.currentTarget.value))}
                      />
                      <output>{lineDensity.toFixed(1)}x</output>
                    </label>
                    <label className="option-row">
                      <span>Expert metrics</span>
                      <button
                        type="button"
                        className={showExpertPanel ? 'switch enabled' : 'switch'}
                        aria-label="Toggle expert metrics"
                        onClick={() => setShowExpertPanel((value) => !value)}
                      >
                        <span />
                      </button>
                    </label>
                  </div>

                  {showExpertPanel ? (
                    <>
                      <div className="metrics-grid">
                        <Metric label="Fan" value={`${fanSpeed}%`} detail="primary source" />
                        <Metric label="Field" value={`${snapshot.revision}`} detail={`${snapshot.width} x ${snapshot.layers} x ${snapshot.height}`} />
                        <Metric label="Comfort" value={`${Math.round(comfortScore)}%`} detail="draft-aware balance" />
                      </div>

                      <div className="solver-strip" data-status={status}>
                        <span />
                        <div>
                          <strong>3D Stable Fluids field</strong>
                          <small>
                            {status === 'running'
                              ? `CPU voxel velocity + ${scalarOverlayCopy[scalarOverlayMode].label} rev ${snapshot.revision}`
                              : 'Starting voxel field'}
                          </small>
                        </div>
                      </div>
                    </>
                  ) : null}

                  <div className="panel-section">
                    <div className="section-title">
                      <Eye size={18} />
                      Scalar overlay
                    </div>
                    <div className="scalar-grid" aria-label="Scalar overlay mode">
                      {(['airflow', 'temperature', 'humidity', 'pm25', 'co2', 'noise'] as ScalarOverlayMode[]).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          className={scalarOverlayMode === mode ? 'selected' : ''}
                          onClick={() => setScalarOverlayMode(mode)}
                        >
                          {scalarOverlayCopy[mode].label}
                        </button>
                      ))}
                    </div>
                    {scalarOverlayMode !== 'airflow' ? (
                      <div className="slice-segmented" aria-label="Scalar height slice">
                        {(['average', 'floor', 'seated', 'standing', 'ceiling'] as ScalarOverlaySlice[]).map((slice) => (
                          <button
                            key={slice}
                            type="button"
                            className={scalarOverlaySlice === slice ? 'selected' : ''}
                            onClick={() => setScalarOverlaySlice(slice)}
                          >
                            {scalarOverlaySliceCopy[slice].label}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  <div className="selection-strip">
                    <BoxSelect size={18} />
                    <div>
                      <strong>{selectedObject ? editableObjectNames[selectedObject] : 'No object selected'}</strong>
                      <small>{selectedObject ? `${transformMode === 'translate' ? 'Move' : 'Rotate'} gizmo active` : 'Scene object'}</small>
                    </div>
                  </div>

                  <div className="panel-section legend-section">
                    <div className="section-title">
                      <Wind size={18} />
                      Flow legend
                    </div>
                    <div className="legend-list">
                      <span>
                        <i
                          style={{
                            background:
                              scalarOverlayMode === 'airflow'
                                ? flowDisplayMode === 'streamlines' ? streamlineColor : deviceColors.fan
                                : scalarOverlayMode === 'temperature'
                                  ? 'linear-gradient(90deg, #2a75b7, #f5f7f9, #d94639)'
                                  : scalarOverlayMode === 'humidity'
                                    ? 'linear-gradient(90deg, #e5e7eb, #5fa5c4, #1d4ed8)'
                                    : 'linear-gradient(90deg, #22c55e, #facc15, #dc2626)',
                          }}
                        />
                        {scalarOverlayMode === 'airflow'
                          ? flowDisplayMode === 'particles' ? 'device velocity particles' : 'device streamlines'
                          : `dynamic ${scalarOverlaySliceCopy[scalarOverlaySlice].label.toLowerCase()} heatmap`}
                      </span>
                      <span>
                        <i className="scalar-swatch" />
                        {scalarOverlayCopy[scalarOverlayMode].legend}
                      </span>
                    </div>
                  </div>

                  <div className="panel-section inventory-section">
                    <div className="section-title">
                      <Sofa size={18} />
                      Room assets
                    </div>
                    <p>
                      Sofa, coffee table, TV console, side table, baby crib, seated person, sleeping baby, rug, plant, lamp, and standing fan are editable 3D scene objects. The wall AC and exhaust vent are fixed HVAC devices that feed the airflow field.
                    </p>
                  </div>
                </>
              ) : null}

              {activePanelTab === 'devices' ? (
                <>
                  <div className="panel-section">
                    <div className="section-title">
                      <Activity size={18} />
                      Device presets
                    </div>
                    <div className="segmented" aria-label="Airflow presets">
                      {(['comfort', 'cooling', 'purge'] as AirflowPreset[]).map((item) => (
                        <button
                          key={item}
                          type="button"
                          className={preset === item ? 'selected' : ''}
                          onClick={() => applyPreset(item)}
                        >
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="panel-section">
                    <div className="section-title">
                      <Gauge size={18} />
                      Equipment
                    </div>
                    <div className="device-list">
                      {(Object.keys(devices) as DeviceKey[]).map((device) => {
                        const Icon = deviceCopy[device].icon

                        return (
                          <article className="device-card" key={device}>
                            <div className="device-heading">
                              <span className="device-icon" style={{ color: deviceColors[device] }}>
                                <Icon size={20} />
                              </span>
                              <div>
                                <strong>{deviceCopy[device].title}</strong>
                                <small>{deviceCopy[device].role}</small>
                              </div>
                              <button
                                type="button"
                                className={devices[device].enabled ? 'switch enabled' : 'switch'}
                                aria-label={`Toggle ${deviceCopy[device].title}`}
                                onClick={() => toggleDevice(device)}
                              >
                                <span />
                              </button>
                            </div>
                            <label className="slider-row">
                              <span>Speed</span>
                              <input
                                type="range"
                                min="0"
                                max="100"
                                value={devices[device].speed}
                                onChange={(event) => updateDevice(device, Number(event.currentTarget.value))}
                              />
                              <output>{devices[device].speed}%</output>
                            </label>
                            {device === 'fan' ? (
                              <label className="option-row">
                                <span>Auto sweep</span>
                                <button
                                  type="button"
                                  className={autoFanSweep ? 'switch enabled' : 'switch'}
                                  aria-label="Toggle automatic fan sweep"
                                  onClick={toggleAutoFanSweep}
                                >
                                  <span />
                                </button>
                              </label>
                            ) : null}
                          </article>
                        )
                      })}
                    </div>
                  </div>
                </>
              ) : null}

              {activePanelTab === 'project' ? (
                <div className="panel-section">
                  <div className="section-title">
                    <Download size={18} />
                    Project
                  </div>
                  <div className="project-action-grid">
                    <button type="button" onClick={saveProject}>
                      <Download size={15} />
                      Save JSON
                    </button>
                    <button type="button" onClick={() => fileInputRef.current?.click()}>
                      <Upload size={15} />
                      Load JSON
                    </button>
                    <button type="button" onClick={exportResearchLog}>
                      <Download size={15} />
                      Research log
                    </button>
                  </div>
                  <input
                    accept="application/json,.json"
                    className="sr-only"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0]

                      if (file) {
                        void loadProjectFile(file)
                      }

                      event.currentTarget.value = ''
                    }}
                    ref={fileInputRef}
                    type="file"
                  />
                </div>
              ) : null}
            </div>
          </>
        )}
      </aside>
    </main>
  )
}

export default App
