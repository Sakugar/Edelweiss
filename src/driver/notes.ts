import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as v from 'valibot';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import type { ResolvedChatConfig } from '../config/config';

export const NOTE_ID_PATTERN = '^(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$)[a-z0-9]+(?:-[a-z0-9]+)*$(?!\\s)';
const noteIdRegex = new RegExp(NOTE_ID_PATTERN);
const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

export const NOTE_LIMITS = {
  id: 64,
  title: 120,
  description: 240,
  body: 64000,
  sourceMessageId: 64,
  sourceMessageIds: 20,
} as const;

const NoteMetadataSchema = v.object({
  title: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(NOTE_LIMITS.title)),
  description: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(NOTE_LIMITS.description)),
  load: v.picklist(['always', 'on-demand']),
  sourceMessageIds: v.optional(v.pipe(
    v.array(v.pipe(v.string(), v.nonEmpty(), v.maxLength(NOTE_LIMITS.sourceMessageId))),
    v.maxLength(NOTE_LIMITS.sourceMessageIds),
  ), []),
});

type NoteMetadata = v.InferOutput<typeof NoteMetadataSchema>;

export interface ChatNote extends NoteMetadata {
  id: string;
  body: string;
  resumeOffset?: number;
}

export type NoteDraft = Omit<ChatNote, 'load' | 'sourceMessageIds' | 'resumeOffset'> & { sourceMessageIds?: string[] };

const bodyVersion = (body: string) => createHash('sha256').update(body).digest('hex');

const isNoteId = (id: string): boolean => id.length <= NOTE_LIMITS.id && noteIdRegex.test(id);

const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

const parseNote = (id: string, content: string): ChatNote | undefined => {
  const match = frontMatter.exec(content);
  if (!match) return undefined;
  try {
    const metadata = v.safeParse(NoteMetadataSchema, parseYaml(match[1]!));
    const body = match[2]!.trim();
    if (metadata.success && body && body.length <= NOTE_LIMITS.body)
      return { id, ...metadata.output, body };
  } catch {
    return undefined;
  }
  return undefined;
};

export const createNoteStore = (
  platform: ResolvedChatConfig['platform'],
  chatId: string,
  root = './data/notes',
) => {
  const folder = join(root, platform, Buffer.from(chatId).toString('hex'));
  const pathFor = (id: string) => join(folder, `${id}.md`);
  const writeAtomic = async (path: string, content: string) => {
    const temp = join(folder, `.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, content, { flag: 'wx', mode: 0o600 });
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true });
    }
  };

  return {
    async list(): Promise<ChatNote[]> {
      const entries = await readdir(folder, { withFileTypes: true }).catch((err: unknown) => {
        if (isMissing(err)) return [];
        throw err;
      });
      const files = new Set(entries.filter(entry => entry.isFile()).map(entry => entry.name));
      const notes = await Promise.all([...files].filter(name => name.endsWith('.md')).map(async name => {
        const id = name.slice(0, -3);
        if (!isNoteId(id)) return undefined;
        const content = await readFile(pathFor(id), 'utf8').catch((err: unknown) => {
          if (isMissing(err)) return '';
          throw err;
        });
        const note = parseNote(id, content);
        if (note && files.has(`${id}.cursor`)) {
          const cursor = await readFile(join(folder, `${id}.cursor`), 'utf8').catch((err: unknown) => {
            if (isMissing(err)) return '';
            throw err;
          });
          const [version, offset] = cursor.split(' ');
          const position = Number(offset);
          if (version === bodyVersion(note.body) && Number.isSafeInteger(position) && position > 0 && position < Array.from(note.body).length)
            note.resumeOffset = position;
        }
        return note;
      }));
      return notes.filter((note): note is ChatNote => note != null)
        .sort((first, second) => first.id.localeCompare(second.id));
    },
    async write(draft: NoteDraft): Promise<void> {
      if (!isNoteId(draft.id)) throw new Error('Invalid note ID');
      const metadata = v.parse(NoteMetadataSchema, { ...draft, load: 'on-demand' });
      const body = draft.body.trim();
      if (!body || body.length > NOTE_LIMITS.body) throw new Error('Invalid note body length');

      const path = pathFor(draft.id);
      const stat = await lstat(path).catch((err: unknown) => {
        if (isMissing(err)) return undefined;
        throw err;
      });
      if (stat) {
        if (!stat.isFile()) throw new Error('The note path is not a regular Markdown file');
        const existing = parseNote(draft.id, await readFile(path, 'utf8'));
        if (existing?.load !== 'on-demand') throw new Error('This note is maintained manually');
      }

      await mkdir(folder, { recursive: true, mode: 0o700 });
      await writeAtomic(path, `---\n${stringifyYaml(metadata)}---\n\n${body}\n`);
    },
    async saveReadPosition(note: ChatNote, offset?: number): Promise<void> {
      if (!isNoteId(note.id)) throw new Error('Invalid note ID');
      const path = join(folder, `${note.id}.cursor`);
      if (offset === undefined) await rm(path, { force: true });
      else await writeAtomic(path, `${bodyVersion(note.body)} ${offset}`);
    },
  };
};
