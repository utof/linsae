/**
 * Camera state machine for the canvas stage: owns the {x,y,zoom} camera, wires
 * wheel/pinch/pan gestures to the viewport node, tracks a `isMoving` settle
 * flag for motion-LOD, and persists the camera per-canvas with the spec's
 * debounce + unconditional-flush cadence.
 *
 * Why a hook (not a component): the camera is shared by the stage transform and
 * (later) the card LOD pass; a hook keeps the gesture + persistence wiring out
 * of JSX. All gesture math delegates to the pure helpers in `./camera`.
 *
 * @see docs/specs/v0.4-canvas-mvp.md §2 (persistence cadence) §3 (settle, pan/zoom)
 * @see docs/specs/v0.4-canvas-mvp.md §15 (⇧+wheel horizontal pan)
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { api } from '../lib/api'
import { type Camera, panBy, zoomAboutPoint } from './camera'

/** ms of camera-idle before `isMoving` flips false (spec §3 motion-LOD settle). */
const SETTLE_MS = 120
/** ms-debounce before a camera change is persisted (spec §2 — never per frame). */
const PERSIST_DEBOUNCE_MS = 500

/** Form tags whose keydown must NOT arm space-pan (typing a space in a field). */
const FORM_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

export interface UseCanvasCamera {
  camera: Camera
  setCamera: Dispatch<SetStateAction<Camera>>
  /** true from any camera change until a 120 ms trailing idle timer fires (spec §3 settle) */
  isMoving: boolean
  /** initial getState resolved — gate rendering so the first paint is at the persisted camera */
  ready: boolean
}

/**
 * Drives the canvas camera for `canvasId`, attached to `viewportRef`'s node.
 *
 * Boot: reads the persisted camera once via react-query (`staleTime: Infinity`,
 * write-through cache so a same-session remount re-reads the flushed value, not
 * the boot value). `ready` gates the first paint so it lands at the persisted
 * camera rather than {0,0,1}-then-jump.
 *
 * Gestures (wheel/pinch/⇧-pan/two-finger-pan, middle-drag, space+left-drag) are
 * bound via effects with `{ passive: false }` so `preventDefault` stops the page
 * scrolling. `opts.unclampZoom` lets the dev LOD flag zoom past the user range.
 *
 * @param opts.unclampZoom when true, zoom is not clamped to [ZOOM_MIN, ZOOM_MAX]
 *   (spec §12 dev flag); normal use keeps `false`.
 */
