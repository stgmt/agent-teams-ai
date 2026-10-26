/** How a reply to "user" was produced. */
export type UserReplyChannel = 'explicit' | 'fallback';

/**
 * Links a reply addressed to "user" back to the user requests it answers.
 * Main stamps these fields; models never supply them.
 */
export interface UserReplyLinkFields {
  /** User request message ids this reply answers. */
  replyToMessageIds?: string[];
  /** `explicit`: the member sent it to "user"; `fallback`: main promoted the lead's text. */
  replyChannel?: UserReplyChannel;
  /** Shown only in chat focus mode; the same text is already visible as a lead thought. */
  focusOnly?: boolean;
}
