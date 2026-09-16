export {
  applyVomInteractionRecovery,
  isVomReferenceNode,
  isVomStructuralRole,
  prepareObservationRender,
  type RenderRow,
  renderVom,
  renderCompactVom,
  projectVom,
} from "./render";
export type {
  ActiveScopeBlock,
  BlockingLayer,
  CondSurface,
  LayerKind,
  Rect,
  RenderedRef,
  Viewport,
  VisualEntry,
  VomNode,
  VomOptions,
  VomRef,
  VomResult,
  VomScene,
  VomCompleteness,
  VomProjection,
  VomProjectionNode,
  VomRelation,
} from "./types";
export {
  discoverLocators,
  findLocators,
  matchesLocator,
  parseLocator,
  rematchLocator,
} from "./locator";
export { deriveInteractionLayers } from "./layers";
export type {
  DiscoverResult,
  LocatorField,
  LocatorMatch,
  LocatorNode,
  LocatorOperator,
  LocatorPredicate,
  LocatorQuery,
  LocatorValue,
  RematchResult,
} from "./locator";
export type { InteractionLayer } from "./types";
export {
  analyzeVirtualizedLists,
  collectVirtualizedSegments,
  stableItemFingerprint,
} from "./virtualized";
export type {
  CollectVirtualizedOptions,
  CollectVirtualizedResult,
  VirtualizedCompleteness,
  VirtualizedListAnalysis,
  VirtualizedSegment,
} from "./virtualized";
