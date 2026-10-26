// Pure conversation identity for non-renderer callers. Keep UI exports in renderer/index.ts.
export {
  belongsToConversation,
  isLeadConversationParticipant,
} from './core/domain/belongsToConversation';
export type { ConversationScope } from './core/domain/conversationScope';
export {
  conversationScopeKey,
  createDirectScope,
  normalizeConversationParticipant,
  TEAM_FEED_SCOPE,
} from './core/domain/conversationScope';
export { isAddressedToUser, isOutboundUserMessage } from './core/domain/isUserUnreadMessage';
