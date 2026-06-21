import OpenAI from 'openai';
import type { ChatCompletionChunk } from 'openai/resources/chat';

/**
 * LLM streaming client.
 *
 * Wraps the OpenAI SDK (which also works against any OpenAI-
 * compatible endpoint via `baseURL`). The default points at the
 * same MiniMax-compatible base the extraction pipeline uses
 * (`MINIMAX_BASE_URL`) so the chat route and the extraction
 * pipeline share one provider per process.
 *
 * For V1 only the OpenAI-compatible protocol is supported. A
 * future Anthropic adapter goes behind the same `streamChat`
 * surface — `provider` selects the adapter and the rest of the
 * pipeline is provider-agnostic.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StreamChatOptions {
  provider: string;
  model?: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
  onToken: (token: string) => void;
  openaiClient?: OpenAI;
}

export interface StreamChatResult {
  inputTokens: number;
  outputTokens: number;
  finishReason: string | null;
}

const DEFAULT_MODEL = process.env.MINIMAX_CHAT_MODEL ?? 'MiniMax-M3';

export function defaultChatClient(): OpenAI {
  return new OpenAI({
    apiKey: process.env.MINIMAX_API_KEY,
    baseURL: process.env.MINIMAX_BASE_URL ?? 'https://api.minimax.io/v1',
  });
}

/**
 * Stream a chat completion. Calls `onToken` for each incremental
 * delta and resolves once the provider closes the stream. Throws
 * on connection errors and on non-OK HTTP statuses so the route
 * can surface a clean SSE error event.
 *
 * Token counts come from the final chunk's `usage` field; not
 * every provider emits usage on streams, so the function tolerates
 * a missing usage payload (returns zeros) rather than waiting for
 * it.
 */
export async function streamChat(opts: StreamChatOptions): Promise<StreamChatResult> {
  if (opts.provider !== 'openai' && opts.provider !== 'MiniMax') {
    throw new Error(`unsupported provider: ${opts.provider}`);
  }
  const client = opts.openaiClient ?? defaultChatClient();
  const model = opts.model ?? DEFAULT_MODEL;

  const stream = await client.chat.completions.create(
    {
      model,
      messages: opts.messages,
      stream: true,
    },
    { signal: opts.signal },
  );

  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason: string | null = null;

  for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
    if (opts.signal?.aborted) break;
    const choice = chunk.choices?.[0];
    const delta = choice?.delta?.content;
    if (typeof delta === 'string' && delta.length > 0) opts.onToken(delta);
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
      outputTokens = chunk.usage.completion_tokens ?? outputTokens;
    }
  }

  return { inputTokens, outputTokens, finishReason };
}
