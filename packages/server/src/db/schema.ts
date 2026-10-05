import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Columns every synced row carries, so v0.3 sync can be added without a migration of the model.
const syncColumns = {
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  revision: integer('revision').notNull().default(1),
  deletedAt: text('deleted_at'),
};

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
});

export const devices = sqliteTable('devices', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: text('created_at').notNull(),
  lastSeenAt: text('last_seen_at'),
  revokedAt: text('revoked_at'),
});

export const profiles = sqliteTable('profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(),
  apiKey: text('api_key'),
  model: text('model').notNull(),
  temperature: real('temperature'),
  topP: real('top_p'),
  maxTokens: integer('max_tokens'),
  contextWindowOverride: integer('context_window_override'),
  detectedContextWindow: integer('detected_context_window'),
  ...syncColumns,
});

export const chats = sqliteTable('chats', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  /** ID from the world's `world.md`. Worlds are folders, not rows. */
  worldId: text('world_id').notNull(),
  /** File slug of the character: `characters/<slug>.md`. */
  characterSlug: text('character_slug').notNull(),
  activeLeafId: text('active_leaf_id'),
  ...syncColumns,
});

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id),
    sceneId: text('scene_id'),
    parentId: text('parent_id'),
    role: text('role', { enum: ['user', 'assistant'] }).notNull(),
    content: text('content').notNull(),
    status: text('status', { enum: ['complete', 'streaming', 'stopped', 'error'] }).notNull(),
    error: text('error'),
    profileId: text('profile_id'),
    model: text('model'),
    ...syncColumns,
  },
  (t) => [index('messages_chat_idx').on(t.chatId), index('messages_parent_idx').on(t.parentId)],
);

export const scenes = sqliteTable(
  'scenes',
  {
    id: text('id').primaryKey(),
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id),
    /** 1-based position in the chat. */
    number: integer('number').notNull(),
    status: text('status', { enum: ['active', 'closing', 'closed'] }).notNull(),
    /** Character slugs present in the scene. */
    cast: text('cast', { mode: 'json' }).$type<string[]>().notNull(),
    /** Root message of the scene's message tree. */
    startMessageId: text('start_message_id'),
    /** Leaf of the path chosen when the scene was closed. */
    closedLeafId: text('closed_leaf_id'),
    /** World commit the scene's canon update produced, if any. */
    canonCommit: text('canon_commit'),
    ...syncColumns,
  },
  (t) => [index('scenes_chat_idx').on(t.chatId)],
);

export const memoryNodes = sqliteTable(
  'memory_nodes',
  {
    id: text('id').primaryKey(),
    sceneId: text('scene_id')
      .notNull()
      .references(() => scenes.id),
    /** The summary covers the scene up to and including this message. */
    messageId: text('message_id').notNull(),
    content: text('content').notNull(),
    ...syncColumns,
  },
  (t) => [index('memory_scene_idx').on(t.sceneId), index('memory_message_idx').on(t.messageId)],
);

export interface ProposalFile {
  path: string;
  /** Content at the proposal's base commit; null for new files. */
  before: string | null;
  /** Proposed content (possibly edited by the user). */
  after: string;
  decision: 'pending' | 'accepted' | 'rejected';
}

export const canonProposals = sqliteTable('canon_proposals', {
  id: text('id').primaryKey(),
  sceneId: text('scene_id')
    .notNull()
    .references(() => scenes.id),
  status: text('status', { enum: ['generating', 'ready', 'failed', 'applied'] }).notNull(),
  /** World commit the proposal was generated against, for the three-way merge. */
  baseCommit: text('base_commit'),
  files: text('files', { mode: 'json' }).$type<ProposalFile[]>().notNull(),
  error: text('error'),
  ...syncColumns,
});
