import { eq, sql } from 'drizzle-orm';
import type { Db } from './db/index.ts';
import { canonProposals, messages } from './db/schema.ts';
import { now } from './time.ts';

/** Error of a proposal whose generation ended with the server. */
export const INTERRUPTED = 'The server stopped while the proposal was being written.';

type MessageStatus = typeof messages.$inferSelect.status;
type ProposalStatus = typeof canonProposals.$inferSelect.status;

/** A reply that was streaming when its run ended can never finish: it stays as it got. */
export const settledMessageStatus = (status: MessageStatus): MessageStatus =>
  status === 'streaming' ? 'stopped' : status;

/** A proposal that was being generated when its run ended is offered for regeneration. */
export const settledProposalStatus = (status: ProposalStatus): ProposalStatus =>
  status === 'generating' ? 'failed' : status;

/**
 * Settles what a crash or a hard stop left running: no reply streams and no proposal is
 * generated before this process starts one. Without it, the UI waits for them forever.
 */
export function recoverInterrupted(db: Db): { messages: number; proposals: number } {
  const timestamp = now();
  return db.transaction((tx) => ({
    messages: tx
      .update(messages)
      .set({
        status: settledMessageStatus('streaming'),
        updatedAt: timestamp,
        revision: sql`${messages.revision} + 1`,
      })
      .where(eq(messages.status, 'streaming'))
      .run().changes,
    proposals: tx
      .update(canonProposals)
      .set({
        status: settledProposalStatus('generating'),
        error: INTERRUPTED,
        updatedAt: timestamp,
        revision: sql`${canonProposals.revision} + 1`,
      })
      .where(eq(canonProposals.status, 'generating'))
      .run().changes,
  }));
}
