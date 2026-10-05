/**
 * Memory test run (concept, v0.1 step 4): plays the reference scenes and checks which facts
 * survive Active Memory and the canon update.
 *
 *   pnpm --filter @teahouse/server eval:memory -- --model inclusionai/ling-3.1-flash
 *
 * Options: --base-url (default OpenRouter), --model, --api-key (or TEAHOUSE_EVAL_API_KEY /
 * OPENROUTER_API_KEY), --scenario <name> (repeatable), --min-score <0..1>, --out <dir>.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadScenarios, runScenario, type ScenarioResult } from './harness.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const { values } = parseArgs({
  options: {
    'base-url': { type: 'string', default: 'https://openrouter.ai/api/v1' },
    model: { type: 'string', default: 'inclusionai/ling-3.1-flash' },
    'api-key': { type: 'string' },
    scenario: { type: 'string', multiple: true, default: [] },
    'min-score': { type: 'string', default: '0' },
    out: { type: 'string', default: join(here, 'results') },
  },
});

const apiKey =
  values['api-key'] ?? process.env.TEAHOUSE_EVAL_API_KEY ?? process.env.OPENROUTER_API_KEY ?? null;
const profile = { baseUrl: values['base-url'], apiKey, model: values.model, temperature: 0.3 };
const scenarios = await loadScenarios(join(here, 'scenarios'), values.scenario);
if (scenarios.length === 0) throw new Error('No scenarios matched');

const results: ScenarioResult[] = [];
for (const scenario of scenarios) {
  process.stdout.write(`${scenario.name} … `);
  const result = await runScenario(scenario, profile);
  results.push(result);
  console.log(
    result.error ? `error: ${result.error}` : `${(result.durationMs / 1000).toFixed(0)}s`,
  );
}

const pct = (score: number | undefined) =>
  score === undefined ? '—' : `${Math.round(score * 100)} %`;
const rows = results.map((r) => ({
  scenario: r.scenario,
  summaries: r.summaries,
  covered: `${r.summarizedMessages}/${r.totalMessages}`,
  memory: pct(r.memory?.score),
  canon: pct(r.canon?.score),
  error: r.error ?? '',
}));
console.table(rows);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
await mkdir(values.out, { recursive: true });
const base = join(values.out, `${stamp}-${values.model.replace(/[^\w.-]+/g, '_')}`);
await writeFile(
  `${base}.json`,
  `${JSON.stringify({ profile: { ...profile, apiKey: undefined }, results }, null, 2)}\n`,
);
await writeFile(`${base}.md`, report(values.model, results));
console.log(`Report: ${base}.md`);

const scores = results
  .flatMap((r) => [r.memory?.score, r.canon?.score])
  .filter((s) => s !== undefined);
const average = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
const failed = results.some((r) => r.error) || average < Number(values['min-score']);
process.exitCode = failed ? 1 : 0;

function report(model: string, all: ScenarioResult[]): string {
  const lines = [`# Memory test run`, '', `Model: \`${model}\`, ${new Date().toISOString()}`, ''];
  lines.push('| Scenario | Summaries | Covered | Memory | Canon |', '|---|---|---|---|---|');
  for (const r of all) {
    lines.push(
      `| ${r.scenario} | ${r.summaries} | ${r.summarizedMessages}/${r.totalMessages} | ${pct(r.memory?.score)} | ${pct(r.canon?.score)} |`,
    );
  }
  for (const r of all) {
    lines.push('', `## ${r.scenario}`, '');
    if (r.error) lines.push(`**Error:** ${r.error}`, '');
    for (const [label, stage] of [
      ['Memory', r.memory],
      ['Canon', r.canon],
    ] as const) {
      if (!stage) {
        lines.push(`${label}: not run.`, '');
        continue;
      }
      lines.push(`### ${label} (${pct(stage.score)}, ${stage.noteTokens} tokens of notes)`, '');
      lines.push('| | Question | Expected | Answer |', '|---|---|---|---|');
      for (const f of stage.facts) {
        lines.push(
          `| ${f.pass ? '✓' : '✗'} | ${f.question} | ${f.expected.join(', ')} | ${f.answer.replace(/\s+/g, ' ').replaceAll('|', '\\|')} |`,
        );
      }
      lines.push(
        '',
        '<details><summary>Notes</summary>',
        '',
        '```',
        stage.notes,
        '```',
        '',
        '</details>',
        '',
      );
    }
  }
  return `${lines.join('\n')}\n`;
}
