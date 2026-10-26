/** DOM id of a request card, used to scroll to the earliest unanswered request. */
export function focusRequestDomId(messageId: string): string {
  return `chat-focus-request-${messageId}`;
}
