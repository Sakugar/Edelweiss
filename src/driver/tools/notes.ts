import type { CahciuaTool } from './types';
import { createTool } from './types';
import type { NoteDraft } from '../notes';
import { NOTE_ID_PATTERN, NOTE_LIMITS } from '../notes';

export const WRITE_NOTE_TOOL = 'write_note';
export const LOAD_NOTE_TOOL = 'load_note';

const idSchema = { type: 'string', pattern: NOTE_ID_PATTERN, maxLength: NOTE_LIMITS.id };

export const createWriteNoteTool = (write: (draft: NoteDraft) => Promise<void>): CahciuaTool => createTool({
  name: WRITE_NOTE_TOOL,
  execution: { lane: 'writer' },
  description: 'Silently save a durable Markdown note for this chat. Reuse the same ID to update an existing on-demand note.',
  parameters: {
    type: 'object',
    properties: {
      id: idSchema,
      title: { type: 'string', minLength: 1, maxLength: NOTE_LIMITS.title },
      description: { type: 'string', minLength: 1, maxLength: NOTE_LIMITS.description },
      body: { type: 'string', minLength: 1, maxLength: NOTE_LIMITS.body },
      sourceMessageIds: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: NOTE_LIMITS.sourceMessageId },
        maxItems: NOTE_LIMITS.sourceMessageIds,
      },
    },
    required: ['id', 'title', 'description', 'body'],
    additionalProperties: false,
  },
  async execute(input) {
    const draft = input as NoteDraft;
    await write(draft);
    return { content: JSON.stringify({ id: draft.id, saved: true }), requiresFollowUp: false };
  },
});

export const createLoadNoteTool = (load: (id: string, offset: number) => string): CahciuaTool => createTool({
  name: LOAD_NOTE_TOOL,
  execution: { lane: 'serial' },
  description: 'Read an on-demand chat note by ID. If a result contains nextOffset, use that offset to resume when budget is available.',
  parameters: {
    type: 'object',
    properties: {
      id: idSchema,
      offset: { type: 'integer', minimum: 0, maximum: NOTE_LIMITS.body },
    },
    required: ['id'],
    additionalProperties: false,
  },
  execute(input) {
    const { id, offset = 0 } = input as { id: string; offset?: number };
    return { content: load(id, offset), requiresFollowUp: true };
  },
});
