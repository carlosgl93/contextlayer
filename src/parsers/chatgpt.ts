import type { ConversationRecord } from '../types';

/**
 * ChatGPT export parser.
 *
 * Accepts the parsed `conversations.json` array (already validated as
 * ChatGPT-shaped by `detectProvider`) and returns a normalized
 * `ConversationRecord[]`. Pure function — no I/O.
 *
 * Per conversation: extract `id` (or `conversation_id`), `title`, and
 * `create_time` (Unix seconds with fractional ms, multiply by 1000 to
 * get a JS `Date`).
 *
 * ChatGPT conversations are stored as a tree of nodes in `mapping`.
 * Each node has `parent` (a nodeId or null) and a `message` (or null).
 * The active branch is the chain starting at `current_node` and
 * walking up via `parent` until null.
 *
 * Only nodes on that active branch with:
 *   - non-null `message`
 *   - `author.role` ∈ {user, assistant}
 *   - `weight >= 1`
 * contribute to the output. Text comes from `message.content.parts`,
 * filtered to string entries (image `asset_pointer` objects are
 * dropped).
 *
 * Each extracted message becomes `${role}: ${text}\n` in `rawText`,
 * capped at 800KB (UTF-8 bytes) with `truncated: true` when the cap
 * is hit.
 */
const MAX_RAW_BYTES = 800 * 1024;

type ChatGPTConversation = {
  id?: unknown;
  conversation_id?: unknown;
  title?: unknown;
  create_time?: unknown;
  current_node?: unknown;
  mapping?: unknown;
};

type ChatGPTNode = {
  id?: unknown;
  parent?: unknown;
  weight?: unknown;
  message?: unknown;
};

type ChatGPTMessage = {
  author?: unknown;
  content?: unknown;
};

type ChatGPTAuthor = {
  role?: unknown;
};

function isUserOrAssistantRole(role: unknown): role is 'user' | 'assistant' {
  return role === 'user' || role === 'assistant';
}

function extractPartsText(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  let out = '';
  for (const p of parts) {
    if (typeof p === 'string') {
      out += p;
    }
    // Anything else (object with asset_pointer, etc.) is dropped —
    // we only carry text forward.
  }
  return out;
}

function extractMessageText(msg: ChatGPTMessage): string | null {
  if (!msg || typeof msg !== 'object') return null;
  const content = msg.content;
  if (!content || typeof content !== 'object') return null;
  const parts = (content as { parts?: unknown }).parts;
  const text = extractPartsText(parts);
  return text.length > 0 ? text : null;
}

function linearize(conversation: ChatGPTConversation): Array<{ role: 'user' | 'assistant'; text: string }> {
  const mapping = conversation.mapping;
  if (!mapping || typeof mapping !== 'object') return [];

  const map = mapping as Record<string, ChatGPTNode>;
  const startId =
    typeof conversation.current_node === 'string' ? conversation.current_node : null;
  if (!startId || !(startId in map)) return [];

  const stack: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  let nodeId: string | null = startId;
  // Track visited nodeIds to defend against pathological cycles.
  const visited = new Set<string>();

  while (nodeId) {
    if (visited.has(nodeId)) break;
    visited.add(nodeId);
    const node: ChatGPTNode | undefined = map[nodeId];
    if (!node || typeof node !== 'object') break;

    const weight: unknown = node.weight;
    if (typeof weight === 'number' && weight >= 1) {
      const message: unknown = node.message;
      if (message && typeof message === 'object') {
        const author = (message as ChatGPTMessage).author as ChatGPTAuthor | undefined;
        const role = author?.role;
        if (isUserOrAssistantRole(role)) {
          const text = extractMessageText(message as ChatGPTMessage);
          if (text !== null) {
            stack.push({ role, text });
          }
        }
      }
    }

    const parent: unknown = node.parent;
    nodeId = typeof parent === 'string' && parent in map ? parent : null;
  }

  // Walked leaf → root, so reverse to get root → leaf order.
  return stack.reverse();
}

function parseUnixSeconds(input: unknown): Date {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return new Date(input * 1000);
  }
  return new Date(0);
}

export function parseChatGPTConversations(
  parsed: unknown[],
): ConversationRecord[] {
  const out: ConversationRecord[] = [];

  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue;
    const conv = raw as ChatGPTConversation;

    const providerId =
      (typeof conv.id === 'string' && conv.id) ||
      (typeof conv.conversation_id === 'string' && conv.conversation_id) ||
      `unknown-${out.length}`;
    const title = typeof conv.title === 'string' ? conv.title : '';
    const date = parseUnixSeconds(conv.create_time);

    const messages = linearize(conv);

    let rawText = '';
    let messageCount = 0;
    let truncated = false;

    for (const { role, text } of messages) {
      const line = `${role}: ${text}\n`;

      if (Buffer.byteLength(rawText, 'utf8') + Buffer.byteLength(line, 'utf8') > MAX_RAW_BYTES) {
        truncated = true;
        break;
      }
      rawText += line;
      messageCount++;
    }

    out.push({
      provider: 'chatgpt',
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
