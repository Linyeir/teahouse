import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type CompleteFn, grade, loadScenarios, runScenario } from '../eval/harness.ts';

const scenarioDir = fileURLToPath(new URL('../eval/scenarios', import.meta.url));
const profile = { baseUrl: 'http://127.0.0.1:9/v1', apiKey: null, model: 'fake', temperature: 0 };

/**
 * A fake LLM that keeps everything: the summary is the whole transcript, the canon event is
 * the transcript too, and answers quote the expected keyword when the notes contain it.
 */
function fakeLlm(expectedByQuestion: Map<string, string[]>): CompleteFn {
  return async (_profile, messages) => {
    const system = String(messages[0]?.content);
    const user = String(messages.at(-1)?.content);
    if (system.includes('running summary')) {
      const earlier = /<summary_so_far>\n([\s\S]*?)\n<\/summary_so_far>/.exec(user)?.[1] ?? '';
      const next = /<next_part>\n([\s\S]*?)\n<\/next_part>/.exec(user)?.[1] ?? '';
      return `${earlier === '(nothing yet)' ? '' : `${earlier}\n`}${next}`;
    }
    if (system.includes('canon of a roleplay world')) {
      const scene = /<scene[^>]*>\n([\s\S]*?)\n<\/scene>/.exec(user)?.[1] ?? '';
      return JSON.stringify({
        event: { title: 'What happened', summary: 'A scene.', body: scene, tags: [] },
        operations: [],
      });
    }
    const question = /Question: (.*)$/.exec(user)?.[1] ?? '';
    const notes = user.toLowerCase();
    const hit = expectedByQuestion.get(question)?.find((k) => notes.includes(k.toLowerCase()));
    return hit ?? 'unknown';
  };
}

describe('memory eval harness', () => {
  it('grades answers by keyword and treats "unknown" as a miss', () => {
    expect(grade('At noon, by the market.', ['noon', 'midday'])).toBe(true);
    expect(grade('Unknown', ['noon'])).toBe(false);
    expect(grade('at dawn', ['noon'])).toBe(false);
    expect(grade('Bei der kleinen Meerjungfrau', ['Meerjungfrau'])).toBe(true);
  });

  it('runs every scenario end to end; each one forces Active Memory to summarize', async () => {
    const scenarios = await loadScenarios(scenarioDir);
    expect(scenarios.map((s) => s.name)).toEqual(['Harbor deal', 'Mountain inn', 'Nachtzug']);

    for (const scenario of scenarios) {
      const expected = new Map(scenario.facts.map((f) => [f.question, f.answer]));
      const result = await runScenario(scenario, profile, fakeLlm(expected));
      expect(result.error, scenario.name).toBeNull();
      expect(result.summaries, scenario.name).toBeGreaterThan(0);
      expect(result.summarizedMessages, scenario.name).toBeGreaterThan(4);
      expect(result.canonFiles[0], scenario.name).toMatch(/^events\//);
      // A lossless fake must score full marks on both stages, or the harness is wrong.
      expect(
        result.memory?.facts.filter((f) => f.status === 'fail').map((f) => f.question),
        scenario.name,
      ).toEqual([]);
      expect(result.memory?.score, scenario.name).toBe(1);
      // Facts from turns the summary does not cover yet are skipped, not failed.
      const covered = Math.floor(result.summarizedMessages / 2);
      for (const f of result.memory?.facts ?? []) {
        const turn = scenario.facts.find((x) => x.question === f.question)?.turn ?? 0;
        expect(f.status === 'skipped', f.question).toBe(turn > covered);
      }
      expect(result.canon?.score, scenario.name).toBe(1);
    }
  }, 30_000);
});
