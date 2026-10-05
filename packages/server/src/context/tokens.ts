import { countTokens as countO200k } from 'gpt-tokenizer';

/**
 * Token estimate. Endpoints use different tokenizers, so this counts with a common one
 * (o200k) and adds a margin. Over-estimating only makes memory summarize a bit early.
 */
export const TOKEN_MARGIN = 1.15;

/** Per-message overhead of chat templates (role markers, separators). */
const MESSAGE_OVERHEAD = 6;

export function countTokens(text: string): number {
  return Math.ceil(countO200k(text) * TOKEN_MARGIN);
}

export function countMessageTokens(messages: { content?: unknown }[]): number {
  return messages.reduce(
    (sum, m) =>
      sum + countTokens(typeof m.content === 'string' ? m.content : '') + MESSAGE_OVERHEAD,
    0,
  );
}

export interface BudgetProfile {
  contextWindowOverride: number | null;
  detectedContextWindow: number | null;
  maxTokens: number | null;
}

/** Context assumed when neither override nor detection gave a value. */
export const FALLBACK_CONTEXT = 8192;
/** Response length reserved when the profile sets no max tokens. */
export const DEFAULT_RESPONSE_RESERVE = 1024;

export function contextWindow(profile: BudgetProfile): number {
  return profile.contextWindowOverride ?? profile.detectedContextWindow ?? FALLBACK_CONTEXT;
}

export function responseReserve(profile: BudgetProfile): number {
  return profile.maxTokens ?? DEFAULT_RESPONSE_RESERVE;
}
