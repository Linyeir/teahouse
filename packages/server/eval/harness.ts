import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import OpenAI from 'openai';
import { parse } from 'yaml';
import { z } from 'zod';
import { CanonProposals } from '../src/canon/proposals.ts';
import { CANON_BUDGET_SHARE, selectCanon } from '../src/context/canon.ts';
import { countTokens } from '../src/context/tokens.ts';
import { currentScene, memoryOnPath } from '../src/context/turn.ts';
import { openDb } from '../src/db/index.ts';
import { chats, messages, profiles } from '../src/db/schema.ts';
import { Generator } from '../src/generation.ts';
import { Hub } from '../src/hub.ts';
import { complete } from '../src/llm/client.ts';
import { Memory } from '../src/memory.ts';
import { Scenes } from '../src/scenes.ts';
import { getSettings, saveSettings } from '../src/settings.ts';
import { newId, now } from '../src/time.ts';
import { activePath } from '../src/tree.ts';
import { stringifyDocument } from '../src/worlds/frontmatter.ts';
import { WorldService } from '../src/worlds/service.ts';

export const scenarioSchema = z.object({
  name: z.string(),
  description: z.string().default(''),
  language: z.string().default('English'),
  user: z.string().default('User'),
  /** Small on purpose, so the scene does not fit and Active Memory has to summarize. */
  contextWindow: z.number().int().positive(),
  /**
   * Context window for the canon stage. The small window above only exists to force
   * summaries; the canon is checked with the budget of a realistic narrator model.
   */
  canonContextWindow: z.number().int().positive().default(8192),
  world: z.string(),
  characters: z
    .array(z.object({ slug: z.string(), name: z.string(), summary: z.string(), body: z.string() }))
    .min(1),
  start: z.string(),
  turns: z.array(z.object({ user: z.string(), assistant: z.string() })).min(1),
  facts: z.array(z.object({ question: z.string(), answer: z.array(z.string()).min(1) })).min(1),
});
export type Scenario = z.infer<typeof scenarioSchema>;

export interface EvalProfile {
  baseUrl: string;
  apiKey: string | null;
  model: string;
  temperature: number | null;
}

export interface FactResult {
  question: string;
  expected: string[];
  answer: string;
  pass: boolean;
}

export interface StageResult {
  /** The notes the questions were answered from. */
  notes: string;
  noteTokens: number;
  facts: FactResult[];
  score: number;
}

export interface ScenarioResult {
  scenario: string;
  model: string;
  contextWindow: number;
  /** Number of Active Memory summaries written during the scene. */
  summaries: number;
  /** Messages of the scene (without the start message) that the last summary covers. */
  summarizedMessages: number;
  totalMessages: number;
  memory: StageResult | null;
  canon: StageResult | null;
  canonFiles: string[];
  error: string | null;
  durationMs: number;
}

export type CompleteFn = typeof complete;

const ANSWER_PROMPT = `Answer the question using only the notes. Reply with a short phrase in {{language}}.
If the notes do not contain the answer, reply exactly: unknown`;

export async function loadScenarios(dir: string, only: string[] = []): Promise<Scenario[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.yaml')).sort();
  const scenarios: Scenario[] = [];
  for (const file of files) {
    if (only.length && !only.includes(file.replace(/\.yaml$/, ''))) continue;
    scenarios.push(scenarioSchema.parse(parse(await readFile(join(dir, file), 'utf8'))));
  }
  return scenarios;
}

/** A keyword grade: the answer passes if it names any expected keyword and is not "unknown". */
export function grade(answer: string, expected: string[]): boolean {
  const text = normalize(answer);
  if (!text || /^unknown\b/.test(text) || /^unbekannt\b/.test(text)) return false;
  return expected.some((keyword) => text.includes(normalize(keyword)));
}

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Retries rate limits and server errors, which free endpoints return often. */
export function withRetry(fn: CompleteFn, attempts = 6, delayMs = 5000): CompleteFn {
  return async (...args) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn(...args);
      } catch (err) {
        const retryable =
          err instanceof OpenAI.APIError && (err.status === 429 || (err.status ?? 0) >= 500);
        if (!retryable || attempt >= attempts) throw err;
        await new Promise((r) => setTimeout(r, delayMs * attempt));
      }
    }
  };
}

/**
 * Plays a scripted scene through the real Active Memory and canon code, then asks the
 * scenario's fact questions twice: against the memory summary alone, and against the canon
 * a new scene would get.
 */
