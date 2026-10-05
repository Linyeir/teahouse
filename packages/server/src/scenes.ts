import type { Scene, SceneStartInput } from '@teahouse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { CanonProposals } from './canon/proposals.ts';
import { currentScene, type SceneRow } from './context/turn.ts';
import type { Db } from './db/index.ts';
import { chats, messages, scenes } from './db/schema.ts';
import type { Generator } from './generation.ts';
import type { Hub } from './hub.ts';
import { complete } from './llm/client.ts';
import { completeJson } from './llm/json.ts';
import { profileFor } from './roles.ts';
import { getSettings } from './settings.ts';
import { newId, now } from './time.ts';
import { getChatRow } from './tree.ts';
import { parseDocument } from './worlds/frontmatter.ts';
import type { WorldService } from './worlds/service.ts';

export class SceneError extends Error {
  constructor(
    readonly code: 'not_found' | 'conflict' | 'invalid',
    message: string,
  ) {
    super(message);
  }
}

export const toScene = (row: SceneRow): Scene => ({
  id: row.id,
  number: row.number,
  status: row.status,
  cast: row.cast,
  startMessageId: row.startMessageId,
  canonCommit: row.canonCommit,
});

const sceneProposal = z.object({
  start_message: z.string().min(1),
  cast: z.array(z.string()).min(1),
});

const SCENE_PROMPT = `You set up the next scene of an interactive roleplay with {{user}}.
From the user's brief and the world canon, write the scene's opening and choose who is present.
The opening is narration of 1-3 short paragraphs that sets place, time and mood and ends where {{user}} can act. Do not act or speak for {{user}}.
Use *asterisks* for actions. Write in {{language}}.
Return one JSON object: {"start_message": "...", "cast": ["character-slug", ...]}, choosing slugs only from the list of characters.`;

export class Scenes {
  constructor(
    private readonly db: Db,
    private readonly worlds: WorldService,
    private readonly hub: Hub,
    private readonly generator: Generator,
    private readonly proposals: CanonProposals,
    private readonly completeFn: typeof complete = complete,
  ) {}

  /** Creates scene 1 of a new chat, with its start message as the root of the tree. */
  createFirst(chatId: string, cast: string[], startMessage: string): SceneRow {
    return this.#insert(chatId, 1, cast, startMessage);
  }

  /**
   * Ends the active scene on the current path. With canon, a proposal is generated and the
   * scene stays `closing` until it is applied; without, it is closed right away.
   */
  close(chatId: string, withCanon: boolean): Scene {
    const chat = getChatRow(this.db, chatId);
    const scene = currentScene(this.db, chatId);
    if (!chat || !scene) throw new SceneError('not_found', 'Chat not found');
    if (scene.status !== 'active') throw new SceneError('conflict', 'The scene is not active');
    if (this.generator.isBusy(chatId))
      throw new SceneError('conflict', 'Wait for the reply to finish');

    const timestamp = now();
    this.db
      .update(scenes)
      .set({
        status: withCanon ? 'closing' : 'closed',
        closedLeafId: chat.activeLeafId,
        updatedAt: timestamp,
        revision: scene.revision + 1,
      })
      .where(eq(scenes.id, scene.id))
      .run();
    if (withCanon) this.proposals.start(scene.id);
    this.hub.broadcast({ type: 'chat.changed', chatId });
    return toScene({ ...scene, status: withCanon ? 'closing' : 'closed' });
  }

  /** Lets the scene start role propose an opening and a cast from a short brief. */
  async propose(chatId: string, brief: string): Promise<SceneStartInput> {
    const chat = getChatRow(this.db, chatId);
    if (!chat) throw new SceneError('not_found', 'Chat not found');
    const settings = getSettings(this.db);
    const characters = await this.worlds.characters(chat.worldId);
    const world = parseDocument(
      (await this.worlds.readIfExists(chat.worldId, 'world.md')) ?? '',
    ).body;
    const events = (await this.worlds.files(chat.worldId))
      .filter((f) => f.type === 'event')
      .slice(-3)
      .map((f) => `- ${f.name}: ${f.summary}`);
    const previous = currentScene(this.db, chatId);

    const system = SCENE_PROMPT.replaceAll('{{user}}', settings.userName).replaceAll(
      '{{language}}',
      settings.outputLanguage,
    );
    const user = [
      `<world>\n${world.trim()}\n</world>`,
      `<characters>\n${characters.map((c) => `- ${c.slug}: ${c.name}${c.summary ? ` – ${c.summary}` : ''}`).join('\n')}\n</characters>`,
      events.length ? `<recent_events>\n${events.join('\n')}\n</recent_events>` : '',
      previous ? `<previous_cast>${previous.cast.join(', ')}</previous_cast>` : '',
      `<brief>\n${brief.trim() || 'Continue the story naturally.'}\n</brief>`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const parsed = await completeJson(
      this.completeFn,
      profileFor(this.db, 'scene'),
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      sceneProposal,
      { name: 'scene_start', minTokens: 1500 },
    );
    const known = new Set(characters.map((c) => c.slug));
    const cast = parsed.cast.filter((slug) => known.has(slug));
    return {
      startMessage: parsed.start_message,
      cast: cast.length ? cast : (previous?.cast ?? []),
    };
  }

  /** Starts the next scene. The previous one must be closed. */
  async start(chatId: string, input: SceneStartInput): Promise<Scene> {
    const chat = getChatRow(this.db, chatId);
    const previous = currentScene(this.db, chatId);
    if (!chat) throw new SceneError('not_found', 'Chat not found');
    if (previous && previous.status !== 'closed') {
      throw new SceneError('conflict', 'Close the current scene first');
    }
    for (const slug of input.cast) {
      if (!(await this.worlds.character(chat.worldId, slug))) {
        throw new SceneError('invalid', `Character ${slug} not found`);
      }
    }
    const scene = this.#insert(chatId, (previous?.number ?? 0) + 1, input.cast, input.startMessage);
    this.hub.broadcast({ type: 'chat.changed', chatId });
    return toScene(scene);
  }

  #insert(chatId: string, number: number, cast: string[], startMessage: string): SceneRow {
    const timestamp = now();
    const sceneId = newId();
    const startId = startMessage.trim() ? newId() : null;
    const row: SceneRow = {
      id: sceneId,
      chatId,
      number,
      status: 'active',
      cast,
      startMessageId: startId,
      closedLeafId: null,
      canonCommit: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      revision: 1,
      deletedAt: null,
    };
    this.db.transaction((tx) => {
      tx.insert(scenes).values(row).run();
      if (startId) {
        tx.insert(messages)
          .values({
            id: startId,
            chatId,
            sceneId,
            parentId: null,
            role: 'assistant',
            content: startMessage,
            status: 'complete',
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .run();
      }
      tx.update(chats)
        .set({ activeLeafId: startId, updatedAt: timestamp })
        .where(eq(chats.id, chatId))
        .run();
    });
    return row;
  }
}
