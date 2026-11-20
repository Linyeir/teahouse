import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type CanonFile,
  type CanonProposal,
  markupToText,
  NARRATOR_SPEAKER,
  type ProposalChange,
  type ProposalNote,
} from '@teahouse/shared';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { mentions } from '../context/canon.ts';
import { contextWindow, countTokens } from '../context/tokens.ts';
import { memoryOnPath } from '../context/turn.ts';
import type { Db } from '../db/index.ts';
import { canonProposals, chats, messages, type ProposalFile, scenes } from '../db/schema.ts';
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
import {
  type ApplyResult,
  applyOps,
  type CanonOp,
  canonUpdate,
  cleanupUpdate,
  hasConflictMarkers,
  normalizePath,
  type OpNote,
} from './ops.ts';

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

const CLEANUP_PROMPT = `You maintain the canon of a roleplay world: Markdown files that hold lasting world knowledge.
Go over the whole canon and propose fixes. Nothing happened in play; you only tidy what is there.

Look for:
1. Summaries that no longer match their file's body: refresh them with set_summary.
2. Contradictions between files: two files that state facts that cannot both be true. Fix the file that is more likely wrong with fix_contradiction and quote, word for word, what the other file says. Events in events/ record what happened in play: they are right, and they are never changed.
3. Names of people, places or things that recur in several events but have no file: create one in characters/, places/ or lore/ from what the events say.
4. Files that events refer to by another name, nickname or title than their name and aliases: add_alias; and fitting tags: add_tag.
5. Duplicates: two files about the same person, place or thing. Merge them with merge: "path" is the file to keep, "from" the duplicate, which is then deleted. Its name, aliases, tags and text are carried over by code; do not copy them yourself.

Return one JSON object:
{ "operations": [ ... ] }

Allowed operations (paths are relative to the world, e.g. "characters/mira.md"):
- {"op":"set_summary","path","text"}: replace a file's 1-3 sentence summary
- {"op":"fix_contradiction","path","heading","text","other","other_quote"}: replace the text under a heading of "path" so it agrees with "other", which says "other_quote"
- {"op":"create","path","name","summary","tags","body"}: a new file in characters/, places/ or lore/
- {"op":"add_alias","path","alias"} / {"op":"add_tag","path","tag"}
- {"op":"merge","path","from"}: fold the duplicate "from" into "path" (same folder only)
- {"op":"append_section","path","heading","text"} / {"op":"replace_section","path","heading","text"}

Rules:
- Propose only what the files clearly support. Fewer, sure fixes are better than many guesses. If nothing needs fixing, return {"operations": []}.
- Never change world.md, user.md or anything in events/.
- <files> shows files in full, or by their summary where it says summary="true". Change a file you only know from <canon_index> or by its summary only with append_section, add_alias, add_tag or merge.
- Write all text in {{language}}. Refer to the user's persona as {{user}}.
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

/** Whose proposal: the one of a closing scene, or the cleanup run of a world. */
type Owner = { kind: 'scene'; sceneId: string } | { kind: 'cleanup'; worldId: string };

const sceneOwner = (sceneId: string): Owner => ({ kind: 'scene', sceneId });
const cleanupOwner = (worldId: string): Owner => ({ kind: 'cleanup', worldId });
const ownerKey = (owner: Owner) =>
  owner.kind === 'scene' ? owner.sceneId : `cleanup:${owner.worldId}`;

type ProposalRow = typeof canonProposals.$inferSelect;

export class CanonProposals {
  readonly #running = new Map<string, Run>();
  readonly #complete: typeof complete;

  readonly #tools: ToolsFn | null;

  constructor(private readonly deps: ProposalDeps) {
    this.#complete = deps.complete ?? complete;
    this.#tools = deps.tools !== undefined ? deps.tools : deps.complete ? null : completeWithTools;
  }

  /** The proposal of a scene. */
  get(sceneId: string): CanonProposal | null {
    return this.#view(this.#row(sceneOwner(sceneId)));
  }

  /** The world's latest cleanup proposal, applied or not. */
  cleanup(worldId: string): CanonProposal | null {
    return this.#view(this.#row(cleanupOwner(worldId)));
  }

  #view(row: ProposalRow | undefined): CanonProposal | null {
    return row
      ? {
          id: row.id,
          worldId: row.worldId,
          kind: row.kind,
          sceneId: row.sceneId,
          status: row.status,
          error: row.error,
          files: row.files.map((f) => ({ ...f, changes: f.changes ?? [] })),
          notes: row.notes,
        }
      : null;
  }

  /**
   * Starts generating a proposal for a closing scene in the background. One still being
   * generated (perhaps on an LLM call that never returns) is abandoned for the new one.
   */
  start(sceneId: string): void {
    const { chat } = this.#sceneAndChat(sceneId);
    this.#start(sceneOwner(sceneId), chat.worldId, (signal) => this.#generate(sceneId, signal));
  }

  /**
   * Starts a cleanup run over the whole world. It never blocks a scene, and its proposal
   * always waits for review, whatever the `canonReview` setting says.
   */
  startCleanup(worldId: string): void {
    this.#start(cleanupOwner(worldId), worldId, (signal) => this.#generateCleanup(worldId, signal));
  }

  #start(owner: Owner, worldId: string, generate: (signal: AbortSignal) => Promise<void>) {
    const key = ownerKey(owner);
    this.#running.get(key)?.controller.abort();
    const timestamp = now();
    const existing = this.#row(owner);
    // An applied cleanup stays as a record; the next run gets a proposal of its own.
    if (existing && !(owner.kind === 'cleanup' && existing.status === 'applied')) {
      this.deps.db
        .update(canonProposals)
        .set({
          status: 'generating',
          error: null,
          files: [],
          notes: [],
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
          worldId,
          kind: owner.kind,
          sceneId: owner.kind === 'scene' ? owner.sceneId : null,
          status: 'generating',
          files: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
    }
    this.#changed(owner);
    const run: Run = { controller: new AbortController(), done: Promise.resolve() };
    // An abandoned run must not overwrite the proposal of the one that replaced it.
    const current = () => this.#running.get(key) === run;
    this.#running.set(key, run);
    run.done = generate(run.controller.signal)
      .catch((err) => {
        if (!current()) return;
        this.#update(owner, {
          status: 'failed',
          error: run.controller.signal.aborted
            ? INTERRUPTED
            : err instanceof Error
              ? err.message
              : String(err),
        });
      })
      .finally(() => {
        if (current()) this.#running.delete(key);
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

  /** Records the user's decision (and optional edit) for one file of a scene's proposal. */
  decide(
    sceneId: string,
    path: string,
    decision: ProposalFile['decision'],
    after?: string,
  ): CanonProposal {
    this.#decide(sceneOwner(sceneId), path, decision, after);
    return this.get(sceneId) as CanonProposal;
  }

  /** Records the user's decision (and optional edit) for one file of a cleanup proposal. */
  decideCleanup(
    worldId: string,
    path: string,
    decision: ProposalFile['decision'],
    after?: string,
  ): CanonProposal {
    this.#decide(cleanupOwner(worldId), path, decision, after);
    return this.cleanup(worldId) as CanonProposal;
  }

  #decide(owner: Owner, path: string, decision: ProposalFile['decision'], after?: string) {
    const row = this.#row(owner);
    if (row?.status !== 'ready') throw new ProposalError('No proposal to review');
    const file = row.files.find((f) => f.path === path);
    if (!file) throw new ProposalError(`${path} is not part of the proposal`);
    if (after !== undefined && file.after === null) {
      throw new ProposalError(`${path} is merged into another file and cannot be edited`);
    }
    const text = after ?? file.after;
    if (decision === 'accepted' && text !== null && hasConflictMarkers(text)) {
      throw new ProposalError(`${path} still has conflict markers; resolve them first`);
    }
    file.decision = decision;
    if (after !== undefined) file.after = after;
    this.#update(owner, { files: row.files });
  }

  /**
   * Writes the accepted files in one commit and closes the scene. Files changed since the
   * proposal are merged three-way; conflicts are put back into the proposal for review.
   */
  async apply(sceneId: string): Promise<{ commit: string | null; conflicts: string[] }> {
    const owner = sceneOwner(sceneId);
    const row = this.#row(owner);
    if (row?.status !== 'ready') throw new ProposalError('No proposal to apply');
    const { scene, chat } = this.#sceneAndChat(sceneId);
    const message = `Canon: ${chat.title}, scene ${scene.number}\n\nChat: ${chat.id}\nScene: ${scene.id}`;
    const result = await this.#write(owner, row, chat.worldId, message);
    if (result.conflicts.length > 0) return result;

    const timestamp = now();
    this.deps.db
      .update(scenes)
      .set({
        status: 'closed',
        canonCommit: result.commit,
        updatedAt: timestamp,
        revision: scene.revision + 1,
      })
      .where(eq(scenes.id, scene.id))
      .run();
    this.#update(owner, { status: 'applied' });
    this.deps.hub.broadcast({ type: 'chat.changed', chatId: chat.id });
    return result;
  }

  /**
   * Writes the accepted files of the world's cleanup in one commit, like `apply`, but leaves
   * every scene as it is. A character merged into another keeps its chats: they move over.
   */
  async applyCleanup(worldId: string): Promise<{ commit: string | null; conflicts: string[] }> {
    const owner = cleanupOwner(worldId);
    const row = this.#row(owner);
    if (row?.status !== 'ready') throw new ProposalError('No proposal to apply');
    const result = await this.#write(owner, row, worldId, `Canon cleanup\n\nProposal: ${row.id}`);
    if (result.conflicts.length > 0) return result;
    this.#redirectCharacters(worldId, mergedCharacters(row.files));
    this.#update(owner, { status: 'applied' });
    return result;
  }

  /** Commits the accepted files of `row`; on conflicts, nothing is written. */
  async #write(
    owner: Owner,
    row: ProposalRow,
    worldId: string,
    message: string,
  ): Promise<{ commit: string | null; conflicts: string[] }> {
    const accepted = row.files.filter((f) => f.decision === 'accepted');
    // A merged file goes only together with the file that takes in its content.
    for (const file of accepted) {
      if (file.after !== null) continue;
      const into = file.changes?.find((c) => c.op === 'merged_into')?.detail;
      const target = row.files.find((f) => f.path === into);
      if (target && target.decision !== 'accepted') {
        throw new ProposalError(
          `${file.path} is merged into ${target.path}: accept both, or reject the merged file`,
        );
      }
    }
    const writes = new Map<string, string | null>();
    const conflicts: string[] = [];
    for (const file of accepted) {
      const current = await this.deps.worlds.readIfExists(worldId, file.path);
      if (file.after === null) {
        // A merged file is deleted only as the proposal saw it: anything newer is kept.
        if (current === null || current === file.before) {
          writes.set(file.path, null);
        } else {
          conflicts.push(file.path);
          file.before = current;
          file.decision = 'pending';
        }
        continue;
      }
      // Text with conflict markers never goes into the canon, however it got accepted.
      if (hasConflictMarkers(file.after)) {
        conflicts.push(file.path);
        file.decision = 'pending';
        continue;
      }
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
      this.#update(owner, { files: row.files });
      return { commit: null, conflicts };
    }
    const commit =
      writes.size === 0
        ? null
        : await this.deps.worlds.transaction(worldId, message, async (dir) => {
            for (const [path, content] of writes) {
              const full = canonFilePath(dir, path);
              if (content === null) {
                await rm(full, { force: true });
                continue;
              }
              await mkdir(dirname(full), { recursive: true });
              await writeFile(full, content);
            }
          });
    return { commit, conflicts: [] };
  }

  /**
   * Points everything that named a merged character at the one it was merged into: the
   * chats it opened, the cast of their scenes, the speaker of replies and `who=` in markup.
   */
  #redirectCharacters(worldId: string, moved: Map<string, string>): void {
    if (moved.size === 0) return;
    const { db, hub } = this.deps;
    const to = (slug: string) => moved.get(slug) ?? slug;
    const who = new RegExp(
      `(\\bwho\\s*=\\s*["'])(${[...moved.keys()].map(escapeRegExp).join('|')})(["'])`,
      'gi',
    );
    const timestamp = now();
    const touched = new Set<string>();
    const chatRows = db.select().from(chats).where(eq(chats.worldId, worldId)).all();
    db.transaction((tx) => {
      for (const chat of chatRows) {
        if (moved.has(chat.characterSlug)) {
          tx.update(chats)
            .set({
              characterSlug: to(chat.characterSlug),
              updatedAt: timestamp,
              revision: chat.revision + 1,
            })
            .where(eq(chats.id, chat.id))
            .run();
          touched.add(chat.id);
        }
        for (const scene of tx.select().from(scenes).where(eq(scenes.chatId, chat.id)).all()) {
          if (!scene.cast.some((c) => moved.has(c))) continue;
          tx.update(scenes)
            .set({
              cast: [...new Set(scene.cast.map(to))],
              updatedAt: timestamp,
              revision: scene.revision + 1,
            })
            .where(eq(scenes.id, scene.id))
            .run();
          touched.add(chat.id);
        }
        for (const message of tx
          .select()
          .from(messages)
          .where(eq(messages.chatId, chat.id))
          .all()) {
          const speaker = message.speaker && to(message.speaker);
          const content = message.content.replace(who, (_m, a, slug: string, b) => {
            return `${a}${moved.get(slug.toLowerCase()) ?? slug}${b}`;
          });
          if (speaker === message.speaker && content === message.content) continue;
          tx.update(messages)
            .set({ speaker, content, updatedAt: timestamp, revision: message.revision + 1 })
            .where(eq(messages.id, message.id))
            .run();
          touched.add(chat.id);
        }
      }
    });
    for (const chatId of touched) hub.broadcast({ type: 'chat.changed', chatId });
  }

  async #generateCleanup(worldId: string, signal: AbortSignal): Promise<void> {
    const { db, worlds } = this.deps;
    const owner = cleanupOwner(worldId);
    const settings = getSettings(db);
    const profile = profileFor(db, 'canon');
    const files = await worlds.files(worldId);
    const index = indexLines(files);
    const system = CLEANUP_PROMPT.replaceAll('{{language}}', settings.outputLanguage).replaceAll(
      '{{user}}',
      settings.userName,
    );

    // The canon files first, since they are what gets fixed, then the events that say what
    // happened in play. What does not fit in full goes by its summary, and the canon role
    // can still read it with the lookup tools.
    const window = contextWindow(profile);
    const used = [system, ...index].reduce((n, t) => n + countTokens(t), 0);
    const room = window - used - Math.max(profile.maxTokens ?? 0, ANSWER_TOKENS);
    const ordered = [...files.filter((f) => !isEvent(f)), ...files.filter(isEvent).reverse()];
    const texts = new Map<string, string>();
    for (const f of ordered) texts.set(f.path, (await worlds.read(worldId, f.path)).trim());
    const fitted = fitFiles(ordered, texts, room);

    const prompt = (extra: Map<string, string>): ChatMessage[] => {
      const shown = [
        ...fitted.filter((f) => !extra.has(f.path)).map((f) => f.text),
        ...[...extra].map(([path, text]) => `<file path="${path}">\n${text}\n</file>`),
      ];
      return [
        { role: 'system', content: system },
        {
          role: 'user',
          content: `<canon_index>\n${index.join('\n')}\n</canon_index>\n\n<files>\n${shown.join('\n\n')}\n</files>`,
        },
      ];
    };

    let looked = new Map<string, string>();
    if (this.#tools) {
      const lookup = await lookUp({
        toolsFn: this.#tools,
        profile,
        messages: prompt(looked),
        worlds,
        worldId,
        known: new Set(fitted.filter((f) => f.full).map((f) => f.path)),
        budget: room - fitted.reduce((n, f) => n + countTokens(f.text), 0),
        signal,
      });
      looked = lookup.files;
      this.deps.log?.info(
        {
          worldId,
          calls: lookup.calls,
          read: [...lookup.files.keys()],
          ...(lookup.error && { error: lookup.error }),
        },
        'Canon cleanup lookups',
      );
    }
    signal.throwIfAborted();
    const update = await completeJson(this.#complete, profile, prompt(looked), cleanupUpdate, {
      name: 'canon_cleanup',
      minTokens: ANSWER_TOKENS,
      signal,
    });

    // Events are the record of play, world.md and user.md the owner's own: never touched.
    const operations = update.operations.filter((op) => {
      const path = normalizePath(op.path);
      return path !== null && !path.startsWith('events/') && path.includes('/');
    });
    const current = await this.#currentTexts(worldId, operations);
    const seen = new Set([...fitted.filter((f) => f.full).map((f) => f.path), ...looked.keys()]);
    const applied = applyOps(current, operations, seen);
    const proposalFiles = filesOf(operations, applied, current);
    const notes = [
      ...applied.notes.map(toNote),
      ...this.#overlapNotes(
        worldId,
        proposalFiles.map((f) => f.path),
      ),
    ];
    const baseCommit = (await worlds.history(worldId))[0]?.sha ?? null;
    signal.throwIfAborted();
    this.#update(owner, { status: 'ready', files: proposalFiles, notes, baseCommit, error: null });
  }

  /** The current text of every existing file the operations name. */
  async #currentTexts(worldId: string, operations: CanonOp[]): Promise<Map<string, string>> {
    const current = new Map<string, string>();
    const paths = operations.flatMap((op) => (op.op === 'merge' ? [op.path, op.from] : [op.path]));
    for (const raw of paths) {
      const path = normalizePath(raw);
      if (!path || current.has(path)) continue;
      const text = await this.deps.worlds.readIfExists(worldId, path).catch(() => null);
      if (text !== null) current.set(path, text);
    }
    return current;
  }

  /** Flags files that an open scene proposal changes too, so the review says which is which. */
  #overlapNotes(worldId: string, paths: string[]): ProposalNote[] {
    const { db } = this.deps;
    const open = db
      .select()
      .from(canonProposals)
      .where(
        and(
          eq(canonProposals.worldId, worldId),
          eq(canonProposals.kind, 'scene'),
          eq(canonProposals.status, 'ready'),
          isNull(canonProposals.deletedAt),
        ),
      )
      .all();
    const sceneIds = open.flatMap((p) => (p.sceneId ? [p.sceneId] : []));
    if (sceneIds.length === 0) return [];
    const sceneRows = db.select().from(scenes).where(inArray(scenes.id, sceneIds)).all();
    const notes: ProposalNote[] = [];
    for (const proposal of open) {
      const scene = sceneRows.find((s) => s.id === proposal.sceneId);
      const chat = scene && db.select().from(chats).where(eq(chats.id, scene.chatId)).get();
      if (!scene || !chat) continue;
      for (const file of proposal.files) {
        if (!paths.includes(file.path)) continue;
        notes.push({
          path: file.path,
          op: 'review',
          code: 'also_in_scene_proposal',
          outcome: 'flagged',
          reason: `the open canon changes of ${chat.title}, scene ${scene.number}, change this file too`,
          detail: `${chat.title} #${scene.number}`,
        });
      }
    }
    return notes;
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
    const index = indexLines(files);
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

    const current = await this.#currentTexts(chat.worldId, update.operations);
    // The files the model had in full; any other it may only extend (see applyOps).
    const seen = new Set([
      ...corePaths,
      ...fitted.filter((f) => f.full).map((f) => f.path),
      ...looked.keys(),
    ]);
    // An alias the scene never uses is likely made up: flagged for review, else left out.
    const aliasNotes: OpNote[] = [];
    const operations = update.operations.filter((op) => {
      if (op.path.startsWith('events/')) return false;
      if (op.op !== 'add_alias' || mentions(transcript, [op.alias])) return true;
      aliasNotes.push({
        op,
        code: 'alias_not_in_scene',
        outcome: settings.canonReview ? 'flagged' : 'skipped',
        reason: 'the scene never uses this name',
      });
      return settings.canonReview;
    });
    const applied = applyOps(current, operations, seen);
    const notes = [...aliasNotes, ...applied.notes].map(toNote);

    const proposalFiles: ProposalFile[] = [
      {
        path: eventPath,
        before: null,
        after: eventFile,
        decision: 'pending',
        changes: [{ op: 'event', detail: update.event.title }],
      },
      ...filesOf(operations, applied, current),
    ];
    const baseCommit = (await worlds.history(chat.worldId))[0]?.sha ?? null;
    signal.throwIfAborted();
    const owner = sceneOwner(sceneId);
    this.#update(owner, {
      status: 'ready',
      files: proposalFiles,
      notes,
      baseCommit,
      error: null,
    });

    if (!settings.canonReview) {
      for (const file of proposalFiles) file.decision = 'accepted';
      this.#update(owner, { files: proposalFiles });
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

  #row(owner: Owner) {
    const where =
      owner.kind === 'scene'
        ? eq(canonProposals.sceneId, owner.sceneId)
        : and(eq(canonProposals.worldId, owner.worldId), eq(canonProposals.kind, 'cleanup'));
    return this.deps.db
      .select()
      .from(canonProposals)
      .where(and(where, isNull(canonProposals.deletedAt)))
      .orderBy(desc(canonProposals.createdAt))
      .get();
  }

  #update(owner: Owner, patch: Partial<typeof canonProposals.$inferInsert>): void {
    const row = this.#row(owner);
    if (!row) return;
    this.deps.db
      .update(canonProposals)
      .set({ ...patch, updatedAt: now(), revision: row.revision + 1 })
      .where(eq(canonProposals.id, row.id))
      .run();
    this.#changed(owner);
  }

  #changed(owner: Owner): void {
    if (owner.kind === 'cleanup') {
      this.deps.hub.broadcast({ type: 'cleanup.changed', worldId: owner.worldId });
      return;
    }
    const scene = this.deps.db.select().from(scenes).where(eq(scenes.id, owner.sceneId)).get();
    if (scene) {
      this.deps.hub.broadcast({
        type: 'proposal.changed',
        chatId: scene.chatId,
        sceneId: owner.sceneId,
      });
    }
  }
}

