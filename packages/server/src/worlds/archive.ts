import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import * as tar from 'tar';
import { z } from 'zod';
import type { Db } from '../db/index.ts';
import { canonProposals, chats, memoryNodes, messages, scenes } from '../db/schema.ts';
import { newId, now } from '../time.ts';
import { parseDocument, stringifyDocument } from './frontmatter.ts';
import { slug, type WorldService } from './service.ts';

/**
 * World archives (concept, section 12): the world folder with its Git history and assets,
 * plus the world's chats. This is also the format for sharing worlds. Profiles and keys
 * are never included.
 */
export const ARCHIVE_FORMAT = 'teahouse-world';
export const ARCHIVE_VERSION = 1;

const manifest = z.object({
  format: z.literal(ARCHIVE_FORMAT),
  version: z.number().int(),
  name: z.string(),
  exportedAt: z.string(),
});

type ChatRow = typeof chats.$inferSelect;
type SceneRow = typeof scenes.$inferSelect;
type MessageRow = typeof messages.$inferSelect;
type MemoryRow = typeof memoryNodes.$inferSelect;
type ProposalRow = typeof canonProposals.$inferSelect;

interface ChatExport {
  chat: ChatRow;
  scenes: SceneRow[];
  messages: MessageRow[];
  memory: MemoryRow[];
  proposals: ProposalRow[];
}

export class ArchiveError extends Error {}

