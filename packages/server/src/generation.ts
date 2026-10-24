import {
  findForeignLine,
  type Message,
  NARRATOR_SPEAKER,
  normalizeSpeakers,
  stripReasoning,
  USER_SPEAKER,
} from '@teahouse/shared';
import { eq } from 'drizzle-orm';
import { buildTurnContext, currentScene, narratorPrompt } from './context/turn.ts';
import type { Db } from './db/index.ts';
import { chats, messages } from './db/schema.ts';
import type { Hub } from './hub.ts';
import {
  type ChatMessage,
  describeLlmError,
  type GenerationProfile,
  streamChat,
} from './llm/client.ts';
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

/** Where reply outcomes are reported; the server passes its logger. */
export interface GenerationLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

const silentLog: GenerationLog = { info() {}, warn() {} };

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
    private readonly log: GenerationLog = silentLog,
  ) {}

  isBusy(chatId: string): boolean {
    for (const run of this.#running.values()) if (run.chatId === chatId) return true;
    return false;
  }

  /**
   * Creates an assistant message under `parentId`, makes it the active leaf and streams the
   * reply into it in the background. Returns the new (still streaming) message. `speaker` is
   * whose turn it is (a character slug or `NARRATOR_SPEAKER`); omitted, `defaultSpeaker` picks.
   */
  async start(chatId: string, parentId: string | null, speaker?: string): Promise<Message> {
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

    let ctx = await buildTurnContext(this.db, this.worlds, chatId, parentId, profile, speaker);
    const character =
      ctx.speaker === NARRATOR_SPEAKER
        ? null
        : await this.worlds.character(chat.worldId, ctx.speaker).catch(() => null);
    if (ctx.speaker !== NARRATOR_SPEAKER && !character) {
      throw new GenerationError('not_found', `Character ${ctx.speaker} not found`);
    }
    // History over budget: wait for (or run) a summary, then rebuild with it.
    if (await this.memory.ensureFits(chatId, ctx)) {
      ctx = await buildTurnContext(this.db, this.worlds, chatId, parentId, profile, ctx.speaker);
    }
    const prompt = narratorPrompt(this.db, ctx);
    const resolve = await speakerResolver(this.worlds, chat.worldId);
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
      speaker: ctx.speaker,
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
    void this.#run(message, profile, prompt, controller, profile.name, resolve);
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
    profileName: string,
    resolve: (who: string) => string | null,
  ): Promise<void> {
    let content = '';
    let lastPersist = Date.now();
    let status: Message['status'] = 'complete';
    let wroteForOther = false;
    let error: string | null = null;
    const started = Date.now();
    const where = {
      chatId: message.chatId,
      messageId: message.id,
      model: profile.model,
      baseUrl: profile.baseUrl,
    };
    this.log.info({ ...where, promptMessages: prompt.length }, 'Generating reply');

    try {
      // Lines the reply may contain: the speaker's own, under their slug, name or an alias.
      const userNames = new Set([USER_SPEAKER, getSettings(this.db).userName.toLowerCase()]);
      const foreign = (who: string) =>
        userNames.has(who.trim().toLowerCase()) ||
        message.speaker === NARRATOR_SPEAKER ||
        resolve(who) !== message.speaker;
      for await (const raw of this.stream(profile, prompt, controller.signal)) {
        let delta = raw;
        // The model started a line for someone else (the user's persona, another character):
        // keep what came before, end the reply. The start of that tag may already be in
        // `content`; the final message replaces it.
        const cut = findForeignLine(content + delta, foreign);
        if (cut !== null) {
          const kept = (content + delta).slice(0, cut);
          delta = kept.slice(Math.min(content.length, kept.length));
          content = kept.slice(0, kept.length - delta.length);
          wroteForOther = true;
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
        if (wroteForOther) {
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
        // Name the profile: with several profiles it is not obvious which one a chat uses.
        error = `${profileName} (${profile.model}): ${describeLlmError(err, profile.baseUrl)}`;
      }
    }
    if (controller.signal.aborted) status = 'stopped';
    if (wroteForOther) {
      status = 'complete';
      error = null;
      content = content.trimEnd();
    }
    // What is stored, and so fed back into later prompts: no reasoning, and every speaker
    // under their slug, so `who="Mira"` does not put a second, imageless Mira on the stage.
    content = normalizeSpeakers(stripReasoning(content), resolve).trim();

    const updated = this.#persist(message.id, { content, status, error });
    this.#running.delete(message.id);
    const outcome = { ...where, status, chars: content.length, ms: Date.now() - started };
    if (status === 'error') this.log.warn({ ...outcome, error }, 'Reply failed');
    else if (!content.trim() && status === 'complete')
      this.log.warn(outcome, 'Reply came back empty');
    else this.log.info({ ...outcome, wroteForOther }, 'Reply finished');
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

/** Maps a character's slug, name or alias, in any case, to the slug. */
async function speakerResolver(
  worlds: WorldService,
  worldId: string,
): Promise<(who: string) => string | null> {
  const names = new Map<string, string>();
  const files = await worlds.files(worldId);
  for (const f of files) {
    if (!(f.type === 'character' || (f.type === null && f.path.startsWith('characters/'))))
      continue;
    const slug = f.path.slice('characters/'.length, -'.md'.length);
    if (slug.includes('/')) continue;
    // Slugs first: a name or alias never takes over another character's slug.
    for (const key of [f.name, ...f.aliases]) {
      const k = key.trim().toLowerCase();
      if (k && !names.has(k)) names.set(k, slug);
    }
  }
  for (const f of files) {
    if (f.path.startsWith('characters/')) {
      const slug = f.path.slice('characters/'.length, -'.md'.length);
      names.set(slug.toLowerCase(), slug);
    }
  }
  return (who) => names.get(who.trim().toLowerCase()) ?? null;
}
