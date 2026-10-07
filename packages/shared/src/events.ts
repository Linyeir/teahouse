import type { Message } from './api.ts';

/** Server → client messages on the WebSocket. */
export type ServerEvent =
  | { type: 'generation.started'; chatId: string; message: Message }
  | {
      type: 'generation.delta';
      chatId: string;
      messageId: string;
      /** Length of the message content before this delta, to detect gaps and overlaps. */
      offset: number;
      delta: string;
    }
  | { type: 'generation.finished'; chatId: string; message: Message }
  | { type: 'chat.changed'; chatId: string }
  | { type: 'proposal.changed'; chatId: string; sceneId: string }
  /** A device was paired or signed out. */
  | { type: 'devices.changed' };

/** Client → server messages on the WebSocket. */
export type ClientEvent = { type: 'generation.stop'; messageId: string };
