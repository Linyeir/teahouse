import { describe, expect, it } from 'vitest';
import { streamChat } from '../src/llm/client.ts';
import { detectContextWindow } from '../src/llm/context-window.ts';

// Runs against the real OpenRouter API when OPENROUTER_API_KEY is set, or with
// TEAHOUSE_LIVE_TESTS=1 where a proxy injects the key.
const apiKey = process.env.OPENROUTER_API_KEY;
const live = Boolean(apiKey) || process.env.TEAHOUSE_LIVE_TESTS === '1';
const model = process.env.TEAHOUSE_TEST_MODEL ?? 'inclusionai/ling-3.1-flash';
const endpoint = { baseUrl: 'https://openrouter.ai/api/v1', apiKey: apiKey ?? 'injected-by-proxy' };

describe.skipIf(!live)('OpenRouter (live)', () => {
  it('streams a reply', { timeout: 60_000 }, async () => {
    let text = '';
    for await (const delta of streamChat(
      { ...endpoint, model, temperature: 0, topP: null, maxTokens: 300 },
      [{ role: 'user', content: 'Reply with the single word: tea' }],
      new AbortController().signal,
    )) {
      text += delta;
    }
    expect(text.toLowerCase()).toContain('tea');
  });

  it('detects the context window', { timeout: 30_000 }, async () => {
    expect(await detectContextWindow(endpoint, model)).toBeGreaterThan(1000);
  });
});
