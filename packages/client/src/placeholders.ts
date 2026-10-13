import { NARRATOR_SPEAKER, renderTemplate } from '@teahouse/shared';

export interface PlaceholderContext {
  /** The persona's name, from the settings. */
  userName: string;
  /** Character names by slug. */
  names: Map<string, string>;
  /** Name of the character whose greeting opened the chat. */
  chatCharacter: string;
}

/**
 * A message's text as shown: `{{user}}` is the persona, `{{char}}` the character whose turn
 * it was, else the chat's character (start messages, older replies). The stored text keeps
 * the placeholders, so editing still shows them and a renamed persona shows up everywhere.
 */
export function shownContent(
  message: { content: string; speaker: string | null },
  ctx: PlaceholderContext,
): string {
  const speaker = message.speaker && message.speaker !== NARRATOR_SPEAKER ? message.speaker : null;
  const char = speaker ? (ctx.names.get(speaker) ?? speaker) : ctx.chatCharacter;
  return renderTemplate(message.content, { user: ctx.userName, char });
}
