import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { Canvas } from '@react-three/fiber'
import { ContactShadows, Environment, OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import {
  Activity,
  BoxSelect,
  Download,
  Eye,
  FlaskConical,
  Gauge,
  Home,
  Maximize2,
  Move3D,
  PanelRightClose,
  PanelRightOpen,
  Play,
  RotateCcw,
  Rotate3D,
  Upload,
  Sofa,
  Waves,
  Wind,
  Zap,
} from 'lucide-react'
import './App.css'
import { createSampler, ROOM, type DeviceKey, type DeviceState } from './stableFluidSolver'
import { useStableFluidAirflow } from './hooks/useStableFluidAirflow'
import { SetupScreen } from './components/SetupScreen'
import { buildAirflowCase } from './engine/airflowCase'
import { exportOpenFoamCase } from './engine/openfoam/exportCase'
import {
  checkBackendHealth,
  runOpenFoam,
  type BackendHealth,
} from './engine/openfoam/client'
import { openfoamResultToSnapshot, type OpenFoamResult } from './engine/openfoam/result'
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
  obstacleFootprints,
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
  RoomDimensions,
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

const roomAssetIds: EditableObjectKey[] = [
  'sofa',
  'coffeeTable',
  'mediaConsole',
  'sideTable',
  'crib',
  'seatedPerson',
  'sleepingBaby',
  'plant',
  'lamp',
  'fan',
]

const dropPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
const dropPoint = new THREE.Vector3()
const dropRaycaster = new THREE.Raycaster()
const floorBounds = { minX: -4.75, maxX: 4.75, minZ: -3.45, maxZ: 3.45 }

function clampAssetPosition(id: EditableObjectKey, x: number, z: number): [number, number, number] {
  const footprint = obstacleFootprints[id]
  const halfWidth = (footprint?.w ?? 0.72) / 2
  const halfDepth = (footprint?.d ?? 0.72) / 2

  return [
    Math.max(floorBounds.minX + halfWidth, Math.min(floorBounds.maxX - halfWidth, x)),
    0,
    Math.max(floorBounds.minZ + halfDepth, Math.min(floorBounds.maxZ - halfDepth, z)),
  ]
}

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
  const [started, setStarted] = useState(false)
  const [roomDims, setRoomDims] = useState<RoomDimensions>({
    width: ROOM.width,
    depth: ROOM.depth,
    height: ROOM.height,
  })
  const [engine, setEngine] = useState<'realtime' | 'openfoam'>('realtime')
  const [ofResult, setOfResult] = useState<OpenFoamResult | null>(null)
  const [ofRunning, setOfRunning] = useState(false)
  const [ofStale, setOfStale] = useState(false)
  const [ofHealth, setOfHealth] = useState<BackendHealth | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const canvasCameraRef = useRef<THREE.Camera | null>(null)
  const canvasElementRef = useRef<HTMLCanvasElement | null>(null)
  const lastSceneForOpenFoamRef = useRef<{ devices: DeviceState; flowLayout: ReturnType<typeof buildFlowLayout> } | null>(null)
  const [draggingAsset, setDraggingAsset] = useState<EditableObjectKey | null>(null)
  const fanSweepCenterRef = useRef(initialObjectTransforms.fan.rotation[1])
  const flowLayout = useMemo(() => buildFlowLayout(objectTransforms), [objectTransforms])
  const { sampler, snapshot, status } = useStableFluidAirflow(devices, flowLayout)

  // Accurate engine: when an OpenFOAM result is available and the accurate
  // engine is selected, render that field through the same visualization by
  // adapting it into a snapshot. Otherwise show the live real-time field.
  const ofSnapshot = useMemo(
    () => (ofResult ? openfoamResultToSnapshot(ofResult) : null),
    [ofResult],
  )
  const showingOpenFoam = engine === 'openfoam' && ofSnapshot != null
  const activeSnapshot = showingOpenFoam ? ofSnapshot : snapshot
  const activeSampler = useMemo(
    () => (showingOpenFoam ? createSampler(activeSnapshot) : sampler),
    [showingOpenFoam, activeSnapshot, sampler],
  )

  // The displayed OpenFOAM result goes stale when the scene or devices change.
  useEffect(() => {
    const previous = lastSceneForOpenFoamRef.current
    const changed = previous != null && (previous.devices !== devices || previous.flowLayout !== flowLayout)

    lastSceneForOpenFoamRef.current = { devices, flowLayout }

    if (changed && ofResult) setOfStale(true)
  }, [flowLayout, devices, ofResult])

  // Proactively probe the backend when the accurate engine is selected, so the
  // HUD can show online/offline (and how to start it) before the user clicks run.
  useEffect(() => {
    if (engine !== 'openfoam') return
    const controller = new AbortController()
    checkBackendHealth(controller.signal).then(setOfHealth)
    return () => controller.abort()
  }, [engine])

  const runAccurateSimulation = async () => {
    if (ofRunning) return
    setOfRunning(true)
    setEngine('openfoam')
    try {
      const health = await checkBackendHealth()
      setOfHealth(health)
      const ofCase = exportOpenFoamCase(buildAirflowCase(flowLayout, devices))
      const result = await runOpenFoam(ofCase)
      setOfResult(result)
      setOfStale(false)
    } finally {
      setOfRunning(false)
    }
  }

  const zoneMetrics = useMemo(
    () => readZoneMetrics(activeSnapshot, objectTransforms),
    [activeSnapshot, objectTransforms],
  )
  const intentGroundings = useMemo(
    () => buildIntentGroundings(intentSession, objectTransforms),
    [intentSession, objectTransforms],
  )

  // The scene is authored at ROOM dims; render it inside a group scaled to the
  // user's chosen size. The solver runs on a fixed grid, so scaling the world
  // keeps the simulation consistent while showing the room at the right size.
  const roomScale = useMemo<[number, number, number]>(
    () => [roomDims.width / ROOM.width, roomDims.height / ROOM.height, roomDims.depth / ROOM.depth],
    [roomDims.width, roomDims.height, roomDims.depth],
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

  const placeObjectAt = (id: EditableObjectKey, position: [number, number, number]) => {
    const clamped = clampAssetPosition(id, position[0], position[2])

    setObjectTransforms((current) => ({
      ...current,
      [id]: {
        ...current[id],
        position: clamped,
      },
    }))
    setSelectedObject(id)
    setTransformMode('translate')

    if (id === 'fan') {
      setAutoFanSweep(false)
    }
  }

  const dropAssetOnCanvas = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()

    const id = (event.dataTransfer.getData('application/x-room-asset') || draggingAsset) as EditableObjectKey | null
    const camera = canvasCameraRef.current
    const canvas = canvasElementRef.current

    setDraggingAsset(null)

    if (!id || !camera || !canvas) {
      return
    }

    const rect = canvas.getBoundingClientRect()
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    )

    dropRaycaster.setFromCamera(pointer, camera)

    if (!dropRaycaster.ray.intersectPlane(dropPlane, dropPoint)) {
      return
    }

    placeObjectAt(id, [dropPoint.x / roomScale[0], 0, dropPoint.z / roomScale[2]])
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
      {!started && (
        <SetupScreen
          onStart={(dims) => {
            setRoomDims(dims)
            setStarted(true)
          }}
        />
      )}
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
            <div className="engine-segmented" aria-label="Simulation engine">
              <button
                type="button"
                className={engine === 'realtime' ? 'selected' : ''}
                onClick={() => setEngine('realtime')}
                title="Real-time engine: live CPU Stable Fluids preview"
              >
                <Zap size={14} />
                Real-time
              </button>
              <button
                type="button"
                className={engine === 'openfoam' ? 'selected' : ''}
                onClick={() => setEngine('openfoam')}
                title="Accurate engine: OpenFOAM CFD (run on demand)"
              >
                <FlaskConical size={14} />
                Accurate
              </button>
            </div>
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

        <div
          className={draggingAsset ? 'scene-panel asset-drop-active' : 'scene-panel'}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDraggingAsset(null)}
          onDrop={dropAssetOnCanvas}
        >
          {engine === 'openfoam' && (
            <div className="engine-hud" role="status">
              <div className="engine-hud-head">
                <FlaskConical size={16} />
                <strong>Accurate engine — OpenFOAM</strong>
                {showingOpenFoam && ofResult && (
                  <span className={`engine-badge ${ofResult.status}`}>
                    {ofResult.status === 'ok'
                      ? 'CFD result'
                      : ofResult.status === 'mock'
                        ? 'preview (no OpenFOAM)'
                        : 'error'}
                  </span>
                )}
              </div>
              <button
                type="button"
                className="run-accurate"
                onClick={runAccurateSimulation}
                disabled={ofRunning}
              >
                <Play size={15} />
                {ofRunning
                  ? 'Running CFD…'
                  : ofResult
                    ? 'Re-run accurate simulation'
                    : 'Run accurate simulation'}
              </button>
              {ofStale && ofResult && !ofRunning && (
                <p className="engine-note stale">Scene changed since this result — re-run to update.</p>
              )}
              {ofResult?.message && <p className="engine-note">{ofResult.message}</p>}
              {ofResult?.seconds != null && !ofRunning && (
                <p className="engine-note dim">
                  {ofResult.status === 'ok' ? 'Solved' : 'Computed'} in {ofResult.seconds}s
                  {ofHealth?.version ? ` · OpenFOAM ${ofHealth.version}` : ''}
                </p>
              )}
              {!ofResult && !ofRunning && (
                <p className="engine-note dim">
                  Runs a buoyantSimpleFoam case from the current scene on the local backend.
                </p>
              )}
              <div className="engine-backend">
                <span className={`engine-dot ${ofHealth?.reachable ? (ofHealth.openfoam ? 'on' : 'partial') : 'off'}`} />
                {ofHealth == null
                  ? 'Checking backend…'
                  : !ofHealth.reachable
                    ? 'Backend offline — run  backend\\run.ps1'
                    : ofHealth.openfoam
                      ? `Backend online · OpenFOAM ready${ofHealth.version ? ` (${ofHealth.version})` : ''}`
                      : 'Backend online · OpenFOAM not installed (preview mode)'}
              </div>
            </div>
          )}
          {draggingAsset ? (
            <div className="drop-target-badge" aria-hidden="true">
              Drop {editableObjectNames[draggingAsset]} into the room
            </div>
          ) : null}
          <Canvas
            camera={{ position: cameraViews.fit.position, fov: 50 }}
            shadows
            gl={{ antialias: true }}
            data-testid="room-canvas"
            onCreated={({ camera, gl }) => {
              canvasCameraRef.current = camera
              canvasElementRef.current = gl.domElement
            }}
            onPointerMissed={() => setSelectedObject(null)}
          >
            <SceneCameraRig view={cameraView} scale={roomScale} />
            <color attach="background" args={['#eef1ea']} />
            <ambientLight intensity={0.72} />
            <directionalLight castShadow position={[3, 5.5, 4]} intensity={1.25} shadow-mapSize={[2048, 2048]} />
            <spotLight position={[-4.5, 4.5, 2.5]} angle={0.48} penumbra={0.45} intensity={0.56} />
            <group scale={roomScale}>
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
                sampler={activeSampler}
                selectedId={selectedObject}
                showFlowMap={showFlowMap}
                snapshot={activeSnapshot}
                transforms={objectTransforms}
                wallOpacity={wallOpacity}
              />
              <ContactShadows position={[0, 0.015, 0]} opacity={0.22} scale={9} blur={2.5} far={3.2} />
            </group>
            <Environment preset="apartment" />
            <OrbitControls
              enablePan={false}
              enabled={!isTransforming}
              maxDistance={16 * roomScale[0]}
              maxPolarAngle={Math.PI / 2.05}
              minDistance={4.2 * Math.min(...roomScale)}
              target={[
                cameraViews[cameraView].target[0] * roomScale[0],
                cameraViews[cameraView].target[1] * roomScale[1],
                cameraViews[cameraView].target[2] * roomScale[2],
              ]}
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
                      <small>{selectedObject ? (transformMode === 'translate' ? 'Drag on the floor to move' : 'Rotate handle active') : 'Drag an asset or click an object'}</small>
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
                    <div className="asset-grid" aria-label="Draggable room assets">
                      {roomAssetIds.map((assetId) => (
                        <button
                          key={assetId}
                          type="button"
                          draggable
                          className={selectedObject === assetId ? 'selected' : ''}
                          onClick={() => {
                            setSelectedObject(assetId)
                            setTransformMode('translate')
                          }}
                          onDragStart={(event) => {
                            setDraggingAsset(assetId)
                            event.dataTransfer.effectAllowed = 'move'
                            event.dataTransfer.setData('application/x-room-asset', assetId)
                          }}
                          onDragEnd={() => setDraggingAsset(null)}
                          title={`Drag ${editableObjectNames[assetId]} into the room`}
                        >
                          <Sofa size={15} />
                          <span>{editableObjectNames[assetId]}</span>
                        </button>
                      ))}
                    </div>
                    <p>
                      Drag a chip onto the floor, then grab the object directly in the 3D room. AC and exhaust stay fixed because they define the engine boundary conditions.
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
