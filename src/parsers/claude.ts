import type { ConversationRecord } from '../types';

/**
 * Claude export parser.
 *
 * Accepts the parsed `conversations.json` array (already validated as
 * Claude-shaped by `detectProvider`) and returns a normalized
 * `ConversationRecord[]`. Pure function — no I/O, no Firestore, no
 * logger. The caller is responsible for streaming/caching if the
 * array is huge.
 *
 * Per conversation: extract `uuid`, `name`, `created_at` (ISO-8601).
 * Walk `chat_messages[]` in order. For each message:
 *   - map `sender: "human"` → role `"user"`, `"assistant"` stays
 *   - extract text: prefer the top-level `text` field if non-empty;
 *     otherwise scan `content[]` for the first block of
 *     `type: "text"` and use its `text` field
 *   - skip the message entirely if no text can be extracted (e.g.
 *     content blocks are all `tool_use` / `tool_result` / `thinking`)
 *
 * Each extracted message becomes `${role}: ${text}\n` in `rawText`.
 * The result is capped at 800KB (UTF-8 bytes). When the cap is hit
 * the remaining messages are dropped and `truncated: true` is set.
 *
 * An empty `chat_messages` array is valid — it produces a record
 * with `messageCount: 0` and `rawText: ""`.
 */
const MAX_RAW_BYTES = 800 * 1024;

type ClaudeConversation = {
  uuid?: unknown;
  name?: unknown;
  created_at?: unknown;
  chat_messages?: unknown;
};

type ClaudeMessage = {
  sender?: unknown;
  text?: unknown;
  content?: unknown;
};

type ContentBlock = {
  type?: unknown;
  text?: unknown;
};

function roleFor(sender: unknown): 'user' | 'assistant' | null {
  if (sender === 'human') return 'user';
  if (sender === 'assistant') return 'assistant';
  return null;
}

function extractText(msg: ClaudeMessage): string | null {
  if (typeof msg.text === 'string' && msg.text.length > 0) {
    return msg.text;
  }
  if (Array.isArray(msg.content)) {
    for (const block of msg.content as ContentBlock[]) {
      if (
        block &&
        block.type === 'text' &&
        typeof block.text === 'string' &&
        block.text.length > 0
      ) {
        return block.text;
      }
    }
  }
  return null;
}

function parseDate(input: unknown): Date {
  if (typeof input === 'string') {
    const d = new Date(input);
    if (!Number.isNaN(d.getTime())) return d;
  }
  // Fallback: epoch zero. Caller can detect via the record downstream
  // if needed; for the PoC we just want a stable Date instance.
  return new Date(0);
}

export function parseClaudeConversations(
  parsed: unknown[],
): ConversationRecord[] {
  const out: ConversationRecord[] = [];

  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue;
    const conv = raw as ClaudeConversation;

    const providerId =
      typeof conv.uuid === 'string' && conv.uuid.length > 0
        ? conv.uuid
        : `unknown-${out.length}`;
    const title = typeof conv.name === 'string' ? conv.name : '';
    const date = parseDate(conv.created_at);

    const messages = Array.isArray(conv.chat_messages)
      ? (conv.chat_messages as ClaudeMessage[])
      : [];

    let rawText = '';
    let messageCount = 0;
    let truncated = false;

    for (const msg of messages) {
      const role = roleFor(msg?.sender);
      if (!role) continue;
      const text = extractText(msg);
      if (text === null) continue;

      messageCount++;
      const line = `${role}: ${text}\n`;

      // Byte-wise cap to keep documents under Firestore's 1MB limit
      // with margin for metadata. Truncation drops the line that
      // would push us over — counted above, but not stored.
      if (Buffer.byteLength(rawText, 'utf8') + Buffer.byteLength(line, 'utf8') > MAX_RAW_BYTES) {
        truncated = true;
        break;
      }
      rawText += line;
    }

    out.push({
      provider: 'claude',
      providerId,
      title,
      date,
      messageCount,
      rawText,
      truncated,
    });
  }

  return out;
}
