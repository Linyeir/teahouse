import {
  defaultSpeaker,
  type MemoryNode,
  NARRATOR_SPEAKER,
  type PathMessage,
  sceneStage,
  stageBeats,
} from '@teahouse/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../db/index.ts';
import { memoryNodes, scenes } from '../db/schema.ts';
import type { ChatMessage } from '../llm/client.ts';
import { buildNarratorMessages, type StageInfo } from '../prompt.ts';
import type { ProfileRow } from '../roles.ts';
import { getSettings } from '../settings.ts';
import { activePath, getChatRow } from '../tree.ts';
import type { WorldService } from '../worlds/service.ts';
import { CANON_BUDGET_SHARE, type CanonSelection, selectCanon } from './canon.ts';
import { contextWindow, countMessageTokens, responseReserve } from './tokens.ts';

export type SceneRow = typeof scenes.$inferSelect;

/** Messages of the last three turns are always kept verbatim (concept, section 8). */
export const VERBATIM_TURNS = 3;

export interface TurnContext {
  scene: SceneRow;
  /** Active path of the scene up to the parent of the reply. */
  path: PathMessage[];
  startMessage: PathMessage | null;
  memory: MemoryNode | null;
  /** Messages after the memory node (or the start message), oldest first. */
  history: PathMessage[];
  canon: CanonSelection;
  /** Tokens left for history: context − response reserve − template, canon, memory, start. */
  remaining: number;
  historyTokens: number;
  /** Whose turn it is: a character slug or `NARRATOR_SPEAKER`. */
  speaker: string;
  /** Names of everyone in the scene so far and the speaker, by slug, in scene order. */
  characterNames: Map<string, string>;
  stage: StageInfo;
}

export function currentScene(db: Db, chatId: string): SceneRow | undefined {
  return db
    .select()
    .from(scenes)
    .where(and(eq(scenes.chatId, chatId), isNull(scenes.deletedAt)))
    .orderBy(scenes.number)
    .all()
    .at(-1);
}

/** Memory nodes attached to messages on `path`, in path order. */
export function memoryOnPath(db: Db, sceneId: string, path: { id: string }[]): MemoryNode[] {
  if (path.length === 0) return [];
  const rows = db
    .select()
    .from(memoryNodes)
    .where(
      and(
        eq(memoryNodes.sceneId, sceneId),
        isNull(memoryNodes.deletedAt),
        inArray(
          memoryNodes.messageId,
          path.map((m) => m.id),
        ),
      ),
    )
    .all();
  const position = new Map(path.map((m, i) => [m.id, i]));
  return rows
    .sort(
      (a, b) =>
        (position.get(a.messageId) ?? 0) - (position.get(b.messageId) ?? 0) ||
        a.id.localeCompare(b.id),
    )
    .map((r) => ({ id: r.id, messageId: r.messageId, content: r.content, updatedAt: r.updatedAt }));
}

/**
 * Assembles everything a turn needs: canon within its budget, the latest memory summary on
 * the path, the start message and the history after the summary. `speaker` is whose turn it
 * is; omitted, `defaultSpeaker` picks.
 */
