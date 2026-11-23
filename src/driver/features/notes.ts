import type { MainTurnFeatureDeps } from './types';
import type { NotesConfig } from '../../config/config';
import type { ConversationEntry } from '../../unified-api/types';
import { estimateEntryTokens, estimateTextTokens, injectLateBindingPrompt, trimEntries } from '../context';
import { createNoteContext } from '../note-context';
import { createNoteStore } from '../notes';
import type { ChatNote } from '../notes';
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

const writeReceiptArgs = (args: string): string => {
  try {
    const id: unknown = JSON.parse(args)?.id;
    return JSON.stringify(typeof id === 'string' ? { id } : {});
  } catch {
    return '{}';
  }
};

const redactWriteDrafts = (entries: ConversationEntry[]): ConversationEntry[] => entries.map(entry => {
  if (entry.kind !== 'message' || entry.role !== 'assistant') return entry;
  const parts = entry.parts.map(part => {
    if (part.kind !== 'toolCall' || part.name !== WRITE_NOTE_TOOL) return part;
    return { ...part, args: writeReceiptArgs(part.args) };
  });
  return { ...entry, parts };
});

export const createNotesFeature = (deps: MainTurnFeatureDeps, config: NotesConfig): DriverFeature => {
  const store = createNoteStore(deps.chatConfig.platform, deps.chatId);
  const maxTokens = deps.chatConfig.compaction.maxContextEstTokens;
  const pendingPositions = new Map<ChatNote, number | undefined>();
  let noteContext: ReturnType<typeof createNoteContext> | undefined;
  let historyLength = 0;
  let minHistoryTokens: number | undefined;
  let stepReadTokens = 0;
  let modelOutputTokens = 0;

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
        Math.max(0, maxTokens - 1),
        (note, offset) => pendingPositions.set(note, offset),
      );
      ctx.scratch.noteContextReservedTokens = noteContext.initialTokens;
    },
    prepareTools(ctx) {
      ctx.turn.tools.push(
        createWriteNoteTool(async draft => {
          ctx.signal.throwIfAborted();
          await store.write(draft);
        }),
        createLoadNoteTool((id, offset) => {
          const entries = ctx.turn.entries;
          minHistoryTokens ??= trimEntries(entries.slice(0, historyLength), 0).estimatedTokens;
          const liveTokens = estimateEntryTokens(entries.slice(historyLength)) + modelOutputTokens + stepReadTokens;
          if (!noteContext) throw new Error('Note context has not been prepared');
          const result = noteContext.load(id, offset, maxTokens - minHistoryTokens - liveTokens);
          stepReadTokens += estimateTextTokens(result);
          return result;
        }),
      );
    },
    preparePrompt(ctx) {
      const context = noteContext!;
      historyLength = ctx.turn.entries.length;
      for (const text of context.contextText)
        injectLateBindingPrompt(ctx.turn.entries, text);
      ctx.scratch.contextEstimatedTokens += context.initialTokens;
    },
    beforeStep(ctx) {
      if (ctx.turn.step <= 1) return;
      const history = ctx.turn.entries.slice(0, historyLength);
      const live = redactWriteDrafts(ctx.turn.entries.slice(historyLength));
      const kept = stepReadTokens ? trimEntries(history, maxTokens - estimateEntryTokens(live)).entries : history;
      historyLength = kept.length;
      ctx.turn.entries = [...kept, ...live];
      stepReadTokens = 0;
    },
    async afterModelCall(_ctx, output) {
      modelOutputTokens = estimateEntryTokens(redactWriteDrafts(output.entries));
      for (const [note, offset] of pendingPositions) {
        if (offset === note.resumeOffset) continue;
        try {
          await store.saveReadPosition(note, offset);
          note.resumeOffset = offset;
        } catch (err) {
          deps.log.withError(err).withFields({ noteId: note.id }).warn('Failed to save note read position');
        }
      }
      pendingPositions.clear();
    },
    transformStepEntries: (_ctx, entries) => omitNoteActions(entries, [WRITE_NOTE_TOOL, LOAD_NOTE_TOOL]),
  };
};
