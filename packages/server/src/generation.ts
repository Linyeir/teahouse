import type { Message } from '@teahouse/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from './db/index.ts';
import { characters, chats, messages, profiles } from './db/schema.ts';
import type { Hub } from './hub.ts';
import { type ChatMessage, type GenerationProfile, streamChat } from './llm/client.ts';
import { buildNarratorMessages } from './prompt.ts';
import { getSettings } from './settings.ts';
import { newId, now } from './time.ts';
import { activePath, getChatRow, toMessage } from './tree.ts';

export class GenerationError extends Error {
  constructor(
    readonly code: 'no_profile' | 'busy' | 'not_found',
    message: string,
  ) {
    super(message);
  }
}

export type StreamFn = (
  profile: GenerationProfile,
  messages: ChatMessage[],
  signal: AbortSignal,
) => AsyncIterable<string>;

const PERSIST_INTERVAL_MS = 1000;

export class Generator {
  readonly #running = new Map<string, { chatId: string; controller: AbortController }>();

  constructor(
    private readonly db: Db,
    private readonly hub: Hub,
    private readonly stream: StreamFn = streamChat,
  ) {}

  isBusy(chatId: string): boolean {
    for (const run of this.#running.values()) if (run.chatId === chatId) return true;
    return false;
  }

  /**
   * Creates an assistant message under `parentId`, makes it the active leaf and streams the
   * reply into it in the background. Returns the new (still streaming) message.
   */
  start(chatId: string, parentId: string | null): Message {
    const chat = getChatRow(this.db, chatId);
    if (!chat) throw new GenerationError('not_found', 'Chat not found');
    if (this.isBusy(chatId))
      throw new GenerationError('busy', 'A reply is already being generated');

    const profile = this.#narratorProfile();
    const character = this.db
      .select()
      .from(characters)
      .where(eq(characters.id, chat.characterId))
      .get();
    if (!character) throw new GenerationError('not_found', 'Character not found');

    const settings = getSettings(this.db);
    const history = parentId ? activePath(this.db, chatId, parentId) : [];
    const prompt = buildNarratorMessages({
      characterName: character.name,
      characterDescription: character.description,
      userName: settings.userName,
      language: settings.outputLanguage,
      history: history.map((m) => ({ role: m.role, content: m.content })),
    });

    const timestamp = now();
    const row = {
      id: newId(),
      chatId,
      parentId,
      role: 'assistant' as const,
      content: '',
      status: 'streaming' as const,
      error: null,
      profileId: profile.id,
      model: profile.model,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db.transaction((tx) => {
      tx.insert(messages).values(row).run();
      tx.update(chats)
        .set({ activeLeafId: row.id, updatedAt: timestamp })
        .where(eq(chats.id, chatId))
        .run();
    });

    const message = toMessage({ ...row, revision: 1, deletedAt: null });
    const controller = new AbortController();
    this.#running.set(row.id, { chatId, controller });
    this.hub.broadcast({ type: 'generation.started', chatId, message });
    void this.#run(message, profile, prompt, controller);
    return message;
  }

  stop(messageId: string): boolean {
    const run = this.#running.get(messageId);
    run?.controller.abort();
    return Boolean(run);
  }

  /** Stops all generations and waits until their partial text is saved. */
  async stopAll(): Promise<void> {
    for (const run of this.#running.values()) run.controller.abort();
    await this.idle();
  }

  /** Resolves when no generation is running. */
  async idle(): Promise<void> {
    while (this.#running.size > 0) await new Promise((r) => setTimeout(r, 10));
  }

  async #run(
    message: Message,
    profile: GenerationProfile,
    prompt: ChatMessage[],
    controller: AbortController,
  ): Promise<void> {
    let content = '';
    let lastPersist = Date.now();
    let status: Message['status'] = 'complete';
    let error: string | null = null;

    try {
      for await (const delta of this.stream(profile, prompt, controller.signal)) {
        this.hub.broadcast({
          type: 'generation.delta',
          chatId: message.chatId,
          messageId: message.id,
          offset: content.length,
          delta,
        });
        content += delta;
        if (Date.now() - lastPersist > PERSIST_INTERVAL_MS) {
          this.#persist(message.id, { content });
          lastPersist = Date.now();
        }
      }
    } catch (err) {
      if (controller.signal.aborted) {
        status = 'stopped';
      } else {
        status = 'error';
        error = err instanceof Error ? err.message : String(err);
      }
    }
    if (controller.signal.aborted) status = 'stopped';

    const updated = this.#persist(message.id, { content, status, error });
    this.#running.delete(message.id);
    if (updated) {
      this.hub.broadcast({ type: 'generation.finished', chatId: message.chatId, message: updated });
    }
  }

  #persist(
    id: string,
    patch: Partial<Pick<typeof messages.$inferInsert, 'content' | 'status' | 'error'>>,
  ): Message | null {
    const row = this.db
      .update(messages)
      .set({ ...patch, updatedAt: now() })
      .where(eq(messages.id, id))
      .returning()
      .get();
    return row ? toMessage(row) : null;
  }

  #narratorProfile(): GenerationProfile & { id: string } {
    const { narratorProfileId } = getSettings(this.db);
    const active = isNull(profiles.deletedAt);
    const row = narratorProfileId
      ? this.db
          .select()
          .from(profiles)
          .where(and(eq(profiles.id, narratorProfileId), active))
          .get()
      : this.db.select().from(profiles).where(active).orderBy(profiles.createdAt).get();
    if (!row) throw new GenerationError('no_profile', 'No profile is configured for the narrator');
    return row;
  }
}
