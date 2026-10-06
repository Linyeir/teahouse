import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type CanonProposal, markupToText } from '@teahouse/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { contextWindow, countTokens } from '../context/tokens.ts';
import { memoryOnPath } from '../context/turn.ts';
import type { Db } from '../db/index.ts';
import { canonProposals, chats, type ProposalFile, scenes } from '../db/schema.ts';
import type { Hub } from '../hub.ts';
import { type ChatMessage, complete } from '../llm/client.ts';
import { completeJson } from '../llm/json.ts';
import { profileFor } from '../roles.ts';
import { getSettings } from '../settings.ts';
import { newId, now } from '../time.ts';
import { activePath, type getChatRow } from '../tree.ts';
import { stringifyDocument } from '../worlds/frontmatter.ts';
import { canonFilePath } from '../worlds/paths.ts';
import { slug, type WorldService } from '../worlds/service.ts';
import { mergeThreeWay } from './merge.ts';
import { applyOps, canonUpdate } from './ops.ts';

const CANON_PROMPT = `You maintain the canon of a roleplay world: Markdown files that hold lasting world knowledge.
A scene has just ended. Record what happened and update the canon so later scenes stay consistent.

Return one JSON object:
{
  "event": { "title": "...", "summary": "1-3 sentences", "body": "Markdown account of the scene", "tags": ["..."] },
  "operations": [ ... ]
}

Allowed operations (paths are relative to the world, e.g. "characters/mira.md"):
- {"op":"append_section","path","heading","text"}: add text under a heading (created if missing)
- {"op":"replace_section","path","heading","text"}: replace the text under a heading
- {"op":"set_summary","path","text"}: replace a file's 1-3 sentence summary
- {"op":"add_alias","path","alias"} / {"op":"add_tag","path","tag"}
- {"op":"create","path","name","summary","tags","body"}: a new file in characters/, places/ or lore/

Rules:
- Only record lasting facts: relationships, injuries, decisions, promises, possessions, places, new characters, what someone learned.
- Never remove or contradict existing canon unless the scene clearly changed it; then use replace_section.
- Prefer small changes to existing files over new files. Create files only for people, places or things that will matter again.
- Write the event body and all text in {{language}}. Refer to the user's persona as {{user}}.
- Return only the JSON object.`;

const SECTION_BUDGET_SHARE = 0.5;

export class ProposalError extends Error {}

export interface ProposalDeps {
  db: Db;
  worlds: WorldService;
  hub: Hub;
  complete?: typeof complete;
}

export class CanonProposals {
  readonly #running = new Map<string, Promise<void>>();
  readonly #complete: typeof complete;

  constructor(private readonly deps: ProposalDeps) {
    this.#complete = deps.complete ?? complete;
  }

  get(sceneId: string): CanonProposal | null {
    const row = this.#row(sceneId);
    return row
      ? { id: row.id, sceneId: row.sceneId, status: row.status, error: row.error, files: row.files }
      : null;
  }

