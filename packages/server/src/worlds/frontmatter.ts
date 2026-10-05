import { parse, stringify } from 'yaml';

export interface MarkdownDocument {
  data: Record<string, unknown>;
  body: string;
  /** Set when the frontmatter block exists but is not valid YAML. */
  error?: string;
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parseDocument(text: string): MarkdownDocument {
  const match = FENCE.exec(text);
  if (!match) return { data: {}, body: text };
  const body = text.slice(match[0].length).replace(/^\r?\n/, '');
  try {
    const data: unknown = parse(match[1] ?? '');
    return {
      data:
        data && typeof data === 'object' && !Array.isArray(data)
          ? (data as MarkdownDocument['data'])
          : {},
      body,
    };
  } catch (err) {
    return { data: {}, body, error: err instanceof Error ? err.message : String(err) };
  }
}

export function stringifyDocument({ data, body }: Pick<MarkdownDocument, 'data' | 'body'>): string {
  const yaml = stringify(data, { lineWidth: 0 }).trimEnd();
  const content = body.trim();
  return `---\n${yaml}\n---\n${content ? `\n${content}\n` : ''}`;
}

export const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

export const stringValue = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;
