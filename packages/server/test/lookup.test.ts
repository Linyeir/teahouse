import { describe, expect, it } from 'vitest';
import { lookUp, MAX_LOOKUP_ROUNDS, type ToolsFn } from '../src/canon/lookup.ts';
import type { ChatMessage, ToolTurn } from '../src/llm/client.ts';
import { tempWorlds } from './helpers.ts';

const profile = {
  baseUrl: 'http://127.0.0.1:9/v1',
  apiKey: null,
  model: 'fake',
  temperature: null,
  topP: null,
  maxTokens: null,
};

async function world() {
  const worlds = await tempWorlds();
  const { id } = await worlds.create('Rain Port');
  await worlds.write(
    id,
    'places/tavern.md',
    '---\nname: Leaky Cup\n---\n\nSmoky. The crate waits.',
  );
  await worlds.write(id, 'places/pier.md', '---\nname: Pier Nine\n---\n\nWet planks.');
  return { worlds, id };
}

/** Answers with the scripted turns in order and records what it was sent. */
function scripted(turns: ToolTurn[]) {
  const sent: ChatMessage[][] = [];
  const fn: ToolsFn = async (_p, messages) => {
    sent.push([...messages]);
    return turns[sent.length - 1] ?? { content: 'done', toolCalls: [] };
  };
  return { fn, sent };
}

const call = (id: string, name: string, args: object | string) => ({
  id,
  name,
  arguments: typeof args === 'string' ? args : JSON.stringify(args),
});

const toolResults = (messages: ChatMessage[] | undefined) =>
  (messages ?? []).flatMap((m) => (m.role === 'tool' ? [String(m.content)] : []));

describe('lookUp', () => {
  it('reads files and searches until the model is done', async () => {
    const { worlds, id } = await world();
    const { fn, sent } = scripted([
      {
        content: '',
        toolCalls: [
          call('a', 'search', { query: 'CRATE' }),
          call('b', 'read_file', { path: 'places/tavern.md' }),
        ],
      },
    ]);
    const result = await lookUp({
      toolsFn: fn,
      profile,
      messages: [{ role: 'user', content: 'scene' }],
      worlds,
      worldId: id,
      known: new Set(),
      budget: 10_000,
    });

    expect([...result.files.keys()]).toEqual(['places/tavern.md']);
    expect(result.files.get('places/tavern.md')).toContain('Smoky. The crate waits.');
    expect(result.calls.map((c) => c.name)).toEqual(['search', 'read_file']);
    expect(result.error).toBeNull();
    // The second turn sees both results.
    const [found, read] = toolResults(sent[1]);
    expect(found).toBe('places/tavern.md (Leaky Cup)\n  Smoky. The crate waits.');
    expect(read).toContain('Smoky. The crate waits.');
    expect(sent).toHaveLength(2);
  });

  it('turns down what it cannot or need not read', async () => {
    const { worlds, id } = await world();
    const { fn, sent } = scripted([
      {
        content: '',
        toolCalls: [
          call('a', 'read_file', { path: 'places/tavern.md' }),
          call('b', 'read_file', { path: 'places/nowhere.md' }),
          call('c', 'read_file', { path: '../../etc/passwd' }),
          call('d', 'read_file', { path: 'places/pier.md' }),
          call('e', 'read_file', '{broken'),
          call('f', 'delete_world', {}),
          call('g', 'search', { query: 'nothing like this' }),
        ],
      },
    ]);
    const result = await lookUp({
      toolsFn: fn,
      profile,
      messages: [],
      worlds,
      worldId: id,
      known: new Set(['places/tavern.md']),
      budget: 5,
    });

    expect(result.files.size).toBe(0);
    expect(toolResults(sent[1])).toEqual([
      'This file is already in your prompt.',
      'There is no file places/nowhere.md. Paths are listed in <canon_index>.',
      'There is no file ../../etc/passwd. Paths are listed in <canon_index>.',
      'There is no room left for this file. Work with what you have.',
      'The arguments were not valid JSON.',
      'There is no tool delete_world.',
      'No file contains "nothing like this".',
    ]);
  });

  it('stops after a few rounds and keeps what it read when the endpoint fails', async () => {
    const { worlds, id } = await world();
    const reading = { content: '', toolCalls: [call('a', 'search', { query: 'wet' })] };
    const endless = scripted(Array.from({ length: 10 }, () => reading));
    await lookUp({
      toolsFn: endless.fn,
      profile,
      messages: [],
      worlds,
      worldId: id,
      known: new Set(),
      budget: 1000,
    });
    expect(endless.sent).toHaveLength(MAX_LOOKUP_ROUNDS);

    let turns = 0;
    const failing: ToolsFn = async () => {
      if (turns++ > 0) throw new Error('400 tools are not supported');
      return { content: '', toolCalls: [call('a', 'read_file', { path: 'places/pier.md' })] };
    };
    const result = await lookUp({
      toolsFn: failing,
      profile,
      messages: [],
      worlds,
      worldId: id,
      known: new Set(),
      budget: 1000,
    });
    expect([...result.files.keys()]).toEqual(['places/pier.md']);
    expect(result.error).toBe('400 tools are not supported');
  });
});