  /** Starts generating a proposal for a closing scene in the background. */
  start(sceneId: string): void {
    if (this.#running.has(sceneId)) return;
    const timestamp = now();
    const existing = this.#row(sceneId);
    if (existing) {
      this.deps.db
        .update(canonProposals)
        .set({
          status: 'generating',
          error: null,
          files: [],
          updatedAt: timestamp,
          revision: existing.revision + 1,
        })
        .where(eq(canonProposals.id, existing.id))
        .run();
    } else {
      this.deps.db
        .insert(canonProposals)
        .values({
          id: newId(),
          sceneId,
          status: 'generating',
          files: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
    }
    this.#changed(sceneId);
    const run = this.#generate(sceneId)
      .catch((err) =>
        this.#update(sceneId, {
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        }),
      )
      .finally(() => this.#running.delete(sceneId));
    this.#running.set(sceneId, run);
  }

  async idle(): Promise<void> {
    await Promise.allSettled(this.#running.values());
  }

  /** Records the user's decision (and optional edit) for one file. */
  decide(
    sceneId: string,
    path: string,
    decision: ProposalFile['decision'],
    after?: string,
  ): CanonProposal {
    const row = this.#row(sceneId);
    if (row?.status !== 'ready') throw new ProposalError('No proposal to review');
    const file = row.files.find((f) => f.path === path);
    if (!file) throw new ProposalError(`${path} is not part of the proposal`);
    file.decision = decision;
    if (after !== undefined) file.after = after;
    this.#update(sceneId, { files: row.files });
    return this.get(sceneId) as CanonProposal;
  }

  /**
   * Writes the accepted files in one commit and closes the scene. Files changed since the
   * proposal are merged three-way; conflicts are put back into the proposal for review.
   */
  async apply(sceneId: string): Promise<{ commit: string | null; conflicts: string[] }> {
    const row = this.#row(sceneId);
    if (row?.status !== 'ready') throw new ProposalError('No proposal to apply');
    const { scene, chat } = this.#sceneAndChat(sceneId);
    const accepted = row.files.filter((f) => f.decision === 'accepted');

    const writes = new Map<string, string>();
    const conflicts: string[] = [];
    for (const file of accepted) {
      const current = await this.deps.worlds.readIfExists(chat.worldId, file.path);
      if (current === file.before || current === file.after) {
        writes.set(file.path, file.after);
        continue;
      }
      const merged =
        file.before === null || current === null
          ? { text: conflictText(current ?? '', file.after), conflicts: true }
          : await mergeThreeWay(current, file.before, file.after);
      if (merged.conflicts) {
        conflicts.push(file.path);
        file.before = current;
        file.after = merged.text;
        file.decision = 'pending';
      } else {
        writes.set(file.path, merged.text);
      }
    }
    if (conflicts.length > 0) {
      this.#update(sceneId, { files: row.files });
      return { commit: null, conflicts };
    }

    const message = `Canon: ${chat.title}, scene ${scene.number}\n\nChat: ${chat.id}\nScene: ${scene.id}`;
    const commit =
      writes.size === 0
        ? null
        : await this.deps.worlds.transaction(chat.worldId, message, async (dir) => {
            for (const [path, content] of writes) {
              const full = canonFilePath(dir, path);
              await mkdir(dirname(full), { recursive: true });
              await writeFile(full, content);
            }
          });

    const timestamp = now();
    this.deps.db
      .update(scenes)
      .set({
        status: 'closed',
        canonCommit: commit,
        updatedAt: timestamp,
        revision: scene.revision + 1,
      })
      .where(eq(scenes.id, scene.id))
      .run();
    this.#update(sceneId, { status: 'applied' });
    this.deps.hub.broadcast({ type: 'chat.changed', chatId: chat.id });
    return { commit, conflicts: [] };
  }

  async #generate(sceneId: string): Promise<void> {
    const { db, worlds } = this.deps;
    const { scene, chat } = this.#sceneAndChat(sceneId);
    const settings = getSettings(db);
    const profile = profileFor(db, 'canon');

    // What the canon looks like now: an index of all files, full text of the core files.
    const files = await worlds.files(chat.worldId);
    const corePaths = ['world.md', 'user.md', ...scene.cast.map((c) => `characters/${c}.md`)];
    const index = files.map(
      (f) => `- ${f.path} (${f.type ?? 'file'}): ${f.name}${f.summary ? ` – ${f.summary}` : ''}`,
    );
    const core: string[] = [];
    for (const path of corePaths) {
      const text = await worlds.readIfExists(chat.worldId, path);
      if (text !== null) core.push(`<file path="${path}">\n${text.trim()}\n</file>`);
    }

    const transcript = this.#transcript(
      scene,
      chat,
      Math.floor(contextWindow(profile) * SECTION_BUDGET_SHARE),
    );
    const system = CANON_PROMPT.replaceAll('{{language}}', settings.outputLanguage).replaceAll(
      '{{user}}',
      settings.userName,
    );
    const user = [
      `<canon_index>\n${index.join('\n')}\n</canon_index>`,
      `<core_files>\n${core.join('\n\n')}\n</core_files>`,
      `<scene number="${scene.number}">\n${transcript}\n</scene>`,
    ].join('\n\n');

    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
    const update = await completeJson(this.#complete, profile, messages, canonUpdate, {
      name: 'canon_update',
      minTokens: 4000,
    });

    const world = await worlds.get(chat.worldId);
    const eventPath = await worlds.uniquePath(
      worlds.dir(world.folder),
      'events',
      `${slug(chat.title, 'chat')}-scene-${scene.number}`,
    );
    const eventFile = stringifyDocument({
      data: {
        type: 'event',
        name: update.event.title,
        tags: update.event.tags,
        aliases: [],
        summary: update.event.summary,
        chat: chat.id,
        scene: scene.id,
        order: scene.number,
      },
      body: update.event.body.trim().startsWith('#')
        ? update.event.body
        : `# ${update.event.title}\n\n${update.event.body}`,
    });

    const current = new Map<string, string>();
    for (const op of update.operations) {
      const text = await worlds.readIfExists(chat.worldId, op.path).catch(() => null);
      if (text !== null) current.set(op.path, text);
    }
    const applied = applyOps(
      current,
      update.operations.filter((op) => !op.path.startsWith('events/')),
    );

    const proposalFiles: ProposalFile[] = [
      { path: eventPath, before: null, after: eventFile, decision: 'pending' },
      ...[...applied.files].map(([path, after]) => ({
        path,
        before: current.get(path) ?? null,
        after,
        decision: 'pending' as const,
      })),
    ];
    const baseCommit = (await worlds.history(chat.worldId))[0]?.sha ?? null;
    this.#update(sceneId, { status: 'ready', files: proposalFiles, baseCommit, error: null });

    if (!settings.canonReview) {
      for (const file of proposalFiles) file.decision = 'accepted';
      this.#update(sceneId, { files: proposalFiles });
      await this.apply(sceneId);
    }
  }

