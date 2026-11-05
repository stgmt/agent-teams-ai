/** The mutation was rejected locally, before any IPC request was sent. */
export class ArtifactWriteNotStartedError extends Error {}

/** The session handled the uncertain result for its own write attempt. */
export class ArtifactWriteOutcomeHandledError extends Error {}
