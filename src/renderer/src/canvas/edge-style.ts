/**
 * Edge kind/interactivity decision (spec §5 §6). Drawn edges (non-reserved
 * edge_type) are styled distinctly + are selectable/deletable; 'reference' and
 * 'comment-on' are read-only on the canvas. Pure so it's happy-dom-testable;
 * the canvas draw using it is smoke-tested (#131).
 */
export type EdgeKind = 'reference' | 'comment' | 'drawn'
export function edgeKind(edgeType: string): EdgeKind {
  if (edgeType === 'reference') return 'reference'
  if (edgeType === 'comment-on') return 'comment'
  return 'drawn'
}
/** Drawn edges are the only interactive (hover/select/delete) edges (spec §5 decision 6). */
export function isDrawnEdge(edgeType: string): boolean {
  return edgeKind(edgeType) === 'drawn'
}
/** Type-label pill shows only above this zoom (spec §6 "hidden at small zoom"). */
export const TYPE_PILL_MIN_ZOOM = 0.5