export function useCanvasCamera(
  canvasId: string,
  viewportRef: RefObject<HTMLDivElement | null>,
  opts: { unclampZoom: boolean },
): UseCanvasCamera {
  const queryClient = useQueryClient()
  const { unclampZoom } = opts

  // Boot read — once per session per canvas; write-through keeps it current.
  const { data: persisted, isSuccess: ready } = useQuery({
    queryKey: ['canvas-state', canvasId],
    queryFn: () => api.canvas.getState({ canvasId }),
    staleTime: Number.POSITIVE_INFINITY,
  })

  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 1 })
  const [isMoving, setIsMoving] = useState(false)

  // Once the boot read resolves, snap the camera to the persisted value. Guard
  // with a ref so a later cache write-through (same data) never re-snaps over a
  // gesture in flight — only the FIRST resolution initialises the camera.
  // useLayoutEffect (not useEffect): the snap must commit BEFORE the browser
  // paints the first ready render, or the world flashes {0,0,1} for one frame
  // ("first paint at the persisted camera" is a binding Done criterion).
  const initialisedRef = useRef(false)
  useLayoutEffect(() => {
    if (initialisedRef.current || !persisted) return
    initialisedRef.current = true
    setCamera({ x: persisted.camera_x, y: persisted.camera_y, zoom: persisted.zoom })
  }, [persisted])

  // ---- isMoving settle timer: any camera change re-arms a 120 ms idle timer.
  const settleTimerRef = useRef<number | undefined>(undefined)
  const bump = useCallback(() => {
    setIsMoving(true)
    if (settleTimerRef.current !== undefined) clearTimeout(settleTimerRef.current)
    settleTimerRef.current = window.setTimeout(() => setIsMoving(false), SETTLE_MS)
  }, [])
  useEffect(
    () => () => {
      if (settleTimerRef.current !== undefined) clearTimeout(settleTimerRef.current)
    },
    [],
  )

  // setCamera wrapper that also bumps the settle timer. Used by every gesture.
  const moveCamera = useCallback(
    (next: SetStateAction<Camera>) => {
      bump()
      setCamera(next)
    },
    [bump],
  )

  // ---- Persistence: 500 ms-debounced write, unconditional flush on unmount +
  // beforeunload. Write-through to the query cache on every flush so a remount
  // within the session re-reads the flushed camera (Done-criterion: no revert).
  const cameraRef = useRef(camera)
  cameraRef.current = camera
  const readyRef = useRef(ready)
  readyRef.current = ready

  const flush = useCallback(() => {
    if (!readyRef.current) return // never write before the boot read resolved
    const c = cameraRef.current
    const payload = { camera_x: c.x, camera_y: c.y, zoom: c.zoom }
    queryClient.setQueryData(['canvas-state', canvasId], payload)
    void api.canvas.setState({ canvasId, ...payload })
  }, [canvasId, queryClient])

  // Debounced write on every camera change (skipped until ready inside flush).
  // `camera` is a deliberate trigger dep — flush reads it via cameraRef, but the
  // effect must re-run (re-arm the debounce) on each camera change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: camera is the debounce trigger
  useEffect(() => {
    if (!ready) return
    const t = window.setTimeout(flush, PERSIST_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [camera, ready, flush])

  // Unconditional flush on app quit (beforeunload) and on unmount (view switch).
  useEffect(() => {
    const onBeforeUnload = () => flush()
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      flush()
    }
  }, [flush])

  // ---- Wheel / pinch / pan-scroll, bound non-passive so preventDefault works.
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = viewport.getBoundingClientRect()
      const s = { x: e.clientX - rect.left, y: e.clientY - rect.top }
      if (e.ctrlKey) {
        // trackpad pinch (Chromium reports pinch as ctrl+wheel) and literal ctrl+wheel
        moveCamera((c) => zoomAboutPoint(c, s, Math.exp(-e.deltaY * 0.01), { clamp: !unclampZoom }))
      } else if (e.shiftKey) {
        // ⇧+wheel = horizontal pan (spec §15); browsers may pre-swap deltas
        const d = e.deltaX !== 0 ? e.deltaX : e.deltaY
        moveCamera((c) => panBy(c, { dx: -d, dy: 0 }))
      } else if (e.deltaX !== 0) {
        // two-finger trackpad scroll = pan (spec §3); mouse wheels have deltaX === 0.
        // Known limit: pure-vertical two-finger scroll is indistinguishable from a mouse
        // wheel and will zoom — accepted heuristic, revisit only on dogfood complaint.
        moveCamera((c) => panBy(c, { dx: -e.deltaX, dy: -e.deltaY }))
      } else {
        moveCamera((c) =>
          zoomAboutPoint(c, s, Math.exp(-e.deltaY * 0.002), { clamp: !unclampZoom }),
        )
      }
    }
    viewport.addEventListener('wheel', onWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', onWheel)
  }, [viewportRef, moveCamera, unclampZoom])

  // ---- Space-to-pan arming: track ' ' keydown/up at the window, ignoring form
  // tags so typing a space in a field doesn't arm the grab cursor.
  const spaceDownRef = useRef(false)
  const [spaceArmed, setSpaceArmed] = useState(false)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== ' ') return
      const t = e.target as HTMLElement | null
      if (t && FORM_TAGS.has(t.tagName)) return
      // Suppress space's default for non-text targets: with focus on a button
      // (e.g. the feed|canvas segment), held-space pan would otherwise fire the
      // button's space-activation on keyup (preventing keydown default
      // suppresses button space-activation in Chromium).
      e.preventDefault()
      spaceDownRef.current = true
      setSpaceArmed(true)
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== ' ') return
      spaceDownRef.current = false
      setSpaceArmed(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  // ---- Pan drags: middle-button always pans; left-button pans only while
  // space is held. Pointer capture keeps the drag alive past the viewport edge.
  const panningRef = useRef(false)
  const [panning, setPanning] = useState(false)
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const onPointerDown = (e: PointerEvent) => {
      const middle = e.button === 1
      const leftWithSpace = e.button === 0 && spaceDownRef.current
      if (!middle && !leftWithSpace) return
      e.preventDefault()
      panningRef.current = true
      setPanning(true)
      viewport.setPointerCapture(e.pointerId)
    }
    const onPointerMove = (e: PointerEvent) => {
      if (!panningRef.current) return
      moveCamera((c) => panBy(c, { dx: e.movementX, dy: e.movementY }))
    }
    const endPan = (e: PointerEvent) => {
      if (!panningRef.current) return
      panningRef.current = false
      setPanning(false)
      if (viewport.hasPointerCapture(e.pointerId)) viewport.releasePointerCapture(e.pointerId)
    }
    viewport.addEventListener('pointerdown', onPointerDown)
    viewport.addEventListener('pointermove', onPointerMove)
    viewport.addEventListener('pointerup', endPan)
    viewport.addEventListener('pointercancel', endPan)
    return () => {
      viewport.removeEventListener('pointerdown', onPointerDown)
      viewport.removeEventListener('pointermove', onPointerMove)
      viewport.removeEventListener('pointerup', endPan)
      viewport.removeEventListener('pointercancel', endPan)
    }
  }, [viewportRef, moveCamera])

  // Cursor feedback: grab while armed (space held), grabbing while dragging.
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    viewport.style.cursor = panning ? 'grabbing' : spaceArmed ? 'grab' : ''
  }, [viewportRef, panning, spaceArmed])

  return { camera, setCamera: moveCamera, isMoving, ready }
}