/** Writes a `.tar.gz` of the world to a temporary file and returns its path and a cleanup. */
export async function exportWorld(db: Db, worlds: WorldService, worldId: string) {
  const world = await worlds.get(worldId);
  const dir = await mkdtemp(join(tmpdir(), 'teahouse-export-'));
  const staging = join(dir, 'staging');
  await mkdir(staging);

  // Copy under the world's Git queue so the snapshot is consistent.
  await worlds
    .repo(world.folder)
    .run(() => cp(worlds.dir(world.folder), join(staging, 'world'), { recursive: true }));

  const chatRows = db
    .select()
    .from(chats)
    .where(and(eq(chats.worldId, worldId), isNull(chats.deletedAt)))
    .all();
  const exports: ChatExport[] = chatRows.map((chat) => {
    const sceneRows = db.select().from(scenes).where(eq(scenes.chatId, chat.id)).all();
    const sceneIds = sceneRows.map((s) => s.id);
    return {
      chat,
      scenes: sceneRows,
      messages: db.select().from(messages).where(eq(messages.chatId, chat.id)).all(),
      memory: sceneIds.length
        ? db.select().from(memoryNodes).where(inArray(memoryNodes.sceneId, sceneIds)).all()
        : [],
      proposals: sceneIds.length
        ? db.select().from(canonProposals).where(inArray(canonProposals.sceneId, sceneIds)).all()
        : [],
    };
  });
  await writeFile(
    join(staging, 'manifest.json'),
    JSON.stringify(
      { format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, name: world.name, exportedAt: now() },
      null,
      2,
    ),
  );
  await writeFile(join(staging, 'chats.json'), JSON.stringify(exports));

  const file = join(dir, `${world.folder}.teahouse.tar.gz`);
  await tar.c({ gzip: true, cwd: staging, file, portable: true }, [
    'manifest.json',
    'chats.json',
    'world',
  ]);
  await rm(staging, { recursive: true, force: true });
  return {
    file,
    name: `${world.folder}.teahouse.tar.gz`,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/**
 * Imports a world archive as a new world. If the world (or any of its chats) already exists
 * on this server, everything gets new IDs, and the chat references in events/ are rewritten.
 */
export async function importWorld(db: Db, worlds: WorldService, archive: Readable) {
  const dir = await mkdtemp(join(tmpdir(), 'teahouse-import-'));
  try {
    await pipeline(
      archive,
      tar.x({
        cwd: dir,
        strict: true,
        // Only plain files and folders; no links that could point outside the world.
        filter: (path, entry) => {
          const type = 'type' in entry ? entry.type : null;
          return (
            (type === 'File' || type === 'Directory') && !posix.normalize(path).startsWith('..')
          );
        },
      }),
    );
    const parsed = manifest.safeParse(
      JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8').catch(() => '{}')),
    );
    if (!parsed.success) throw new ArchiveError('This is not a Teahouse world archive');
    if (parsed.data.version > ARCHIVE_VERSION) {
      throw new ArchiveError('The archive comes from a newer Teahouse version');
    }
    const worldDir = join(dir, 'world');
    if (!(await stat(join(worldDir, 'world.md')).catch(() => null))) {
      throw new ArchiveError('The archive contains no world.md');
    }
    const exports = z
      .array(z.any())
      .parse(
        JSON.parse(await readFile(join(dir, 'chats.json'), 'utf8').catch(() => '[]')),
      ) as ChatExport[];

    const worldDoc = parseDocument(await readFile(join(worldDir, 'world.md'), 'utf8'));
    const oldWorldId = typeof worldDoc.data.id === 'string' ? worldDoc.data.id : null;
    const existing = new Set((await worlds.list()).map((w) => w.id));
    const chatIds = exports.map((e) => e.chat.id);
    const chatClash =
      chatIds.length > 0 &&
      db.select({ id: chats.id }).from(chats).where(inArray(chats.id, chatIds)).all().length > 0;
    const copy = (oldWorldId !== null && existing.has(oldWorldId)) || chatClash;

    const ids = new Map<string, string>();
    const id = (old: string | null): string | null => {
      if (old === null || !copy) return old;
      if (!ids.has(old)) ids.set(old, newId());
      return ids.get(old) ?? old;
    };

    const worldId = copy || !oldWorldId ? newId() : oldWorldId;
    worldDoc.data.id = worldId;
    await writeFile(join(worldDir, 'world.md'), stringifyDocument(worldDoc));
    if (copy) await rewriteEventReferences(worldDir, id);

    const folder = await uniqueFolder(worlds, slug(parsed.data.name, 'world'));
    await rename(worldDir, worlds.dir(folder)).catch(async () => {
      // Different file systems: copy instead.
      await cp(worldDir, worlds.dir(folder), { recursive: true });
    });
    const repo = worlds.repo(folder);
    await repo.ensure();
    await repo.commitAll(
      copy ? `Import ${parsed.data.name} as a copy` : `Import ${parsed.data.name}`,
    );

    db.transaction((tx) => {
      for (const e of exports) {
        tx.insert(chats)
          .values({
            ...e.chat,
            id: id(e.chat.id) as string,
            worldId,
            activeLeafId: id(e.chat.activeLeafId),
          })
          .run();
        for (const s of e.scenes) {
          tx.insert(scenes)
            .values({
              ...s,
              id: id(s.id) as string,
              chatId: id(s.chatId) as string,
              startMessageId: id(s.startMessageId),
              closedLeafId: id(s.closedLeafId),
            })
            .run();
        }
        for (const m of e.messages) {
          tx.insert(messages)
            .values({
              ...m,
              id: id(m.id) as string,
              chatId: id(m.chatId) as string,
              sceneId: id(m.sceneId),
              parentId: id(m.parentId),
              // A reply that was streaming when exported can never finish here.
              status: m.status === 'streaming' ? 'stopped' : m.status,
              profileId: null,
            })
            .run();
        }
        for (const n of e.memory) {
          tx.insert(memoryNodes)
            .values({
              ...n,
              id: id(n.id) as string,
              sceneId: id(n.sceneId) as string,
              messageId: id(n.messageId) as string,
            })
            .run();
        }
        for (const p of e.proposals) {
          tx.insert(canonProposals)
            .values({
              ...p,
              id: id(p.id) as string,
              sceneId: id(p.sceneId) as string,
              // A proposal that was being generated is offered for regeneration.
              status: p.status === 'generating' ? 'failed' : p.status,
            })
            .run();
        }
      }
    });
    await worlds.list();
    return { worldId, folder, chats: exports.length, copy };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function uniqueFolder(worlds: WorldService, base: string): Promise<string> {
  for (let n = 1; ; n++) {
    const folder = n === 1 ? base : `${base}-${n}`;
    if (!(await stat(worlds.dir(folder)).catch(() => null))) return folder;
  }
}

/** Points `chat:` and `scene:` of event files at the new IDs. */
async function rewriteEventReferences(worldDir: string, id: (old: string | null) => string | null) {
  const eventsDir = join(worldDir, 'events');
  const files = await readdir(eventsDir).catch(() => [] as string[]);
  for (const file of files.filter((f) => f.endsWith('.md'))) {
    const path = join(eventsDir, file);
    const doc = parseDocument(await readFile(path, 'utf8'));
    if (doc.error) continue;
    let changed = false;
    for (const key of ['chat', 'scene'] as const) {
      if (typeof doc.data[key] === 'string') {
        doc.data[key] = id(doc.data[key] as string);
        changed = true;
      }
    }
    if (changed) await writeFile(path, stringifyDocument(doc));
  }
}