  /** The closed path of the scene, condensed with its memory summary if it is too long. */
  #transcript(
    scene: typeof scenes.$inferSelect,
    chat: NonNullable<ReturnType<typeof getChatRow>>,
    budget: number,
  ) {
    const { db } = this.deps;
    const settings = getSettings(db);
    const path = scene.closedLeafId ? activePath(db, chat.id, scene.closedLeafId) : [];
    const line = (m: { role: string; content: string }) =>
      m.role === 'user' ? `${settings.userName}: ${m.content}` : markupToText(m.content);
    const full = path.map(line).join('\n\n');
    if (countTokens(full) <= budget) return full;

    const memory = memoryOnPath(db, scene.id, path).at(-1);
    const after = memory ? path.slice(path.findIndex((m) => m.id === memory.messageId) + 1) : path;
    const lines = after.map(line);
    while (lines.length > 1 && countTokens(lines.join('\n\n')) > budget * 0.7) lines.shift();
    return [memory ? `Summary of the earlier part: ${memory.content}` : '', ...lines]
      .filter(Boolean)
      .join('\n\n');
  }

  #sceneAndChat(sceneId: string) {
    const scene = this.deps.db.select().from(scenes).where(eq(scenes.id, sceneId)).get();
    const chat = scene
      ? this.deps.db.select().from(chats).where(eq(chats.id, scene.chatId)).get()
      : undefined;
    if (!scene || !chat) throw new ProposalError('Scene not found');
    return { scene, chat };
  }

  #row(sceneId: string) {
    return this.deps.db
      .select()
      .from(canonProposals)
      .where(and(eq(canonProposals.sceneId, sceneId), isNull(canonProposals.deletedAt)))
      .orderBy(desc(canonProposals.createdAt))
      .get();
  }

  #update(sceneId: string, patch: Partial<typeof canonProposals.$inferInsert>): void {
    const row = this.#row(sceneId);
    if (!row) return;
    this.deps.db
      .update(canonProposals)
      .set({ ...patch, updatedAt: now(), revision: row.revision + 1 })
      .where(eq(canonProposals.id, row.id))
      .run();
    this.#changed(sceneId);
  }

  #changed(sceneId: string): void {
    const scene = this.deps.db.select().from(scenes).where(eq(scenes.id, sceneId)).get();
    if (scene) this.deps.hub.broadcast({ type: 'proposal.changed', chatId: scene.chatId, sceneId });
  }
}

/** Conflict markers for a file that appeared or vanished since the proposal. */
function conflictText(current: string, proposal: string): string {
  return `<<<<<<< current\n${current}=======\n${proposal}>>>>>>> proposal\n`;
}
