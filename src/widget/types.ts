/**
 * Shared types for the widget bundle.
 *
 * These mirror the server-side shapes but are intentionally
 * narrower — the bundle only sees fields it needs. Keep this
 * file pure types + tiny constants; no runtime imports.
 */

export interface WidgetConfig {
  tenantId: string;
  systemPrompt: string;
  branding: {
    primaryColor: string;
    logoUrl: string | null;
    displayName: string;
  };
  allowedProviders: string[];
  defaultProvider: string;
  rateLimit: { messagesPerVisitorPerDay: number };
}

export interface SessionCheckOk {
  authenticated: true;
  visitorId: string;
  created: boolean;
}

export interface SessionCheckAnon {
  authenticated: false;
  signInUrl: string;
}

export type SessionCheckResult = SessionCheckOk | SessionCheckAnon;

export interface AuthSuccessMessage {
  type: 'contextlayer-auth-success';
  visitorId: string;
  /**
   * HMAC-SHA256(visitorId, tenantSecret) hex-encoded. The widget
   * verifies this against the public verification endpoint to
   * make sure the message actually came from auth.contextlayer.io
   * and not a malicious opener. v1 may ship without this; see
   * auth-popup.ts.
   */
  signature?: string;
}

export type AuthMessage = AuthSuccessMessage;

export const AUTH_MESSAGE_TYPE = 'contextlayer-auth-success' as const;
export const AUTH_POPUP_ORIGIN = 'https://auth.contextlayer.io' as const;

export function isSessionCheckOk(
  v: SessionCheckResult,
): v is SessionCheckOk {
  return v.authenticated === true;
}
