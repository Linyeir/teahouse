import { findUserLine, type Message } from '@teahouse/shared';
import { eq } from 'drizzle-orm';
import { buildTurnContext, currentScene, narratorPrompt } from './context/turn.ts';
import type { Db } from './db/index.ts';
import { chats, messages } from './db/schema.ts';
import type { Hub } from './hub.ts';
import { type ChatMessage, type GenerationProfile, streamChat } from './llm/client.ts';
import type { Memory } from './memory.ts';
import { NoProfileError, profileFor } from './roles.ts';
import { getSettings } from './settings.ts';
import { newId, now } from './time.ts';
import { getChatRow, toMessage } from './tree.ts';
import type { WorldService } from './worlds/service.ts';

export class GenerationError extends Error {
  constructor(
    readonly code: 'no_profile' | 'busy' | 'not_found' | 'scene_closed',
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
    private readonly worlds: WorldService,
    private readonly memory: Memory,
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
  async start(chatId: string, parentId: string | null): Promise<Message> {
    const chat = getChatRow(this.db, chatId);
    if (!chat) throw new GenerationError('not_found', 'Chat not found');
    this.#assertIdle(chatId);
    const scene = currentScene(this.db, chatId);
    if (scene?.status !== 'active') {
      throw new GenerationError('scene_closed', 'Start a new scene to continue');
    }
    let profile: ReturnType<typeof profileFor>;
    try {
      profile = profileFor(this.db, 'narrator');
    } catch (err) {
      if (err instanceof NoProfileError) throw new GenerationError('no_profile', err.message);
      throw err;
    }
    for (const slug of scene.cast) {
      if (!(await this.worlds.character(chat.worldId, slug).catch(() => null))) {
        throw new GenerationError('not_found', `Character ${slug} not found`);
      }
    }

    let ctx = await buildTurnContext(this.db, this.worlds, chatId, parentId, profile);
    // History over budget: wait for (or run) a summary, then rebuild with it.
    if (await this.memory.ensureFits(chatId, ctx)) {
      ctx = await buildTurnContext(this.db, this.worlds, chatId, parentId, profile);
    }
    const prompt = narratorPrompt(this.db, ctx);
    // Building the context was async: another request may have started a reply meanwhile.
    // Everything from here to registering the run is synchronous.
    this.#assertIdle(chatId);

    const timestamp = now();
    const row = {
      id: newId(),
      chatId,
      sceneId: scene.id,
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

  #assertIdle(chatId: string): void {
    if (this.isBusy(chatId))
      throw new GenerationError('busy', 'A reply is already being generated');
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
    let wroteForUser = false;
    let error: string | null = null;

    try {
      const userNames = [getSettings(this.db).userName];
      for await (const raw of this.stream(profile, prompt, controller.signal)) {
        let delta = raw;
        // The model started a line for the user's persona: keep what came before, end the reply.
        // The start of that tag may already be in `content`; the final message replaces it.
        const cut = findUserLine(content + delta, userNames);
        if (cut !== null) {
          const kept = (content + delta).slice(0, cut);
          delta = kept.slice(Math.min(content.length, kept.length));
          content = kept.slice(0, kept.length - delta.length);
          wroteForUser = true;
        }
        if (delta) {
          this.hub.broadcast({
            type: 'generation.delta',
            chatId: message.chatId,
            messageId: message.id,
            offset: content.length,
            delta,
          });
        }
        content += delta;
        if (wroteForUser) {
          controller.abort();
          break;
        }
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
    if (wroteForUser) {
      status = 'complete';
      error = null;
      content = content.trimEnd();
    }

    const updated = this.#persist(message.id, { content, status, error });
    this.#running.delete(message.id);
    if (updated) {
      this.hub.broadcast({ type: 'generation.finished', chatId: message.chatId, message: updated });
    }
    if (status === 'complete') this.memory.maybeSummarize(message.chatId);
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
}
