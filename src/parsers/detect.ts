import type { Provider } from '../types';

/**
 * Provider detection from a parsed `conversations.json`.
 *
 * Heuristic: peek at the first conversation in the array and check for
 * the structural marker that distinguishes Claude exports from ChatGPT
 * exports. Filename-agnostic on purpose — both providers ship the file
 * as `conversations.json` at the root of their ZIP.
 *
 * - Claude: top-level array of objects; each has `chat_messages[]`.
 * - ChatGPT: top-level array of objects; each has `mapping: {...}`.
 *
 * Returns `null` for arrays, empty arrays, or shapes that don't match
 * either provider — caller should respond with 400 `unknown_provider`.
 */
export function detectProvider(parsed: unknown): Provider | null {
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return null;
  }

  const first = parsed[0];
  if (!first || typeof first !== 'object') {
    return null;
  }

  const obj = first as Record<string, unknown>;

  if ('mapping' in obj && obj.mapping && typeof obj.mapping === 'object') {
    return 'chatgpt';
  }

  if ('chat_messages' in obj && Array.isArray(obj.chat_messages)) {
    return 'claude';
  }

  return null;
}
