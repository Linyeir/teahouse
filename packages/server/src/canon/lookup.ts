import { countTokens } from '../context/tokens.ts';
import type {
  ChatMessage,
  completeWithTools,
  GenerationProfile,
  ToolCall,
  ToolDefinition,
} from '../llm/client.ts';
import type { WorldService } from '../worlds/service.ts';

export type ToolsFn = typeof completeWithTools;

/** Rounds of tool calls before the canon role has to answer with what it has. */
export const MAX_LOOKUP_ROUNDS = 4;
const MAX_SEARCH_FILES = 10;
const MAX_SEARCH_LINES = 2;

export const LOOKUP_TOOLS: ToolDefinition[] = [
  {
    name: 'read_file',
    description:
      'Returns the full text of a canon file. Use it for files you would change or need, but only know from <canon_index> or by their summary.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path as listed in <canon_index>' } },
      required: ['path'],
    },
  },
  {
    name: 'search',
    description:
      'Finds canon files that contain a word or phrase (case-insensitive), with the matching lines. Use it to find earlier events or where something is already described.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
];

const LOOKUP_REQUEST = `Before you write the update, look up what you need with the tools:
- read_file for files you would change or need but only know from <canon_index> or by their summary,
- search to find where a person, place or thing appeared before.
Call them now, several at once if you like. When you have what you need, or if you need nothing, answer only: done`;

export interface LookupResult {
  /** Files read in full, by path, in the order they were read. */
  files: Map<string, string>;
  /** What the model asked for, for the log. */
  calls: { name: string; arguments: string }[];
  /** Why the lookups ended early, if they did (the endpoint rejected tools, an error). */
  error: string | null;
}

/**
 * Lets the canon role look things up before it writes its proposal: it is offered
 * `read_file` and `search` for a few rounds, and the files it reads are returned to be
 * added to its prompt. Files in `known` are already there in full. Everything read stays
 * within `budget` tokens. Errors end the lookups but keep what was read: an endpoint without
 * tool support then gets the same prompt as before.
 */
export async function lookUp(options: {
  toolsFn: ToolsFn;
  profile: GenerationProfile;
  messages: ChatMessage[];
  worlds: WorldService;
  worldId: string;
  known: Set<string>;
  budget: number;
}): Promise<LookupResult> {
  const { toolsFn, profile, worlds, worldId, known } = options;
  const result: LookupResult = { files: new Map(), calls: [], error: null };
  const conversation: ChatMessage[] = [
    ...options.messages,
    { role: 'user', content: LOOKUP_REQUEST },
  ];
  let left = options.budget;

  const readFile = async (path: string): Promise<string> => {
    if (known.has(path) || result.files.has(path)) return 'This file is already in your prompt.';
    const text = (await worlds.readIfExists(worldId, path).catch(() => null))?.trim();
    if (text === undefined) return `There is no file ${path}. Paths are listed in <canon_index>.`;
    const tokens = countTokens(text);
    if (tokens > left) return 'There is no room left for this file. Work with what you have.';
    left -= tokens;
    result.files.set(path, text);
    return text;
  };

  const search = async (query: string): Promise<string> => {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) return 'Search for at least two characters.';
    const hits: string[] = [];
    for (const file of await worlds.files(worldId)) {
      const text = await worlds.readIfExists(worldId, file.path).catch(() => null);
      const lines = (text ?? '')
        .split('\n')
        .filter((line) => line.toLowerCase().includes(needle))
        .slice(0, MAX_SEARCH_LINES)
        .map((line) => `  ${line.trim().slice(0, 200)}`);
      if (lines.length) hits.push(`${file.path} (${file.name})\n${lines.join('\n')}`);
      if (hits.length >= MAX_SEARCH_FILES) break;
    }
    return hits.length ? hits.join('\n') : `No file contains "${query}".`;
  };

  const run = async (call: ToolCall): Promise<string> => {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.arguments || '{}');
    } catch {
      return 'The arguments were not valid JSON.';
    }
    const value = (key: string) => (typeof args[key] === 'string' ? (args[key] as string) : '');
    if (call.name === 'read_file') return readFile(value('path'));
    if (call.name === 'search') return search(value('query'));
    return `There is no tool ${call.name}.`;
  };

  try {
    for (let round = 0; round < MAX_LOOKUP_ROUNDS; round++) {
      const turn = await toolsFn(profile, conversation, LOOKUP_TOOLS, { minTokens: 1000 });
      if (turn.toolCalls.length === 0) break;
      conversation.push({
        role: 'assistant',
        content: turn.content || null,
        tool_calls: turn.toolCalls.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: c.arguments },
        })),
      });
      for (const call of turn.toolCalls) {
        result.calls.push({ name: call.name, arguments: call.arguments });
        conversation.push({ role: 'tool', tool_call_id: call.id, content: await run(call) });
      }
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}
