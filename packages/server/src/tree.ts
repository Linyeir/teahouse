import type { Chat, Message, PathMessage } from '@teahouse/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from './db/index.ts';
import { chats, messages } from './db/schema.ts';

type MessageRow = typeof messages.$inferSelect;
type ChatRow = typeof chats.$inferSelect;

export const toMessage = (row: MessageRow): Message => ({
  id: row.id,
  chatId: row.chatId,
  parentId: row.parentId,
  role: row.role,
  content: row.content,
  status: row.status,
  error: row.error,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const toChat = (row: ChatRow): Chat => ({
  id: row.id,
  title: row.title,
  worldId: row.worldId,
  characterSlug: row.characterSlug,
  activeLeafId: row.activeLeafId,
  updatedAt: row.updatedAt,
});

export function getChatRow(db: Db, chatId: string): ChatRow | undefined {
  return db
    .select()
    .from(chats)
    .where(and(eq(chats.id, chatId), isNull(chats.deletedAt)))
    .get();
}

export function getMessageRow(db: Db, messageId: string): MessageRow | undefined {
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), isNull(messages.deletedAt)))
    .get();
}

function loadTree(db: Db, chatId: string) {
  const rows = db
    .select()
    .from(messages)
    .where(and(eq(messages.chatId, chatId), isNull(messages.deletedAt)))
    .all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const children = new Map<string | null, MessageRow[]>();
  for (const row of rows) {
    const list = children.get(row.parentId) ?? [];
    list.push(row);
    children.set(row.parentId, list);
  }
  // UUIDv7 sorts by creation time.
  for (const list of children.values()) list.sort((a, b) => a.id.localeCompare(b.id));
  return { byId, children };
}

/** Messages from the root to `leafId`, each with the IDs of its siblings. */
export function activePath(db: Db, chatId: string, leafId: string | null): PathMessage[] {
  const { byId, children } = loadTree(db, chatId);
  const path: PathMessage[] = [];
  let current = leafId ? byId.get(leafId) : undefined;
  while (current) {
    // Each scene's start message is a root of its own; roots of other scenes are not siblings.
    const siblings = current.parentId ? (children.get(current.parentId) ?? [current]) : [current];
    path.push({ ...toMessage(current), siblingIds: siblings.map((s) => s.id) });
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path.reverse();
}

/** Follows the newest child from `messageId` down to a leaf. */
export function deepestLeaf(db: Db, chatId: string, messageId: string): string {
  const { children } = loadTree(db, chatId);
  let id = messageId;
  for (;;) {
    const next = children.get(id)?.at(-1);
    if (!next) return id;
    id = next.id;
  }
}
