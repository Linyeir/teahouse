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

// Placeholder until characters move into world folders (v0.1 step 2).
export const characters = sqliteTable('characters', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  firstMessage: text('first_message').notNull(),
  ...syncColumns,
});

export const chats = sqliteTable('chats', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  characterId: text('character_id')
    .notNull()
    .references(() => characters.id),
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
