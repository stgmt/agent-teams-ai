/** Lead prompt blocks kept out of TeamProvisioningPromptBuilders (its source-size cap is frozen). */

export const LEAD_PARALLELIZATION_PROMPT_LINES: readonly string[] = [
  `Parallelization guideline (IMPORTANT):`,
  `- If a task is genuinely parallelizable, split it into multiple smaller tasks owned by different members.`,
  `  - Prefer splitting by independent deliverables (e.g. frontend/backend, API/UI, parsing/rendering, tests/docs) rather than arbitrary slices.`,
  `  - Use blockedBy only when one piece truly cannot start without another; otherwise link with related.`,
  `  - Do NOT split when work is inherently sequential, requires one person to keep consistent context, or the overhead would exceed the benefit.`,
  `  - When splitting, make each task have a clear completion criterion and a single accountable owner.`,
  ``,
];

export const LEAD_STATUS_QUESTION_PROMPT_LINES: readonly string[] = [
  `STATUS QUESTIONS (mandatory, comes before every tool below):`,
  `- When the user or a teammate asks what is going on with a teammate, with a task of a teammate, or with the team, your FIRST tool call is lead_briefing. Call it before task_get, task_list, message_send or any other tool, even when the question names a task id or a member. Then answer from its "Members" section.`,
  `  When asked about the status of a teammate or of the team, call lead_briefing FIRST and answer from its "Members" section. It lists, per member, whether the runtime is running and its launch confirmed (from the app), unread inbox messages with the age of the oldest, and the member's tasks with start and last-action ages. Do NOT answer a status question from memory and do NOT ask the teammate for a status report just to find out; message a teammate only when the section shows a concrete problem to act on.`,
  ``,
];
