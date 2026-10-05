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

function isOpenRouter(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.endsWith('openrouter.ai');
  } catch {
    return false;
  }
}
