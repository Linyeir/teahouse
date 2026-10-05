import { decode as decodeText } from 'png-chunk-text';
import extractChunks from 'png-chunks-extract';
import { z } from 'zod';

const text = z.string().catch('');

const bookEntry = z
  .object({
    keys: z.array(z.string()).catch([]),
    content: text,
    name: z.string().optional(),
    comment: z.string().optional(),
    enabled: z.boolean().catch(true),
  })
  .loose();

const cardData = z
  .object({
    name: z.string().trim().min(1),
    description: text,
    personality: text,
    scenario: text,
    first_mes: text,
    mes_example: text,
    alternate_greetings: z.array(z.string()).catch([]),
    system_prompt: text,
    post_history_instructions: text,
    creator_notes: text,
    tags: z.array(z.string()).catch([]),
    character_book: z
      .object({ name: z.string().optional(), entries: z.array(bookEntry).catch([]) })
      .loose()
      .optional()
      .catch(undefined),
  })
  .loose();

export type CardData = z.infer<typeof cardData>;
export type BookEntry = z.infer<typeof bookEntry>;

export interface ParsedCard {
  spec: 'v1' | 'v2' | 'v3';
  data: CardData;
}

export class CardError extends Error {}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const isPng = (bytes: Uint8Array) => Buffer.from(bytes.subarray(0, 8)).equals(PNG_SIGNATURE);

/** Parses a Character Card V1, V2 or V3 from a PNG (`ccv3` or `chara` chunk) or JSON file. */
export function parseCard(bytes: Uint8Array): ParsedCard {
  let json: string;
  if (isPng(bytes)) {
    const chunks = extractChunks(bytes)
      .filter((c) => c.name === 'tEXt')
      .map((c) => decodeText(c.data));
    // V3 cards carry both chunks; `ccv3` is the authoritative one.
    const chunk =
      chunks.find((c) => c.keyword.toLowerCase() === 'ccv3') ??
      chunks.find((c) => c.keyword.toLowerCase() === 'chara');
    if (!chunk) throw new CardError('The PNG contains no character card data');
    json = Buffer.from(chunk.text, 'base64').toString('utf8');
  } else {
    json = Buffer.from(bytes).toString('utf8');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new CardError('The card data is not valid JSON');
  }
  if (!raw || typeof raw !== 'object') throw new CardError('The card data is not an object');

  const obj = raw as Record<string, unknown>;
  const spec = obj.spec === 'chara_card_v3' ? 'v3' : obj.spec === 'chara_card_v2' ? 'v2' : 'v1';
  const result = cardData.safeParse(spec === 'v1' ? obj : obj.data);
  if (!result.success) throw new CardError('The card has no character name');
  return { spec, data: normalizeMacros(result.data) };
}

/** Old cards use `<USER>` and `<BOT>`; Teahouse uses ST's `{{user}}` and `{{char}}`. */
function normalizeMacros<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(/<user>/gi, '{{user}}').replace(/<bot>/gi, '{{char}}') as T;
  }
  if (Array.isArray(value)) return value.map(normalizeMacros) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeMacros(v)])) as T;
  }
  return value;
}
