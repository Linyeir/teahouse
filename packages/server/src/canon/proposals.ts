import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type CanonFile,
  type CanonProposal,
  markupToText,
  NARRATOR_SPEAKER,
} from '@teahouse/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { mentions } from '../context/canon.ts';
import { contextWindow, countTokens } from '../context/tokens.ts';
import { memoryOnPath } from '../context/turn.ts';
import type { Db } from '../db/index.ts';
import { canonProposals, chats, type ProposalFile, scenes } from '../db/schema.ts';
import type { GenerationLog } from '../generation.ts';
import type { Hub } from '../hub.ts';
import { type ChatMessage, complete, completeWithTools } from '../llm/client.ts';
import { completeJson } from '../llm/json.ts';
import { INTERRUPTED } from '../recover.ts';
import { profileFor } from '../roles.ts';
import { getSettings } from '../settings.ts';
import { newId, now } from '../time.ts';
import { activePath, type getChatRow } from '../tree.ts';
import { stringifyDocument } from '../worlds/frontmatter.ts';
import { canonFilePath } from '../worlds/paths.ts';
import { slug, type WorldService } from '../worlds/service.ts';
import { lookUp, type ToolsFn } from './lookup.ts';
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
- <core_files> shows files in full, or by their summary where it says summary="true". A file you only know from <canon_index> or by its summary may hold more than you see: change it only with append_section, add_alias or add_tag.
- When the scene calls an existing character, place or thing by another name, nickname or title than its name and aliases in <canon_index>, add that name with add_alias, so later scenes find the file by it.
- Write the event body and all text in {{language}}. Refer to the user's persona as {{user}}.
- Return only the JSON object.`;

const SECTION_BUDGET_SHARE = 0.5;

/** Lower bound for the answer, as passed to `completeJson`. */
const ANSWER_TOKENS = 4000;

export class ProposalError extends Error {}

export interface ProposalDeps {
  db: Db;
  worlds: WorldService;
  hub: Hub;
  complete?: typeof complete;
  /**
   * Tool calls for looking things up before the proposal; null skips the lookups. Defaults
   * to the real endpoint, unless `complete` is replaced (tests) and this is not.
   */
  tools?: ToolsFn | null;
  log?: GenerationLog;
}

interface Run {
  controller: AbortController;
  done: Promise<void>;
}

export class CanonProposals {
  readonly #running = new Map<string, Run>();
  readonly #complete: typeof complete;

  readonly #tools: ToolsFn | null;

  constructor(private readonly deps: ProposalDeps) {
    this.#complete = deps.complete ?? complete;
    this.#tools = deps.tools !== undefined ? deps.tools : deps.complete ? null : completeWithTools;
  }

  get(sceneId: string): CanonProposal | null {
    const row = this.#row(sceneId);
    return row
      ? { id: row.id, sceneId: row.sceneId, status: row.status, error: row.error, files: row.files }
      : null;
  }

  /**
   * Starts generating a proposal for a closing scene in the background. One still being
   * generated (perhaps on an LLM call that never returns) is abandoned for the new one.
   */
  start(sceneId: string): void {
    this.#running.get(sceneId)?.controller.abort();
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
    const run: Run = { controller: new AbortController(), done: Promise.resolve() };
    // An abandoned run must not overwrite the proposal of the one that replaced it.
    const current = () => this.#running.get(sceneId) === run;
    this.#running.set(sceneId, run);
    run.done = this.#generate(sceneId, run.controller.signal)
      .catch((err) => {
        if (!current()) return;
        this.#update(sceneId, {
          status: 'failed',
          error: run.controller.signal.aborted
            ? INTERRUPTED
            : err instanceof Error
              ? err.message
              : String(err),
        });
      })
      .finally(() => {
        if (current()) this.#running.delete(sceneId);
      });
  }

  async idle(): Promise<void> {
    await Promise.allSettled([...this.#running.values()].map((run) => run.done));
  }

  /** Stops every generation, marks its proposal failed and waits until that is saved. */
  async stopAll(): Promise<void> {
    for (const run of this.#running.values()) run.controller.abort();
    await this.idle();
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

  async #generate(sceneId: string, signal: AbortSignal): Promise<void> {
    const { db, worlds } = this.deps;
    const { scene, chat } = this.#sceneAndChat(sceneId);
    const settings = getSettings(db);
    const profile = profileFor(db, 'canon');

    // What the canon looks like now: an index of all files, full text of the core files.
    const files = await worlds.files(chat.worldId);
    // The cast, and whoever joined the scene with a turn of their own.
    const path = scene.closedLeafId ? activePath(db, chat.id, scene.closedLeafId) : [];
    const speakers = path.flatMap((m) =>
      m.speaker && m.speaker !== NARRATOR_SPEAKER ? [m.speaker] : [],
    );
    const characters = [...new Set([...scene.cast, ...speakers])];
    const corePaths = ['world.md', 'user.md', ...characters.map((c) => `characters/${c}.md`)];
    const index = files.map((f) => {
      const aliases = f.aliases.length ? ` (aliases: ${f.aliases.join(', ')})` : '';
      return `- ${f.path} (${f.type ?? 'file'}): ${f.name}${aliases}${f.summary ? ` – ${f.summary}` : ''}`;
    });
    const core: string[] = [];
    for (const path of corePaths) {
      const text = await worlds.readIfExists(chat.worldId, path);
      if (text !== null) core.push(`<file path="${path}">\n${text.trim()}\n</file>`);
    }

    const window = contextWindow(profile);
    const transcript = this.#transcript(scene, chat, Math.floor(window * SECTION_BUDGET_SHARE));
    const system = CANON_PROMPT.replaceAll('{{language}}', settings.outputLanguage).replaceAll(
      '{{user}}',
      settings.userName,
    );

    // Files the scene mentions, in whatever room is left, so the canon role sees what it edits.
    const used = [system, ...index, ...core, transcript].reduce((n, t) => n + countTokens(t), 0);
    const room = window - used - Math.max(profile.maxTokens ?? 0, ANSWER_TOKENS);
    const touched = files.filter(
      (f) => !corePaths.includes(f.path) && !isEvent(f) && mentionedIn(transcript, f) !== null,
    );
    touched.sort(
      (a, b) =>
        (mentionedIn(transcript, a) ?? 0) - (mentionedIn(transcript, b) ?? 0) ||
        a.path.localeCompare(b.path),
    );
    const texts = new Map<string, string>();
    for (const f of touched) texts.set(f.path, (await worlds.read(chat.worldId, f.path)).trim());
    const fitted = fitFiles(touched, texts, room);

    const prompt = (extra: Map<string, string>): ChatMessage[] => {
      const files = [
        ...core,
        // A file looked up in full replaces its summary.
        ...fitted.filter((f) => !extra.has(f.path)).map((f) => f.text),
        ...[...extra].map(([path, text]) => `<file path="${path}">\n${text}\n</file>`),
      ];
      const user = [
        `<canon_index>\n${index.join('\n')}\n</canon_index>`,
        `<core_files>\n${files.join('\n\n')}\n</core_files>`,
        `<scene number="${scene.number}">\n${transcript}\n</scene>`,
      ].join('\n\n');
      return [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ];
    };

    // Where the endpoint supports tools, the canon role reads what it still needs first.
    let looked = new Map<string, string>();
    if (this.#tools) {
      const lookup = await lookUp({
        toolsFn: this.#tools,
        profile,
        messages: prompt(looked),
        worlds,
        worldId: chat.worldId,
        known: new Set([...corePaths, ...fitted.filter((f) => f.full).map((f) => f.path)]),
        budget: room - fitted.reduce((n, f) => n + countTokens(f.text), 0),
        signal,
      });
      looked = lookup.files;
      this.deps.log?.info(
        {
          sceneId,
          calls: lookup.calls,
          read: [...lookup.files.keys()],
          ...(lookup.error && { error: lookup.error }),
        },
        'Canon lookups',
      );
    }
    signal.throwIfAborted();
    const messages = prompt(looked);
    const update = await completeJson(this.#complete, profile, messages, canonUpdate, {
      name: 'canon_update',
      minTokens: ANSWER_TOKENS,
      signal,
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
    signal.throwIfAborted();
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

const isEvent = (f: CanonFile) => f.type === 'event' || f.path.startsWith('events/');

/** How the scene refers to a file: 0 by name or alias, 1 only by a tag, null not at all. */
function mentionedIn(text: string, file: CanonFile): 0 | 1 | null {
  if (mentions(text, [file.name, ...file.aliases])) return 0;
  if (mentions(text, file.tags)) return 1;
  return null;
}

/**
 * Renders files for `<core_files>` within `budget` tokens, most relevant first: each in full
 * while it fits, else by its summary, else not at all.
 */
export function fitFiles(
  files: CanonFile[],
  texts: Map<string, string>,
  budget: number,
): { path: string; full: boolean; text: string }[] {
  const out: { path: string; full: boolean; text: string }[] = [];
  let left = budget;
  for (const file of files) {
    const full = `<file path="${file.path}">\n${texts.get(file.path) ?? ''}\n</file>`;
    const short = file.summary
      ? `<file path="${file.path}" summary="true">\n${file.summary}\n</file>`
      : null;
    for (const text of [full, short]) {
      if (text === null) continue;
      const tokens = countTokens(text);
      if (tokens > left) continue;
      out.push({ path: file.path, full: text === full, text });
      left -= tokens;
      break;
    }
  }
  return out;
}