/** One line per file for `<canon_index>`: path, type, name, aliases and summary. */
function indexLines(files: CanonFile[]): string[] {
  return files.map((f) => {
    const aliases = f.aliases.length ? ` (aliases: ${f.aliases.join(', ')})` : '';
    return `- ${f.path} (${f.type ?? 'file'}): ${f.name}${aliases}${f.summary ? ` – ${f.summary}` : ''}`;
  });
}

/** The files of a proposal, each with what changes in it, from the operations that went through. */
function filesOf(
  operations: CanonOp[],
  applied: ApplyResult,
  current: Map<string, string>,
): ProposalFile[] {
  const skipped = new Set(applied.notes.filter((n) => n.outcome === 'skipped').map((n) => n.op));
  const downgraded = new Set(
    applied.notes.filter((n) => n.outcome === 'downgraded').map((n) => n.op),
  );
  const changesOf = (path: string) =>
    operations.flatMap((op): ProposalChange[] => {
      if (skipped.has(op)) return [];
      const target = normalizePath(op.path);
      if (op.op === 'merge') {
        const from = normalizePath(op.from);
        if (target === path) return [{ op: 'merge', detail: from }];
        if (from === path) return [{ op: 'merged_into', detail: target }];
        return [];
      }
      if (target !== path) return [];
      // A downgraded replace was applied as an addition, so the review says so.
      const change: ProposalChange = {
        op: downgraded.has(op) ? 'append_section' : op.op,
        detail: opDetail(op),
      };
      if (op.op === 'fix_contradiction') {
        change.contradicts = { path: normalizePath(op.other) ?? op.other, quote: op.other_quote };
      }
      return [change];
    });
  return [...applied.files].map(([path, after]) => ({
    path,
    before: current.get(path) ?? null,
    after,
    decision: 'pending' as const,
    changes: changesOf(path),
  }));
}

