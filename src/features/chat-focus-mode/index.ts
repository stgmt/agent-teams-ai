// Pure focus-mode domain for non-renderer callers. Keep UI exports in renderer/index.ts.
export type {
  FocusItem,
  FocusPairItem,
  FocusRequestStatus,
  FocusThreadSummary,
} from './core/domain/buildFocusThread';
export {
  buildFocusReplyIndex,
  buildFocusThread,
  hasFocusRequest,
  isFocusOnlyMessage,
  summarizeFocusThread,
} from './core/domain/buildFocusThread';
export type {
  FocusClassificationContext,
  FocusMessageRole,
} from './core/domain/classifyFocusMessage';
export { classifyFocusMessage } from './core/domain/classifyFocusMessage';
