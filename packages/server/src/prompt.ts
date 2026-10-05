import { renderTemplate } from '@teahouse/shared';
import type { ChatMessage } from './llm/client.ts';

export const DEFAULT_NARRATOR_TEMPLATE = `You are co-writing an interactive roleplay with {{user}}.
You play {{char}} and narrate the scene around them.
Write only what {{char}} and the world do and say. Never write actions, thoughts or speech for {{user}}.
Keep replies focused and end at a point where {{user}} can react.
Write in {{language}}.

<character name="{{char}}">
{{description}}
</character>`;

export interface NarratorContext {
  characterName: string;
  characterDescription: string;
  userName: string;
  language: string;
  history: { role: 'user' | 'assistant'; content: string }[];
}

export function buildNarratorMessages(ctx: NarratorContext): ChatMessage[] {
  const vars = { char: ctx.characterName, user: ctx.userName, language: ctx.language };
  const system = renderTemplate(DEFAULT_NARRATOR_TEMPLATE, {
    ...vars,
    description: renderTemplate(ctx.characterDescription, vars).trim(),
  });
  return [
    { role: 'system', content: system },
    ...ctx.history.map((m) => ({ role: m.role, content: renderTemplate(m.content, vars) })),
  ];
}