export async function runScenario(
  scenario: Scenario,
  profile: EvalProfile,
  completeFn: CompleteFn = withRetry(complete),
): Promise<ScenarioResult> {
  const started = Date.now();
  const root = await mkdtemp(join(tmpdir(), 'teahouse-eval-'));
  const result: ScenarioResult = {
    scenario: scenario.name,
    model: profile.model,
    contextWindow: scenario.contextWindow,
    summaries: 0,
    summarizedMessages: 0,
    totalMessages: scenario.turns.length * 2,
    memory: null,
    canon: null,
    canonFiles: [],
    error: null,
    durationMs: 0,
  };

  try {
    const db = openDb(':memory:');
    const worlds = new WorldService(join(root, 'worlds'));
    await worlds.init();
    const hub = new Hub();
    const summaryErrors: string[] = [];
    const memory = new Memory(db, worlds, completeFn, (err) =>
      summaryErrors.push(err instanceof Error ? err.message : String(err)),
    );
    const generator = new Generator(db, hub, worlds, memory, () => {
      throw new Error('The narrator is scripted in evals');
    });
    const proposals = new CanonProposals({ db, worlds, hub, complete: completeFn });
    const scenes = new Scenes(db, worlds, hub, generator, proposals, completeFn);

    const timestamp = now();
    const profileId = newId();
    db.insert(profiles)
      .values({
        id: profileId,
        name: 'eval',
        ...profile,
        topP: null,
        maxTokens: 400,
        contextWindowOverride: scenario.contextWindow,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    saveSettings(db, {
      ...getSettings(db),
      userName: scenario.user,
      outputLanguage: scenario.language,
      narratorProfileId: profileId,
      canonReview: false,
    });

    const world = await worlds.create(scenario.name);
    await worlds.write(
      world.id,
      'world.md',
      stringifyDocument({
        data: {
          id: world.id,
          type: 'world',
          name: scenario.name,
          tags: [],
          aliases: [],
          summary: '',
        },
        body: scenario.world,
      }),
    );
    for (const c of scenario.characters) {
      await worlds.write(
        world.id,
        `characters/${c.slug}.md`,
        stringifyDocument({
          data: {
            type: 'character',
            name: c.name,
            tags: [],
            aliases: [],
            summary: c.summary,
            greetings: [],
          },
          body: c.body,
        }),
      );
    }

    const chatId = newId();
    const cast = scenario.characters.map((c) => c.slug);
    db.insert(chats)
      .values({
        id: chatId,
        title: scenario.name,
        worldId: world.id,
        characterSlug: cast[0] ?? '',
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    const scene = scenes.createFirst(chatId, cast, scenario.start);

    // Play the scripted turns; after each, let Active Memory do what it would in the app.
    let leaf = scene.startMessageId;
    for (const turn of scenario.turns) {
      for (const [role, content] of [
        ['user', turn.user],
        ['assistant', turn.assistant],
      ] as const) {
        const id = newId();
        const t = now();
        db.insert(messages)
          .values({
            id,
            chatId,
            sceneId: scene.id,
            parentId: leaf,
            role,
            content: content.trim(),
            status: 'complete',
            createdAt: t,
            updatedAt: t,
          })
          .run();
        leaf = id;
      }
      db.update(chats).set({ activeLeafId: leaf }).where(eq(chats.id, chatId)).run();
      memory.maybeSummarize(chatId);
      await memory.idle();
    }

    if (summaryErrors.length) result.error = `Summary failed: ${summaryErrors.join('; ')}`;
    const path = activePath(db, chatId, leaf);
    const nodes = memoryOnPath(db, scene.id, path);
    const last = nodes.at(-1);
    result.summaries = nodes.length;
    result.summarizedMessages = last ? path.findIndex((m) => m.id === last.messageId) : 0;
    if (last) result.memory = await ask(completeFn, profile, scenario, last.content);

    // End the scene with canon (review is off, so it is applied right away).
    scenes.close(chatId, true);
    await proposals.idle();
    const proposal = proposals.get(scene.id);
    if (proposal?.status === 'failed') throw new Error(`Canon proposal failed: ${proposal.error}`);
    result.canonFiles = proposal?.files.map((f) => f.path) ?? [];
    if (currentScene(db, chatId)?.status !== 'closed') throw new Error('The scene did not close');

    // What the next scene of this chat sees: the canon selection with an empty story so far.
    const canon = await selectCanon(worlds, {
      worldId: world.id,
      chatId,
      cast,
      recentText: '',
      budget: Math.floor(scenario.canonContextWindow * CANON_BUDGET_SHARE),
    });
    result.canon = await ask(completeFn, profile, scenario, canon.text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.error = result.error ? `${result.error}; ${message}` : message;
  } finally {
    await rm(root, { recursive: true, force: true });
    result.durationMs = Date.now() - started;
  }
  return result;
}

async function ask(
  completeFn: CompleteFn,
  profile: EvalProfile,
  scenario: Scenario,
  notes: string,
): Promise<StageResult> {
  const system = ANSWER_PROMPT.replace('{{language}}', scenario.language);
  const facts: FactResult[] = [];
  for (const fact of scenario.facts) {
    const answer = (
      await completeFn(
        { ...profile, topP: null, maxTokens: 200, temperature: 0 },
        [
          { role: 'system', content: system },
          {
            role: 'user',
            content: `<notes>\n${notes.replaceAll('{{user}}', scenario.user)}\n</notes>\n\nQuestion: ${fact.question}`,
          },
        ],
        { minTokens: 200 },
      )
    ).trim();
    facts.push({
      question: fact.question,
      expected: fact.answer,
      answer,
      pass: grade(answer, fact.answer),
    });
  }
  return {
    notes,
    noteTokens: countTokens(notes),
    facts,
    score: facts.filter((f) => f.pass).length / facts.length,
  };
}