export async function buildTurnContext(
  db: Db,
  worlds: WorldService,
  chatId: string,
  parentId: string | null,
  profile: ProfileRow,
  speaker?: string,
): Promise<TurnContext> {
  const chat = getChatRow(db, chatId);
  const scene = currentScene(db, chatId);
  if (!chat || !scene) throw new Error('Chat has no scene');

  const path = parentId ? activePath(db, chatId, parentId) : [];
  const startMessage = path[0]?.id === scene.startMessageId ? (path[0] ?? null) : null;
  const memory = memoryOnPath(db, scene.id, path).at(-1) ?? null;
  const afterIndex = memory
    ? path.findIndex((m) => m.id === memory.messageId)
    : startMessage
      ? 0
      : -1;
  const history = path.slice(afterIndex + 1);
  const turn = speaker ?? defaultSpeaker(path, scene.cast);

  // Everyone who can appear, with their image labels, and the stage as the scene left it.
  const worldCharacters = await worlds.characters(chat.worldId);
  const replay = sceneStage(path, scene.cast);
  const present = replay.present.map((p) => p.who);
  // Everyone the scene has had so far, in the order they came, so the canon (and with it the
  // system prompt) stays the same when the speaker changes or someone leaves. A character
  // who joins with this turn comes last.
  const appeared = path.flatMap((m) =>
    m.role === 'assistant'
      ? stageBeats(m).flatMap((b) => (b.type === 'say' || b.type === 'enter' ? [b.who] : []))
      : [],
  );
  const core = [
    ...new Set([
      ...scene.cast,
      ...appeared,
      ...present,
      ...(turn === NARRATOR_SPEAKER ? [] : [turn]),
    ]),
  ].filter((slug) => worldCharacters.some((c) => c.slug === slug));
  const characterNames = new Map(
    core.map((slug) => [slug, worldCharacters.find((c) => c.slug === slug)?.name ?? slug]),
  );
  const stage: StageInfo = {
    characters: worldCharacters.map((c) => ({
      slug: c.slug,
      name: c.name,
      moods: [...new Set(c.images.map((i) => i.label))],
    })),
    backgrounds: (await worlds.backgrounds(chat.worldId)).map((b) => ({
      id: b.id,
      description: b.description,
    })),
    background: replay.background,
    present,
  };

  const window = contextWindow(profile);
  const recentText = [
    startMessage?.content,
    memory?.content,
    ...history.slice(-6).map((m) => m.content),
  ]
    .filter(Boolean)
    .join('\n');
  const canon = await selectCanon(worlds, {
    worldId: chat.worldId,
    chatId,
    cast: core,
    // The speaker's file is the last to be cut to its summary.
    keep: turn === NARRATOR_SPEAKER ? undefined : turn,
    recentText,
    budget: Math.floor(window * CANON_BUDGET_SHARE),
  });

  const fixed = buildNarratorMessages({
    ...narratorVars(db, characterNames, turn),
    stage,
    canon: canon.text,
    memory: memory?.content ?? '',
    startMessage: startMessage?.content ?? null,
    history: [],
  });
  const remaining = window - responseReserve(profile) - countMessageTokens(fixed);

  return {
    scene,
    path,
    startMessage,
    memory,
    history,
    canon,
    remaining,
    historyTokens: countMessageTokens(history),
    speaker: turn,
    characterNames,
    stage,
  };
}

function narratorVars(db: Db, names: Map<string, string>, speaker: string) {
  const settings = getSettings(db);
  const character =
    speaker === NARRATOR_SPEAKER ? null : { slug: speaker, name: names.get(speaker) ?? speaker };
  const everyone = [...names.values()].join(' and ');
  return {
    speaker: character,
    characterName: character?.name ?? everyone,
    sceneName: everyone,
    userName: settings.userName,
    language: settings.outputLanguage,
  };
}

/** The final prompt for a turn. Drops the oldest history messages if they still do not fit. */
export function narratorPrompt(db: Db, ctx: TurnContext): ChatMessage[] {
  let history = ctx.history;
  while (history.length > 1 && countMessageTokens(history) > ctx.remaining) {
    history = history.slice(1);
  }
  return buildNarratorMessages({
    ...narratorVars(db, ctx.characterNames, ctx.speaker),
    stage: ctx.stage,
    canon: ctx.canon.text,
    memory: ctx.memory?.content ?? '',
    startMessage: ctx.startMessage?.content ?? null,
    history: history.map((m) => ({ role: m.role, content: m.content })),
  });
}

/** Index in `history` where the verbatim tail (the last three turns) begins. */
export function verbatimStart(history: { role: string }[]): number {
  let turns = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.role === 'user' && ++turns === VERBATIM_TURNS) return i;
  }
  return 0;
}
