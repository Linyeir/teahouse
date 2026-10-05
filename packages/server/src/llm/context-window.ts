import { createClient, type Endpoint } from './client.ts';

type Json = Record<string, unknown>;

const positiveInt = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;

/**
 * Reads the context window from a `/models` entry. Only fields that describe the context
 * actually available are used: OpenRouter's `context_length` and LM Studio's loaded length.
 */
export function contextFromModelEntry(entry: Json): number | null {
  return positiveInt(entry.loaded_context_length) ?? positiveInt(entry.context_length);
}

/** Model maximum, used only when no endpoint reports the loaded context. */
export function maxContextFromModelEntry(entry: Json): number | null {
  const meta = (entry.meta ?? {}) as Json;
  return positiveInt(entry.max_context_length) ?? positiveInt(meta.n_ctx_train);
}

/** llama.cpp `/props`: the context the server was started with, divided across its slots. */
export function contextFromLlamaProps(props: Json): number | null {
  const settings = (props.default_generation_settings ?? {}) as Json;
  return positiveInt(settings.n_ctx) ?? positiveInt(props.n_ctx);
}

/**
 * Detects the context window of `model` behind an OpenAI-compatible endpoint.
 * Tries, in order: the `/models` listing (OpenRouter, LM Studio), llama.cpp `/props`,
 * LM Studio's native `/api/v0/models/{id}`, and finally the model's trained maximum.
 */
export async function detectContextWindow(
  endpoint: Endpoint,
  model: string,
): Promise<number | null> {
  let fallback: number | null = null;

  try {
    for await (const entry of createClient(endpoint).models.list()) {
      if (entry.id !== model) continue;
      const found = contextFromModelEntry(entry as unknown as Json);
      if (found) return found;
      fallback = maxContextFromModelEntry(entry as unknown as Json);
      break;
    }
  } catch {
    // Listing is optional for detection; fall through to server-specific probes.
  }

  const root = serverRoot(endpoint.baseUrl);
  const props = await getJson(`${root}/props`, endpoint.apiKey);
  const fromProps = props && contextFromLlamaProps(props);
  if (fromProps) return fromProps;

  const lmStudio = await getJson(
    `${root}/api/v0/models/${encodeURIComponent(model)}`,
    endpoint.apiKey,
  );
  if (lmStudio) {
    const found = contextFromModelEntry(lmStudio) ?? maxContextFromModelEntry(lmStudio);
    if (found) return found;
  }

  return fallback;
}

function serverRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
}

async function getJson(url: string, apiKey: string | null): Promise<Json | null> {
  try {
    const response = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    return body && typeof body === 'object' ? (body as Json) : null;
  } catch {
    return null;
  }
}
