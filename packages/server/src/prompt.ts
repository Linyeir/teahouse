import { DEFAULT_IMAGE_LABELS, renderTemplate } from '@teahouse/shared';
import type { ChatMessage } from './llm/client.ts';

export const DEFAULT_NARRATOR_TEMPLATE = `You are co-writing an interactive roleplay with {{user}}, one turn at a time.
Each turn belongs to one character or to the narrator; the end of this prompt says whose turn it is.
Never write actions, thoughts or speech for {{user}}.
Keep replies focused and end at a point where someone else can react.
Write in {{language}}.`;

/** How replies are marked up for the visual novel view (concept, section 6). */
export const MARKUP_INSTRUCTIONS = `Format every reply with these tags only:
<narration>What happens, in prose. Use it for actions and descriptions.</narration>
<say who="slug" mood="label">Only the spoken words of the character whose turn it is.</say>
<bg id="background-id"/> when the scene moves to another place, before the text that happens there.
<leave who="slug"/> when a character leaves the scene.
Pick mood from that character's labels. Never use <say> for {{user}}.`;

/** One character's turn (concept, section 6). `{{slug}}` is the character's slug. */
export const CHARACTER_TURN = `This turn is {{char}}'s. Write only what {{char}} does and says, and use <say> only with who="{{slug}}". The other characters act in their own turns: do not write what they do or say.`;

/** The narrator's turn: the scene, but nobody's lines. */
export const NARRATOR_TURN = `This turn is the narrator's. Describe the scene and what happens around the characters, and move the story along. Do not use <say>, and do not write what the characters do or say: they act in their own turns.`;

export interface StageInfo {
  characters: { slug: string; name: string; moods: string[] }[];
  backgrounds: { id: string; description: string }[];
  /** Current background and who is present, from the scene so far. */
  background: string | null;
  present: string[];
}

type StoryMessage = { role: 'user' | 'assistant'; content: string };

export interface NarratorContext {
  /** The character whose turn it is; null for the narrator's turn. */
  speaker: { slug: string; name: string } | null;
  /** `{{char}}` in canon and history: the speaker, or the characters present. */
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
  history: StoryMessage[];
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
  const turn = ctx.speaker
    ? renderTemplate(CHARACTER_TURN, { char: ctx.speaker.name, slug: ctx.speaker.slug })
    : NARRATOR_TURN;
  // Ordered from most to least stable, for KV cache reuse: the stage block changes only when
  // the background or the people present change, the turn whenever someone else speaks.
  const system = [
    render(DEFAULT_NARRATOR_TEMPLATE),
    render(MARKUP_INSTRUCTIONS),
    block('canon', render(ctx.canon)),
    block('scene_so_far', render(ctx.memory)),
    block('stage', stageText(ctx.stage)),
    block('turn', turn),
  ]
    .filter(Boolean)
    .join('\n\n');
  const story: StoryMessage[] = [
    ...(ctx.startMessage
      ? [{ role: 'assistant' as const, content: render(ctx.startMessage) }]
      : []),
    ...ctx.history.map((m) => ({ role: m.role, content: render(m.content) })),
  ];
  return [{ role: 'system', content: system }, ...mergeRuns(story)];
}

/**
 * Joins consecutive messages of the same role. Several characters can take turns without the
 * user writing in between, and some chat templates reject roles that do not alternate.
 */
function mergeRuns(messages: StoryMessage[]): StoryMessage[] {
  const merged: StoryMessage[] = [];
  for (const message of messages) {
    const last = merged.at(-1);
    if (last?.role === message.role) last.content = `${last.content}\n\n${message.content}`;
    else merged.push({ ...message });
  }
  return merged;
}
