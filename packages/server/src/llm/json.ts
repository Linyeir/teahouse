import { z } from 'zod';
import {
  type ChatMessage,
  type CompleteOptions,
  type complete,
  extractJson,
  type GenerationProfile,
} from './client.ts';

/** The model's answer could not be used even after a retry. */
export class ModelOutputError extends Error {}

/**
 * Asks for JSON matching `schema` (structured output where supported) and validates it.
 * An unusable answer gets one retry with the validation error as feedback.
 */
export async function completeJson<T extends z.ZodType>(
  completeFn: typeof complete,
  profile: GenerationProfile,
  messages: ChatMessage[],
  schema: T,
  options: Omit<CompleteOptions, 'jsonSchema'> & { name: string },
): Promise<z.infer<T>> {
  const conversation = [...messages];
  const jsonSchema = {
    name: options.name,
    schema: z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>,
  };
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await completeFn(profile, conversation, { ...options, jsonSchema });
    try {
      return schema.parse(extractJson(text));
    } catch (err) {
      lastError =
        err instanceof z.ZodError
          ? z.prettifyError(err)
          : err instanceof Error
            ? err.message
            : String(err);
      conversation.push(
        { role: 'assistant', content: text || '(empty)' },
        {
          role: 'user',
          content: `That was not usable: ${lastError.slice(0, 500)}\nReturn only the JSON object.`,
        },
      );
    }
  }
  throw new ModelOutputError(`The model returned no usable answer: ${lastError.slice(0, 300)}`);
}
