/**
 * SSE stream consumer for the chat endpoint.
 *
 * The server (U5) emits tokens as `data: <token>\n\n` chunks
 * following the SSE spec. On `data: [DONE]\n\n` the stream
 * closes. On error the server emits `data: {"error":"..."}\n\n`
 * and closes.
 *
 * v1 uses `fetch` + `ReadableStream` rather than `EventSource`
 * because the request is POST (not GET) and we need to send the
 * visitor's message in the body.
 */

export interface StreamChatOptions {
  apiBase: string;
  tenantId: string;
  message: string;
  visitorId: string;
  onToken: (token: string) => void;
  onDone: () => void;
  onError: (err: Error) => void;
  signal?: AbortSignal;
}

export async function streamChat(opts: StreamChatOptions): Promise<void> {
  const url = `${opts.apiBase}/api/v1/widget/chat?tenant=${encodeURIComponent(opts.tenantId)}&visitor_id=${encodeURIComponent(opts.visitorId)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: opts.message }),
      signal: opts.signal,
    });
  } catch (err) {
    opts.onError(err instanceof Error ? err : new Error(String(err)));
    return;
  }

  if (!res.ok || !res.body) {
    opts.onError(new Error(`chat failed: ${res.status}`));
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const line = event.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          opts.onDone();
          return;
        }
        try {
          const parsed = JSON.parse(payload) as { token?: string; error?: string };
          if (parsed.error) {
            opts.onError(new Error(parsed.error));
            return;
          }
          if (typeof parsed.token === 'string') opts.onToken(parsed.token);
        } catch {
          // raw text token (not JSON)
          if (payload) opts.onToken(payload);
        }
      }
    }
    opts.onDone();
  } catch (err) {
    opts.onError(err instanceof Error ? err : new Error(String(err)));
  } finally {
    reader.releaseLock();
  }
}
