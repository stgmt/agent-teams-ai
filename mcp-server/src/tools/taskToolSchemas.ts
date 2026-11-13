import { z } from 'zod';

import { taskRefSchema } from '../utils/schemas';
import { CANONICAL_TASK_UUID_PATTERN } from '../utils/taskCreationIdempotency';

// App coordination arguments, not the registry-discovered specification tool schemas.
export const toolContextSchema = {
  teamName: z.string().min(1),
  claudeDir: z.string().min(1).optional(),
};

export const taskScopeSelectorFields = {
  project: z.string().trim().min(1).optional().describe('Registry project scope, if selecting one of several team specs.'),
  spec: z.string().trim().min(1).optional().describe('Registry specification slug paired with project.'),
};

export const relationshipTypeSchema = z.enum(['blocked-by', 'blocks', 'related']);
const inventoryTaskStatusSchema = z.enum(['pending', 'in_progress', 'completed']);
const reviewStateSchema = z.enum(['none', 'review', 'needsFix', 'approved']);
const inventoryKanbanColumnSchema = z.enum(['review', 'approved']);
export const taskMutationActorSchema = z
  .string()
  .min(1)
  .describe('Your configured teammate name. Required for ownership and lifecycle enforcement.');

export const taskToolSchemas = {
  create: z.object({
    ...toolContextSchema,
    ...taskScopeSelectorFields,
    subject: z.string().min(1),
    groupChatId: z
      .uuid()
      .optional()
      .describe(
        'Optional same-team active group context. For a new associated task provide your configured non-user createdBy/from actor; association does not grant membership.'
      ),
    description: z.string().optional(),
    owner: z
      .string()
      .optional()
      .describe('Configured teammate to assign. An owner alone does not auto-start the task.'),
    createdBy: z
      .string()
      .optional()
      .describe(
        "Explicit creation actor and assignment-notification sender: your configured name. Use 'user' only when acting for the user."
      ),
    from: z
      .string()
      .optional()
      .describe('Legacy actor/sender alternative, used only when createdBy is omitted.'),
    blockedBy: z.array(z.string().min(1)).optional(),
    related: z.array(z.string().min(1)).optional(),
    requirements: z
      .array(z.string().trim().min(1))
      .min(1)
      .describe(
        'Existing requirement ids this task implements, for example ["FR-1", "AC-2"]. Required for every task.'
      ),
    prompt: z.string().optional(),
    descriptionTaskRefs: z.array(taskRefSchema).optional(),
    promptTaskRefs: z.array(taskRefSchema).optional(),
    startImmediately: z
      .boolean()
      .optional()
      .describe(
        'Opt in to in_progress when an owner is present. Omitted/false stays pending; blocked tasks stay pending.'
      ),
    commandId: z
      .string()
      .regex(CANONICAL_TASK_UUID_PATTERN, 'Must be a canonical task UUID (version 1-5)')
      .optional()
      .describe('Stable UUID for retrying the same task creation request.'),
    idempotencyKey: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .optional()
      .describe('Stable retry key. Opaque keys are deterministically mapped to a command UUID.'),
  }),
  createFromMessage: z.object({
    ...toolContextSchema,
    ...taskScopeSelectorFields,
    messageId: z.string().min(1),
    subject: z.string().min(1),
    groupChatId: z
      .uuid()
      .optional()
      .describe(
        'Optional same-team active group context. For a new associated task provide your configured non-user createdBy actor; association does not grant membership.'
      ),
    description: z.string().optional(),
    owner: z.string().optional(),
    createdBy: z.string().optional(),
    blockedBy: z.array(z.string().min(1)).optional(),
    related: z.array(z.string().min(1)).optional(),
    requirements: z
      .array(z.string().trim().min(1))
      .min(1)
      .describe(
        'Existing requirement ids this task implements, for example ["FR-1", "AC-2"]. Required for every task.'
      ),
    prompt: z.string().optional(),
    descriptionTaskRefs: z.array(taskRefSchema).optional(),
    promptTaskRefs: z.array(taskRefSchema).optional(),
    startImmediately: z.boolean().optional(),
    requestKey: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .optional()
      .describe(
        'Stable discriminator for this task intent within the exact messageId. Reuse it only when retrying the same task creation request.'
      ),
  }),
  list: z.object({
    ...toolContextSchema,
    ...taskScopeSelectorFields,
    owner: z.string().min(1).optional(),
    status: inventoryTaskStatusSchema.optional(),
    reviewState: reviewStateSchema.optional(),
    kanbanColumn: inventoryKanbanColumnSchema.optional(),
    relatedTo: z.string().min(1).optional(),
    blockedBy: z.string().min(1).optional(),
    limit: z.number().int().positive().optional(),
  }),
  update: z
    .object({
      ...toolContextSchema,
      ...taskScopeSelectorFields,
      taskId: z.string().min(1),
      subject: z.string().min(1).optional(),
      description: z.string().optional(),
      requirements: z.array(z.string().trim().min(1)).min(1).optional(),
    })
    .refine(
      ({ subject, description, requirements }) =>
        subject !== undefined || description !== undefined || requirements !== undefined,
      { message: 'Provide at least one task field to update' }
    ),
};
