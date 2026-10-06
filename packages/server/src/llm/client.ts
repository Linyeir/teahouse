import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

export interface Endpoint {
  baseUrl: string;
  apiKey: string | null;
}

export interface GenerationProfile extends Endpoint {
  model: string;
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
}

export type ChatMessage = ChatCompletionMessageParam;

export function createClient({ baseUrl, apiKey }: Endpoint): OpenAI {
  return new OpenAI({
    baseURL: baseUrl,
    // Local servers usually need no key, but the SDK requires a value.
    apiKey: apiKey || 'none',
    maxRetries: 2,
    timeout: 10 * 60 * 1000,
    defaultHeaders: isOpenRouter(baseUrl)
      ? { 'HTTP-Referer': 'https://github.com/Linyeir/teahouse', 'X-Title': 'Teahouse' }
      : undefined,
  });
}

export async function listModels(endpoint: Endpoint): Promise<string[]> {
  const ids: string[] = [];
  for await (const model of createClient(endpoint).models.list()) ids.push(model.id);
  return ids.sort((a, b) => a.localeCompare(b));
}

/** Streams the text of a chat completion. Aborting the signal ends the stream early. */
export async function* streamChat(
  profile: GenerationProfile,
  messages: ChatMessage[],
  signal: AbortSignal,
): AsyncGenerator<string> {
  const stream = await createClient(profile).chat.completions.create(
    {
      model: profile.model,
      messages,
      stream: true,
      ...(profile.temperature !== null && { temperature: profile.temperature }),
      ...(profile.topP !== null && { top_p: profile.topP }),
      ...(profile.maxTokens !== null && { max_tokens: profile.maxTokens }),
    },
    { signal },
  );
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) yield delta;
  }
}

/** Budget for the retry when an answer was cut off by `max_tokens`. */
const REASONING_RETRY_TOKENS = 4096;
const MAX_RETRY_TOKENS = 16_384;

export interface CompleteOptions {
  signal?: AbortSignal;
  /**
   * Lower bound for `max_tokens`. The profile's limit is tuned for narrator replies; JSON
   * answers cut off by it are useless.
   */
  minTokens?: number;
  /** Asks for JSON matching this schema where the endpoint supports structured output. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
}

/** Non-streaming completion, used by the summary, canon and scene start roles. */
export async function complete(
  profile: GenerationProfile,
  messages: ChatMessage[],
  options: CompleteOptions = {},
): Promise<string> {
  const client = createClient(profile);
  const maxTokens =
    profile.maxTokens !== null && options.minTokens !== undefined
      ? Math.max(profile.maxTokens, options.minTokens)
      : profile.maxTokens;
  const base = {
    model: profile.model,
    messages,
    ...(profile.temperature !== null && { temperature: profile.temperature }),
    ...(profile.topP !== null && { top_p: profile.topP }),
    ...(maxTokens !== null && { max_tokens: maxTokens }),
  };
  type Format = 'json_schema' | 'json_object' | 'none';
  const responseFormat = (format: Format) =>
    format === 'json_schema' && options.jsonSchema
      ? { type: 'json_schema' as const, json_schema: { ...options.jsonSchema, strict: false } }
      : format === 'json_object'
        ? { type: 'json_object' as const }
        : undefined;
  const request = async (format: Format) => {
    const send = async (limit: number | null) => {
      const response = await client.chat.completions.create(
        {
          ...base,
          ...(limit !== null && { max_tokens: limit }),
          ...(responseFormat(format) && { response_format: responseFormat(format) }),
        },
        { signal: options.signal },
      );
      const choice = response.choices[0];
      return { content: choice?.message?.content ?? '', finish: choice?.finish_reason };
    };
    const first = await send(maxTokens);
    // A cut-off answer is useless here (broken JSON, a summary that stops mid-sentence), and
    // reasoning models can spend most of the budget thinking: retry once with more room.
    if (first.finish === 'length' && maxTokens !== null) {
      return (
        await send(Math.min(Math.max(maxTokens * 4, REASONING_RETRY_TOKENS), MAX_RETRY_TOKENS))
      ).content;
    }
    return first.content;
  };
  if (!options.jsonSchema) return request('none');
  // Support for `response_format` varies between servers and providers: try JSON schema,
  // then plain JSON mode, then nothing (the prompt asks for JSON as well).
  const formats: Format[] = ['json_schema', 'json_object', 'none'];
  for (const [i, format] of formats.entries()) {
    try {
      return await request(format);
    } catch (err) {
      const unsupported =
        err instanceof OpenAI.APIError &&
        err.status !== undefined &&
        err.status >= 400 &&
        err.status < 500 &&
        err.status !== 429;
      if (!unsupported || i === formats.length - 1) throw err;
    }
  }
  throw new Error('unreachable');
}

/** Extracts the first JSON object from model output (tolerates code fences and prose). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('The model did not return JSON');
    return JSON.parse(candidate.slice(start, end + 1));
  }
}

/** A message for the user: what went wrong with the endpoint and what to try. */
export function describeLlmError(err: unknown, baseUrl?: string): string {
  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    return 'The endpoint did not answer in time. Is the model still loading?';
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return `Could not reach ${baseUrl ?? 'the endpoint'}. Is the server running and the base URL right?`;
  }
  if (err instanceof OpenAI.APIError) {
    const detail = err.message.replace(/^\d{3}\s*/, '');
    switch (err.status) {
      case 429:
        return 'The provider is rate limiting requests (429). Wait a moment and regenerate, or choose another model. Free models are limited often.';
      case 401:
      case 403:
        return `The endpoint rejected the request (${err.status}): check the API key of the profile. ${detail}`;
      case 404:
        return `Not found (404): check the base URL and the model name. ${detail}`;
      case 402:
        return `The provider wants payment or credits (402). ${detail}`;
      default:
        return `The endpoint returned an error (${err.status ?? 'unknown'}): ${detail}`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

function isOpenRouter(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.endsWith('openrouter.ai');
  } catch {
    return false;
  }
}
