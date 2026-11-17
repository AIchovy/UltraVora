export interface ChatLoadingInput {
  /** The conversation timeline has zero messages. */
  chatEmpty: boolean;
  /** React Query is still fetching the session metadata. */
  sessionLoading: boolean;
  /** The SSE stream connection is open. */
  streaming: boolean;
  /** The SSE stream has errored. */
  streamErrored: boolean;
}

/**
 * The conversation zone shows a skeleton only while it has no messages AND we're
 * still waiting on data: either the session metadata query is in flight, or the
 * SSE stream hasn't connected yet (and hasn't errored). The server emits no
 * "replay complete" sentinel, so once the stream opens — or errors out — with an
 * empty log we stop the skeleton and fall through to the real conversation or
 * the genuine empty state, never stuck on the skeleton.
 */
export function isChatLoading(input: ChatLoadingInput): boolean {
  if (!input.chatEmpty) return false;
  const connecting = !input.streaming && !input.streamErrored;
  return input.sessionLoading || connecting;
}
