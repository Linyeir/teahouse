import { DEFAULT_IMAGE_LABELS, renderTemplate } from '@teahouse/shared';
import type { ChatMessage } from './llm/client.ts';

export const DEFAULT_NARRATOR_TEMPLATE = `You are co-writing an interactive roleplay with {{user}}.
You play {{char}} and narrate the scene around them, including any other characters of the world who appear.
Write only what {{char}} and the world do and say. Never write actions, thoughts or speech for {{user}}.
Keep replies focused and end at a point where {{user}} can react.
Write in {{language}}.`;

/** How replies are marked up for the visual novel view (concept, section 6). */
export const MARKUP_INSTRUCTIONS = `Format every reply with these tags only:
<narration>What happens, in prose. Use it for actions and descriptions.</narration>
<say who="slug" mood="label">Only the spoken words of that character.</say>
<bg id="background-id"/> when the scene moves to another place, before the text that happens there.
<leave who="slug"/> when a character leaves the scene.
A character enters the scene with their first <say>. Pick mood from that character's labels. Never use <say> for {{user}}.`;

export interface StageInfo {
  characters: { slug: string; name: string; moods: string[] }[];
  backgrounds: { id: string; description: string }[];
  /** Current background and who is present, from the scene so far. */
  background: string | null;
  present: string[];
}

export interface NarratorContext {
  characterName: string;
  /** Canon files selected for this turn, already rendered as `<file>` blocks. */
  canon: string;
  /** Active Memory summary of the scene so far. */
  memory: string;
  /** Start message of the scene, always verbatim. */
  startMessage: string | null;
  userName: string;
  language: string;
  stage: StageInfo;
  history: { role: 'user' | 'assistant'; content: string }[];
}

function stageText(stage: StageInfo): string {
  const characters = stage.characters
    .map(
      (c) =>
        `- ${c.slug}: ${c.name} (moods: ${(c.moods.length ? c.moods : DEFAULT_IMAGE_LABELS).join(', ')})`,
    )
    .join('\n');
  const backgrounds = stage.backgrounds.length
    ? stage.backgrounds.map((b) => `- ${b.id}: ${b.description}`).join('\n')
    : '(none; do not use <bg>)';
  const current = [
    `Current background: ${stage.background ?? 'none yet'}.`,
    `Present: ${stage.present.length ? stage.present.join(', ') : 'nobody yet'}.`,
  ].join(' ');
  return `Characters:\n${characters}\n\nBackgrounds:\n${backgrounds}\n\n${current}`;
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
  // Ordered from most to least stable, for KV cache reuse: the stage block changes only when
  // the background or the people present change.
  const system = [
    render(DEFAULT_NARRATOR_TEMPLATE),
    render(MARKUP_INSTRUCTIONS),
    block('canon', render(ctx.canon)),
    block('scene_so_far', render(ctx.memory)),
    block('stage', stageText(ctx.stage)),
  ]
    .filter(Boolean)
    .join('\n\n');
  return [
    { role: 'system', content: system },
    ...(ctx.startMessage
      ? [{ role: 'assistant' as const, content: render(ctx.startMessage) }]
      : []),
    ...ctx.history.map((m) => ({ role: m.role, content: render(m.content) })),
  ];
}
