# Verified artifact action

This Electron-only slice prepares a local queue manifest for a task's required,
verified artifact. The manifest contains task identity, attachment id, size and
SHA-256; it neither copies the file nor publishes to an external system.
The check and the manifest write are not atomic with later reads of the file.
Any consumer must verify the artifact again against the manifest before use.

The main process owns verification, approval state, and the queue. An immutable
payload identity prevents duplicate preparation for the same artifact. A lock
is held through each physical attempt and the state transition around it. If an
attempt's result cannot be established, a single persistent question is shown.
The user's answer may attest completion, leave it unresolved, or authorize one
retry. A second uncertain result requires manual handling and no new question
or automatic retry. A user attestation is not independent evidence of delivery.

The chosen answer and its action identity are stored before it is sent. After an
interruption, recovery reads the server state and can record a one-time fence
without repeating the action. If the fence response is unknown, it is not sent
again automatically; an unresolved case remains blocked for manual handling.
The task write guard is shared only by windows in the same Electron profile;
other clients can write independently. A physical task root can also be replaced
externally between filesystem calls. An already-open window may show an old
question until it regains focus or refreshes, although the stored decision
prevents another submission for that action within the profile.

The general application-command runner can automatically retry after
reconciliation reports `not_applied`. This workflow therefore does not use that
runner: its approval decision and attempt counter need to be recorded together,
before the side effect, under the same ownership lock. The workflow does not
make an exactly-once claim for unrelated tools or external publishers.
