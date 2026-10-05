import { renderTemplate } from '@teahouse/shared';
import type { ChatMessage } from './llm/client.ts';

export const DEFAULT_NARRATOR_TEMPLATE = `You are co-writing an interactive roleplay with {{user}}.
You play {{char}} and narrate the scene around them.
Write only what {{char}} and the world do and say. Never write actions, thoughts or speech for {{user}}.
Keep replies focused and end at a point where {{user}} can react.
Write in {{language}}.`;

export interface NarratorContext {
  characterName: string;
  /** Canon texts without frontmatter. Empty ones are left out. */
  world: string;
  persona: string;
  character: string;
  userName: string;
  language: string;
  history: { role: 'user' | 'assistant'; content: string }[];
}

const block = (tag: string, content: string, attrs = '') =>
  content.trim() ? `<${tag}${attrs}>\n${content.trim()}\n</${tag}>` : '';

/**
 * Builds the narrator prompt. Static parts come first (template, then canon), so local
 * servers can reuse their KV cache across turns.
 */
export function buildNarratorMessages(ctx: NarratorContext): ChatMessage[] {
  const vars = { char: ctx.characterName, user: ctx.userName, language: ctx.language };
  const render = (text: string) => renderTemplate(text, vars);
  const system = [
    render(DEFAULT_NARRATOR_TEMPLATE),
    block('world', render(ctx.world)),
    block('user_persona', render(ctx.persona), ` name="${ctx.userName}"`),
    block('character', render(ctx.character), ` name="${ctx.characterName}"`),
  ]
    .filter(Boolean)
    .join('\n\n');
  return [
    { role: 'system', content: system },
    ...ctx.history.map((m) => ({ role: m.role, content: render(m.content) })),
  ];
}
