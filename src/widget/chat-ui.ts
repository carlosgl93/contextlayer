import type { SessionCheckOk, WidgetConfig } from './types';

/**
 * The Web Component: `<contextlayer-chat>`.
 *
 * Two visual states:
 *   - "signed out" — bubble + panel with a "Sign in to ContextLayer" CTA
 *   - "signed in"  — bubble + panel with a chat input
 *
 * The component is intentionally framework-free (no React, no
 * lit). The whole bundle needs to be < 30KB gzipped to keep
 * Time-To-Interactive low for B2B customers embedding us on
 * marketing pages. CSS is bundled as a string and injected once
 * on first mount (see mount.ts).
 *
 * The component reads CSS custom properties from its host for
 * brand overrides:
 *   --contextlayer-primary    color (default: #0066cc)
 *   --contextlayer-position   'left' | 'right' (default: right)
 *
 * The send handler is supplied by the parent (mount.ts) because
 * it depends on the streaming chat client (U5). For v1 the send
 * handler can be omitted; the input becomes read-only and a
 * "Coming soon" message replaces the empty state.
 *
 * XSS posture: only `textContent` is used for any user-controlled
 * value (displayName, message text). The static icon SVG is built
 * with DOM construction rather than innerHTML to keep the
 * surface small and to avoid future regressions if a template
 * literal ever interpolates untrusted data.
 */

export type SessionState = { kind: 'anon'; signInUrl: string } | { kind: 'auth'; session: SessionCheckOk };

export interface ChatComponentOptions {
  tenantId: string;
  config: WidgetConfig;
  session: SessionState;
  onSignInClick: () => void;
  onSend?: (text: string) => Promise<void> | void;
}

const WIDGET_CSS = `
:host {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 2147483000;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #111;
  --cl-primary: var(--contextlayer-primary, #0066cc);
  --cl-position: var(--contextlayer-position, right);
}
:host([data-position="left"]) { right: auto; left: 24px; }
* { box-sizing: border-box; }
.bubble {
  width: 56px; height: 56px; border-radius: 50%;
  background: var(--cl-primary); border: none; cursor: pointer;
  box-shadow: 0 6px 20px rgba(0,0,0,0.18);
  display: flex; align-items: center; justify-content: center;
  transition: transform 120ms ease;
}
.bubble:hover { transform: scale(1.06); }
.bubble svg { width: 26px; height: 26px; fill: #fff; }
.panel {
  position: absolute; bottom: 72px; right: 0;
  width: 360px; max-width: calc(100vw - 48px);
  height: 520px; max-height: calc(100vh - 120px);
  background: #fff; border-radius: 16px;
  box-shadow: 0 24px 64px rgba(0,0,0,0.18);
  display: none; flex-direction: column; overflow: hidden;
}
:host([data-position="left"]) .panel { right: auto; left: 0; }
.panel[data-open="true"] { display: flex; }
.header {
  padding: 16px; color: #fff;
  background: var(--cl-primary);
  display: flex; align-items: center; gap: 10px;
}
.header img { width: 28px; height: 28px; border-radius: 6px; object-fit: cover; }
.header h2 { margin: 0; font-size: 15px; font-weight: 600; }
.body {
  flex: 1; padding: 16px; overflow-y: auto;
  font-size: 14px; line-height: 1.5; color: #333;
}
.cta {
  display: block; width: 100%; padding: 12px 16px;
  background: var(--cl-primary); color: #fff;
  border: none; border-radius: 8px; font-size: 14px;
  font-weight: 600; cursor: pointer;
}
.cta:hover { filter: brightness(1.08); }
.input-row {
  padding: 12px; border-top: 1px solid #eee;
  display: flex; gap: 8px;
}
.input-row input {
  flex: 1; padding: 10px 12px;
  border: 1px solid #ddd; border-radius: 8px;
  font-size: 14px; outline: none;
}
.input-row input:focus { border-color: var(--cl-primary); }
.input-row button {
  padding: 10px 14px; background: var(--cl-primary);
  color: #fff; border: none; border-radius: 8px;
  font-weight: 600; cursor: pointer;
}
.input-row button:disabled { opacity: 0.5; cursor: not-allowed; }
`;

function buildIconSvg(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute(
    'd',
    'M3 4.5C3 3.67 3.67 3 4.5 3h15c.83 0 1.5.67 1.5 1.5v11c0 .83-.67 1.5-1.5 1.5H8l-4 4v-4H4.5c-.83 0-1.5-.67-1.5-1.5v-11z',
  );
  svg.appendChild(path);
  return svg;
}

