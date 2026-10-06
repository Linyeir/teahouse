import type { PathMessage } from '@teahouse/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { countMessageTokens } from './context/tokens.ts';
import { buildTurnContext, type TurnContext, verbatimStart } from './context/turn.ts';
import type { Db } from './db/index.ts';
import { memoryNodes, messages } from './db/schema.ts';
import { complete } from './llm/client.ts';
import { profileFor } from './roles.ts';
import { getSettings } from './settings.ts';
import { newId, now } from './time.ts';
import { getChatRow } from './tree.ts';
import type { WorldService } from './worlds/service.ts';

/** Summarize in the background once history reaches this share of the remaining budget… */
export const TRIGGER_SHARE = 0.8;
/** …and fold in enough of it that history drops to about this share. */
export const TARGET_SHARE = 0.5;

export type CompleteFn = typeof complete;

const SUMMARY_PROMPT = `You keep the running summary of an ongoing roleplay scene between {{user}} and the story.
You get the summary so far and the part of the scene that comes next. Return the updated summary of the whole scene so far.
Keep every fact that matters later: who is present, what happened, decisions, promises, injuries, items, relationships, open threads, where everyone is.
Write in past tense, in {{language}}, as compact prose without headings. Stay under 400 words. Return only the summary.`;

/**
 * Active Memory: a summary of the running scene stored as a node on the message it covers up
 * to. Forks and swipes inherit only summaries before their branch point, because nodes are
 * found by walking the active path.
 */
export class Memory {
  readonly #running = new Map<string, Promise<void>>();

  constructor(
    private readonly db: Db,
    private readonly worlds: WorldService,
    private readonly completeFn: CompleteFn = complete,
    private readonly onError: (err: unknown) => void = () => {},
  ) {}

  /** Starts a background summary when the history passed the trigger. */
  maybeSummarize(chatId: string): void {
    if (this.#running.has(chatId)) return;
    const run = this.#check(chatId, TRIGGER_SHARE)
      .catch(this.onError) // Retried after the next turn.
      .finally(() => this.#running.delete(chatId));
    this.#running.set(chatId, run);
  }

  /** Before a turn: makes sure the history fits, waiting for or running a summary if not. */
  async ensureFits(chatId: string, ctx: TurnContext): Promise<boolean> {
    if (ctx.historyTokens <= ctx.remaining) return false;
    const running = this.#running.get(chatId);
    if (running) await running;
    else await this.#check(chatId, 1);
    return true;
  }

  async idle(): Promise<void> {
    await Promise.allSettled(this.#running.values());
  }

  /** Drops summaries that cover an edited message, then re-checks the budget. */
  invalidate(chatId: string, sceneId: string, messageId: string): void {
    const rows = this.db.select().from(messages).where(eq(messages.chatId, chatId)).all();
    const parent = new Map(rows.map((r) => [r.id, r.parentId]));
    const covers = (leaf: string) => {
      for (let id: string | null | undefined = leaf; id; id = parent.get(id)) {
        if (id === messageId) return true;
      }
      return false;
    };
    const timestamp = now();
    for (const node of this.db
      .select()
      .from(memoryNodes)
      .where(and(eq(memoryNodes.sceneId, sceneId), isNull(memoryNodes.deletedAt)))
      .all()) {
      if (!covers(node.messageId)) continue;
      this.db
        .update(memoryNodes)
        .set({ deletedAt: timestamp, updatedAt: timestamp, revision: node.revision + 1 })
        .where(eq(memoryNodes.id, node.id))
        .run();
    }
    this.maybeSummarize(chatId);
  }

  async #check(chatId: string, triggerShare: number): Promise<void> {
    const chat = getChatRow(this.db, chatId);
    if (!chat?.activeLeafId) return;
    // Repeat until the history fits: one call may not be enough after a long import or edit.
    for (let round = 0; round < 5; round++) {
      const ctx = await buildTurnContext(
        this.db,
        this.worlds,
        chatId,
        chat.activeLeafId,
        profileFor(this.db, 'narrator'),
      );
      if (ctx.scene.status !== 'active') return;
      if (ctx.historyTokens < ctx.remaining * triggerShare) return;
      const section = pickSection(ctx);
      if (section.length === 0) return;
      await this.#summarize(ctx, section);
      triggerShare = TARGET_SHARE;
    }
  }

  async #summarize(ctx: TurnContext, section: PathMessage[]): Promise<void> {
    const settings = getSettings(this.db);
    const names = [...ctx.characterNames.values()].join(', ');
    const transcript = section
      .map((m) => `${m.role === 'user' ? settings.userName : names || 'Story'}: ${m.content}`)
      .join('\n\n');
    const system = SUMMARY_PROMPT.replaceAll('{{user}}', settings.userName).replaceAll(
      '{{language}}',
      settings.outputLanguage,
    );
    const user = [
      ctx.startMessage ? `<scene_start>\n${ctx.startMessage.content}\n</scene_start>` : '',
      `<summary_so_far>\n${ctx.memory?.content || '(nothing yet)'}\n</summary_so_far>`,
      `<next_part>\n${transcript}\n</next_part>`,
    ]
      .filter(Boolean)
      .join('\n\n');
    let content = '';
    // Free endpoints and reasoning models sometimes return nothing; one more try is cheap.
    for (let attempt = 0; attempt < 2 && !content; attempt++) {
      content = (
        await this.completeFn(
          profileFor(this.db, 'summary'),
          [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          { minTokens: 1200 },
        )
      ).trim();
    }
    if (!content) throw new Error('The summary came back empty');

    const last = section.at(-1);
    if (!last) return;
    const timestamp = now();
    this.db
      .insert(memoryNodes)
      .values({
        id: newId(),
        sceneId: ctx.scene.id,
        messageId: last.id,
        content,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
  }
}

/**
 * The oldest history messages to fold into the summary: enough to bring history down to the
 * target, never the last three turns.
 */
export function pickSection(ctx: Pick<TurnContext, 'history' | 'historyTokens' | 'remaining'>) {
  const candidates = ctx.history.slice(0, verbatimStart(ctx.history));
  const target = ctx.remaining * TARGET_SHARE;
  const section: PathMessage[] = [];
  let left = ctx.historyTokens;
  for (const message of candidates) {
    if (left <= target) break;
    section.push(message);
    left -= countMessageTokens([message]);
  }
  return section;
}
