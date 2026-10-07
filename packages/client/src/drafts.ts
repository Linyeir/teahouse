/**
 * The composer's unsent text per chat, kept across reloads. A queued message that the server
 * rejects on reconnect comes back here, so its text is never lost.
 */
const key = (chatId: string) => `teahouse.draft:${chatId}`;
const EVENT = 'teahouse:draft';

export function readDraft(chatId: string): string {
  try {
    return localStorage.getItem(key(chatId)) ?? '';
  } catch {
    return '';
  }
}

export function writeDraft(chatId: string, text: string): void {
  try {
    if (text) localStorage.setItem(key(chatId), text);
    else localStorage.removeItem(key(chatId));
  } catch {
    // Storage unavailable: the draft lives only in the text field.
  }
}

/** Puts text back into a chat's composer, also when it is open right now. */
export function restoreDraft(chatId: string, text: string): void {
  const current = readDraft(chatId);
  const next = current ? `${text}\n\n${current}` : text;
  writeDraft(chatId, next);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { chatId, text: next } }));
}

export function onDraftRestored(listener: (chatId: string, text: string) => void): () => void {
  const handler = (e: Event) => {
    const { chatId, text } = (e as CustomEvent<{ chatId: string; text: string }>).detail;
    listener(chatId, text);
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
