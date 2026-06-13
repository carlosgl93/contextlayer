/**
 * Shared TypeScript interfaces for the ContextLayer import pipeline.
 *
 * These shapes are directional — fields may evolve as parsers, extraction,
 * and persistence land. Keep the canonical definitions here so server,
 * plugins, and routes can import a single source of truth.
 */

export type Provider = 'claude' | 'chatgpt';

export interface ConversationRecord {
  provider: Provider;
  providerId: string;
  title: string;
  date: Date;
  messageCount: number;
  rawText: string;
  truncated: boolean;
}

export interface ExtractionSignal {
  value: string;
  provider: string;
  source: string; // conversation title where the signal was observed
}

export interface ExtractionResult {
  preferences: ExtractionSignal[];
  personalFacts: ExtractionSignal[];
  activeIntentions: ExtractionSignal[];
  domainsOfInterest: ExtractionSignal[];
}

/**
 * Shape attached to `request.user` by the auth middleware after a
 * successful Firebase ID token verification.
 */
export interface AuthenticatedUser {
  uid: string;
  email?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}