let _ContextLayerChat: CustomElementConstructor | null = null;

if (typeof HTMLElement !== 'undefined') {
  _ContextLayerChat = class extends HTMLElement {
    private open = false;
    private tenantId = '';
    private config: WidgetConfig | null = null;
    private session: SessionState | null = null;
    private onSignInClick: () => void = () => {};
    private onSend: ((text: string) => Promise<void> | void) | undefined;

    static get observedAttributes() {
      return ['data-position'];
    }

    connectedCallback() {
      this.render();
    }

    configure(opts: ChatComponentOptions): void {
      this.tenantId = opts.tenantId;
      this.config = opts.config;
      this.session = opts.session;
      this.onSignInClick = opts.onSignInClick;
      this.onSend = opts.onSend;
      this.render();
    }

    setSession(session: SessionState): void {
      this.session = session;
      this.render();
    }

    private render(): void {
      this.replaceChildren();

      const bubble = document.createElement('button');
      bubble.className = 'bubble';
      bubble.setAttribute('aria-label', 'Open chat');
      bubble.appendChild(buildIconSvg());
      bubble.addEventListener('click', () => this.togglePanel());
      this.appendChild(bubble);

      const panel = document.createElement('div');
      panel.className = 'panel';
      panel.setAttribute('data-open', String(this.open));

      const header = document.createElement('div');
      header.className = 'header';
      if (this.config?.branding.logoUrl) {
        const img = document.createElement('img');
        img.src = this.config.branding.logoUrl;
        img.alt = '';
        header.appendChild(img);
      }
      const title = document.createElement('h2');
      title.textContent = this.config?.branding.displayName ?? 'ContextLayer';
      header.appendChild(title);
      panel.appendChild(header);

      const body = document.createElement('div');
      body.className = 'body';
      if (this.session?.kind === 'anon') {
        const p = document.createElement('p');
        const name = this.config?.branding.displayName ?? 'us';
        p.textContent = `Sign in to chat with ${name}. Your conversation history will be available across all ContextLayer sites you visit.`;
        body.appendChild(p);
      } else {
        const p = document.createElement('p');
        p.textContent = 'Ask anything. Your conversation stays in this tab.';
        p.style.color = '#666';
        body.appendChild(p);
      }
      panel.appendChild(body);

      if (this.session?.kind === 'anon') {
        const cta = document.createElement('button');
        cta.className = 'cta';
        cta.textContent = 'Sign in to ContextLayer';
        cta.addEventListener('click', () => this.onSignInClick());
        panel.appendChild(cta);
      } else {
        const inputRow = document.createElement('div');
        inputRow.className = 'input-row';
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'Type a message…';
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && input.value.trim()) void this.send(input, inputRow);
        });
        const sendBtn = document.createElement('button');
        sendBtn.textContent = 'Send';
        sendBtn.addEventListener('click', () => {
          if (input.value.trim()) void this.send(input, inputRow);
        });
        inputRow.appendChild(input);
        inputRow.appendChild(sendBtn);
        panel.appendChild(inputRow);
      }

      this.appendChild(panel);
    }

    private togglePanel(): void {
      this.open = !this.open;
      const panel = this.querySelector('.panel');
      if (panel) panel.setAttribute('data-open', String(this.open));
    }

    private async send(input: HTMLInputElement, row: HTMLElement): Promise<void> {
      const text = input.value.trim();
      if (!text || !this.onSend) return;
      input.disabled = true;
      const btn = row.querySelector('button') as HTMLButtonElement | null;
      btn?.setAttribute('disabled', '');
      try {
        await this.onSend(text);
      } finally {
        input.disabled = false;
        btn?.removeAttribute('disabled');
        input.value = '';
        input.focus();
      }
    }
  };
}

let defined = false;

export function defineChatElement(): void {
  if (defined || typeof customElements === 'undefined' || !_ContextLayerChat) return;
  customElements.define('contextlayer-chat', _ContextLayerChat);
  defined = true;
}

export function injectWidgetStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.querySelector('style[data-contextlayer-widget]')) return;
  const style = document.createElement('style');
  style.setAttribute('data-contextlayer-widget', '');
  style.textContent = WIDGET_CSS;
  document.head.appendChild(style);
}
