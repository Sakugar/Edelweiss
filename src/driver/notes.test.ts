import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { estimateTextTokens } from './context';
import { createNoteContext } from './note-context';
import type { ChatNote } from './notes';
import { createNoteStore } from './notes';

describe('chat notes storage', () => {
  it('persists Markdown by chat and platform and protects manually loaded notes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'edelweiss-notes-'));
    try {
      const draft = {
        id: 'deployment',
        title: '部署时间',
        description: '本周部署时间',
        body: '周五 22:00 部署。',
        sourceMessageIds: ['12345'],
      };
      const store = createNoteStore('telegram', 'chat-a', root);
      await store.write(draft);
      await store.write({ ...draft, body: '改为周六 22:00 部署。' });

      const reopened = createNoteStore('telegram', 'chat-a', root);
      const updated = { ...draft, load: 'on-demand', body: '改为周六 22:00 部署。' };
      expect(await reopened.list()).toEqual([updated]);
      expect(await createNoteStore('telegram', 'chat-b', root).list()).toEqual([]);
      expect(await createNoteStore('onebot', 'chat-a', root).list()).toEqual([]);

      const path = join(root, 'telegram', Buffer.from('chat-a').toString('hex'), 'deployment.md');
      const text = await readFile(path, 'utf8');
      await writeFile(path, text.replace('load: on-demand', 'load: always'));
      await expect(reopened.write(draft)).rejects.toThrow('maintained manually');
      await expect(reopened.write({ ...draft, id: '../other' })).rejects.toThrow('Invalid note ID');
      expect(await reopened.list()).toEqual([{ ...updated, load: 'always' }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('chat notes context', () => {
  const always: ChatNote = {
    id: 'convention',
    title: '群内约定',
    description: '用语',
    body: '短句优先。',
    load: 'always',
    sourceMessageIds: [],
  };
  const longNote: ChatNote = {
    ...always,
    id: 'deployment',
    title: 'deployment details',
    description: 'deployment schedule',
    body: '📝步骤\n'.repeat(180),
    load: 'on-demand',
  };

  it('accounts for the index and pages within the read budget, independently of always-loaded notes', () => {
    const alwaysBudget = 80;
    const readBudget = 180;
    const ctx = createNoteContext([
      always,
      { ...always, id: 'too-big', body: 'x'.repeat(1000) },
      longNote,
    ], [{ receivedAtMs: 1, content: [{ type: 'text', text: 'deployment' }] }], alwaysBudget, readBudget, 1000);

    const [alwaysText, indexText] = ctx.contextText;
    expect(alwaysText).toContain(always.body);
    expect(alwaysText).not.toContain('too-big');
    expect(estimateTextTokens(alwaysText!)).toBeLessThanOrEqual(alwaysBudget);
    expect(indexText).toContain(longNote.description);
    expect(indexText).not.toContain('📝');

    const first = ctx.load(longNote.id, 0);
    const page = JSON.parse(first) as { body: string; nextOffset: number };
    expect(page.body).toBe(Array.from(longNote.body).slice(0, page.nextOffset).join(''));
    expect(page.nextOffset).toBeGreaterThan(0);
    expect(estimateTextTokens(indexText!) + estimateTextTokens(first)).toBeLessThanOrEqual(readBudget);
    expect(() => ctx.load(longNote.id, page.nextOffset)).toThrow('remaining budget');

    const nextTurn = createNoteContext([longNote], [], 0, readBudget, 1000);
    const resumed = JSON.parse(nextTurn.load(longNote.id, page.nextOffset)) as { body: string };
    expect(resumed.body.startsWith(Array.from(longNote.body)[page.nextOffset]!)).toBe(true);
  });
});
