import { estimateTextTokens } from './context';
import type { ChatNote } from './notes';
import type { RenderedContext } from '../rendering/types';

const MAX_NOTE_INDEX_TOKENS = 512;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });

const words = (text: string): Set<string> => new Set(
  [...segmenter.segment(text.toLowerCase())]
    .filter(part => part.isWordLike && part.segment.length > 1)
    .map(part => part.segment),
);

const rankNotes = (notes: ChatNote[], rc: RenderedContext): ChatNote[] => {
  const recentText = rc.filter(segment => !segment.isMyself && !segment.isPassiveEvent)
    .slice(-5)
    .flatMap(segment => segment.content.flatMap(piece => piece.type === 'text' ? [piece.text] : []))
    .join('\n')
    .slice(-5000)
    .replace(/<[^>]+>/g, ' ');
  const query = words(recentText);
  const ranked = notes.map(note => ({
    note,
    score: [...words(`${note.title} ${note.description}`)].filter(word => query.has(word)).length,
  })).sort((first, second) => second.score - first.score);
  const matches = ranked.filter(item => item.score > 0);
  return (matches.length > 0 ? matches : ranked).map(item => item.note);
};

const fitNotes = (notes: ChatNote[], heading: string, budget: number, render: (note: ChatNote) => string) => {
  let text = '';
  const included = new Set<string>();
  for (const note of notes) {
    const candidate = `${text || heading}\n${render(note)}`;
    if (estimateTextTokens(candidate) > budget) continue;
    text = candidate;
    included.add(note.id);
  }
  return { text, included };
};

interface NotePage {
  text: string;
  nextOffset?: number;
}

const renderNotePage = (note: ChatNote, offset: number, budget: number): NotePage | undefined => {
  const characters = Array.from(note.body);
  const page = (count: number) => {
    const nextOffset = offset + count;
    const continuation = nextOffset < characters.length ? { nextOffset } : {};
    const text = JSON.stringify({
      id: note.id,
      title: note.title,
      body: characters.slice(offset, nextOffset).join(''),
      ...continuation,
    });
    return { text, ...continuation };
  };
  const remaining = characters.length - offset;
  if (remaining <= 0) return undefined;

  const fullPage = page(remaining);
  if (estimateTextTokens(fullPage.text) <= budget) return fullPage;

  let low = 1;
  let high = remaining - 1;
  let best: NotePage | undefined;
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const candidate = page(count);
    if (estimateTextTokens(candidate.text) <= budget) {
      best = candidate;
      low = count + 1;
    } else {
      high = count - 1;
    }
  }
  return best;
};

export const createNoteContext = (
  notes: ChatNote[], rc: RenderedContext, alwaysBudget: number, onDemandBudget: number, contextBudget: number,
  onPageRead?: (note: ChatNote, nextOffset?: number) => void,
) => {
  const always = fitNotes(
    notes.filter(note => note.load === 'always'),
    '[Always-loaded chat notes]',
    Math.min(alwaysBudget, contextBudget),
    note => JSON.stringify({ id: note.id, title: note.title, body: note.body }),
  );
  const alwaysTokens = estimateTextTokens(always.text);
  const onDemand = new Map(notes.filter(note => !always.included.has(note.id)).map(note => [note.id, note]));
  const readBudget = onDemand.size > 0 ? Math.min(onDemandBudget, contextBudget - alwaysTokens) : 0;
  const index = fitNotes(
    rankNotes([...onDemand.values()], rc),
    '[On-demand chat notes]',
    Math.min(MAX_NOTE_INDEX_TOKENS, Math.floor(readBudget / 3)),
    note => JSON.stringify({ id: note.id, title: note.title, description: note.description }),
  );
  let remainingTokens = readBudget - estimateTextTokens(index.text);
  const contextText = [always.text, index.text].filter(Boolean);
  const positions = new Map<string, number>();

  return {
    contextText,
    initialTokens: alwaysTokens + estimateTextTokens(index.text),
    load(id: string, offset?: number, availableTokens = remainingTokens): string {
      const note = onDemand.get(id);
      if (!note) throw new Error('No on-demand note with that ID');
      const result = renderNotePage(note, offset ?? positions.get(id) ?? note.resumeOffset ?? 0, Math.min(remainingTokens, availableTokens));
      if (!result) throw new Error('No note text fits the remaining budget at that offset');
      remainingTokens -= estimateTextTokens(result.text);
      positions.set(id, result.nextOffset ?? 0);
      onPageRead?.(note, result.nextOffset);
      return result.text;
    },
  };
};
