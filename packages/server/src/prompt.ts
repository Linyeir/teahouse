import { DEFAULT_IMAGE_LABELS, renderTemplate } from '@teahouse/shared';
import type { ChatMessage } from './llm/client.ts';

export const DEFAULT_NARRATOR_TEMPLATE = `You are co-writing an interactive roleplay with {{user}}, one turn at a time.
Each turn belongs to one character or to the narrator; the <turn> at the end says whose turn it is.
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
  /** `{{char}}` in the history: the speaker, or the characters present. */
  characterName: string;
  /**
   * `{{char}}` in the system message (canon, memory): everyone in the scene, so it stays the
   * same whoever's turn it is.
   */
  sceneName: string;
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

/** The world's cast and backgrounds, which change only when the world does. */
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
  return `Characters:\n${characters}\n\nBackgrounds:\n${backgrounds}`;
}

/** Where the scene stands now, which changes with backgrounds and entrances. */
function currentText(stage: StageInfo): string {
  return [
    `Current background: ${stage.background ?? 'none yet'}.`,
    `Present: ${stage.present.length ? stage.present.join(', ') : 'nobody yet'}.`,
  ].join(' ');
}

const block = (tag: string, content: string, attrs = '') =>
  content.trim() ? `<${tag}${attrs}>\n${content.trim()}\n</${tag}>` : '';

/**
 * Builds the narrator prompt. Local servers reuse their KV cache for the longest prefix that
 * did not change, so the system message holds only what stays the same from turn to turn
 * (template, canon, memory, the world's cast) and whose turn it is goes last, in a user
 * message. That also means the prompt never ends on an assistant message, which llama-server
 * would continue as a prefill instead of answering.
 */
export function buildNarratorMessages(ctx: NarratorContext): ChatMessage[] {
  const vars = { user: ctx.userName, language: ctx.language };
  const system = [
    renderTemplate(DEFAULT_NARRATOR_TEMPLATE, vars),
    renderTemplate(MARKUP_INSTRUCTIONS, vars),
    block('canon', renderTemplate(ctx.canon, { ...vars, char: ctx.sceneName })),
    block('scene_so_far', renderTemplate(ctx.memory, { ...vars, char: ctx.sceneName })),
    block('stage', stageText(ctx.stage)),
  ]
    .filter(Boolean)
    .join('\n\n');
  const render = (text: string) => renderTemplate(text, { ...vars, char: ctx.characterName });
  const turn = ctx.speaker
    ? renderTemplate(CHARACTER_TURN, { char: ctx.speaker.name, slug: ctx.speaker.slug })
    : NARRATOR_TURN;
  const story: StoryMessage[] = [
    ...(ctx.startMessage
      ? [{ role: 'assistant' as const, content: render(ctx.startMessage) }]
      : []),
    ...ctx.history.map((m) => ({ role: m.role, content: render(m.content) })),
    // After the user's own input, if there is any: it becomes part of that message.
    { role: 'user', content: block('turn', `${currentText(ctx.stage)}\n\n${turn}`) },
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
