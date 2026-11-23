import type { MainTurnFeatureDeps } from './types';
import type { NotesConfig } from '../../config/config';
import type { ConversationEntry } from '../../unified-api/types';
import { injectLateBindingPrompt } from '../context';
import { createNoteContext } from '../note-context';
import { createNoteStore } from '../notes';
import { createLoadNoteTool, createWriteNoteTool, LOAD_NOTE_TOOL, WRITE_NOTE_TOOL } from '../tools/notes';
import type { DriverFeature } from '../turn-features';

const omitNoteActions = (entries: ConversationEntry[], toolNames: string[]): ConversationEntry[] => {
  const callIds = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== 'message' || entry.role !== 'assistant') continue;
    for (const part of entry.parts) {
      if (part.kind === 'toolCall' && toolNames.includes(part.name)) callIds.add(part.callId);
    }
  }
  if (callIds.size === 0) return entries;
  return entries.flatMap((entry): ConversationEntry[] => {
    if (entry.kind === 'toolResult') return callIds.has(entry.callId) ? [] : [entry];
    if (entry.role !== 'assistant') return [entry];
    const parts = entry.parts.filter(part => part.kind !== 'toolCall' || !callIds.has(part.callId));
    if (parts.length === entry.parts.length) return [entry];
    return parts.some(part => part.kind !== 'reasoning') ? [{ ...entry, parts }] : [];
  });
};

export const createNotesFeature = (deps: MainTurnFeatureDeps, config: NotesConfig): DriverFeature => {
  const store = createNoteStore(deps.chatConfig.platform, deps.chatId);
  let noteContext: ReturnType<typeof createNoteContext> | undefined;

  return {
    name: 'notes',
    async prepareTurn(ctx) {
      const notes = await store.list().catch((err: unknown) => {
        deps.log.withError(err).warn('Failed to load chat notes');
        return [];
      });
      noteContext = createNoteContext(
        notes,
        ctx.turn.rcAtStart,
        config.alwaysLoad.maxContextEstTokens,
        config.onDemand.maxContextEstTokens,
        Math.max(0, deps.chatConfig.compaction.maxContextEstTokens - 1),
      );
      ctx.scratch.noteContextReservedTokens = noteContext.reservedTokens;
    },
    prepareTools(ctx) {
      const context = noteContext!;
      ctx.turn.tools.push(
        createWriteNoteTool(async draft => {
          ctx.signal.throwIfAborted();
          await store.write(draft);
        }),
        createLoadNoteTool((id, offset) => context.load(id, offset)),
      );
    },
    preparePrompt(ctx) {
      const context = noteContext!;
      for (const text of context.contextText)
        injectLateBindingPrompt(ctx.turn.entries, text);
      ctx.scratch.contextEstimatedTokens += context.initialTokens;
    },
    beforeStep(ctx) {
      if (ctx.turn.step > 1)
        ctx.turn.entries = omitNoteActions(ctx.turn.entries, [WRITE_NOTE_TOOL]);
    },
    transformStepEntries: (_ctx, entries) => omitNoteActions(entries, [WRITE_NOTE_TOOL, LOAD_NOTE_TOOL]),
  };
};