/** Slugs of accepted character files merged into another character, mapped to that one. */
export function mergedCharacters(files: ProposalFile[]): Map<string, string> {
  const slugOf = (path: string | null | undefined) =>
    (path && /^characters\/([^/]+)\.md$/.exec(path)?.[1]) || null;
  const moved = new Map<string, string>();
  for (const file of files) {
    if (file.decision !== 'accepted' || file.after !== null) continue;
    const from = slugOf(file.path);
    const to = slugOf(file.changes?.find((c) => c.op === 'merged_into')?.detail);
    if (from && to) moved.set(from, to);
  }
  // a → b and b → c: a ends up at c.
  for (const [from, to] of moved) {
    let end = to;
    const seen = new Set([from]);
    while (moved.has(end) && !seen.has(end)) {
      seen.add(end);
      end = moved.get(end) as string;
    }
    moved.set(from, end);
  }
  return moved;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** What an operation is about: a section heading, an alias or a tag. */
function opDetail(op: CanonOp): string | null {
  if (op.op === 'append_section' || op.op === 'replace_section') return op.heading;
  if (op.op === 'fix_contradiction') return op.heading;
  if (op.op === 'merge') return normalizePath(op.from);
  if (op.op === 'add_alias') return op.alias;
  if (op.op === 'add_tag') return op.tag;
  return null;
}

/** A note for the review: which operation, on which file, what happened and why. */
function toNote({ op, code, outcome, reason }: OpNote): ProposalNote {
  return {
    path: normalizePath(op.path) ?? op.path,
    op: op.op,
    code,
    outcome,
    reason,
    detail: opDetail(op),
  };
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
