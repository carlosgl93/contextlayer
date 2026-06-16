/**
 * Founder PoC smoke test — full Track 1 import path against a live server.
 *
 * 1. Reads founder ZIP from disk
 * 2. Phase 1: POST /api/v1/import/upload (no confirmed) — prints cost estimate
 * 3. Phase 2: POST /api/v1/import/upload?confirmed=true — runs the import
 * 4. GET /api/v1/profile — prints the synthesized profile
 *
 * Assumes:
 *   - .env loaded (FIREBASE_* + MINIMAX_*)
 *   - server running on http://localhost:3000 with CGL_DEV_AUTH_BYPASS=1
 *   - founder ZIP at the path below
 *
 * Run with:
 *   pnpm tsx scripts/smoke-import.ts
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE_URL = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';
const DEV_TOKEN = 'dev:founder-smoke:cg@local';
const FOUNDER_ZIP = resolve(
  process.cwd(),
  'data-1ce0e1e5-88a7-40f9-9c82-e36ebac60a13-1781361730-7eca1830-batch-0000.zip',
);

interface ProviderRow {
  provider: string;
  conversationCount: number;
  estimatedTokens: number;
  estimatedCostUsd: string;
  importId?: string;
  extraction?: {
    preferences: unknown[];
    personalFacts: unknown[];
    activeIntentions: unknown[];
    domainsOfInterest: unknown[];
  };
}

interface ImportResponse {
  providers?: ProviderRow[];
  total?: { providers: number; conversationCount: number; estimatedTokens: number; estimatedCostUsd: string };
  confirmed: boolean;
  error?: string;
  failedFiles?: Array<{ name: string; code: string; message: string }>;
}

interface ProfileResponse {
  preferences: unknown[];
  personalFacts: unknown[];
  activeIntentions: unknown[];
  domainsOfInterest: unknown[];
  updatedAt: string;
  error?: string;
}

function log(step: string, detail: unknown): void {
  console.log(`\n=== ${step} ===`);
  console.log(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2));
}

async function postUpload(zipBuf: Buffer, confirmed: boolean): Promise<ImportResponse> {
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(zipBuf)], { type: 'application/zip' }), 'founder.zip');
  form.set('confirmed', confirmed ? 'true' : 'false');

  // Phase 2 (confirmed=true) runs LLM extraction + Firestore writes for the
  // whole dataset; for 208 convos / 11 batches this can take 5-10 min.
  // undici's default 5-min headers timeout is too tight — lift it explicitly.
  const timeoutMs = confirmed ? 15 * 60_000 : 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${BASE_URL}/api/v1/import/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DEV_TOKEN}` },
      body: form,
      signal: controller.signal,
    });
    const body = (await res.json()) as ImportResponse;
    if (!res.ok) {
      throw new Error(`POST /import/upload ${confirmed ? 'phase2' : 'phase1'} → ${res.status}: ${JSON.stringify(body)}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function getProfile(): Promise<ProfileResponse> {
  const res = await fetch(`${BASE_URL}/api/v1/profile`, {
    headers: { Authorization: `Bearer ${DEV_TOKEN}` },
  });
  const body = (await res.json()) as ProfileResponse;
  if (res.status === 404) {
    return { ...body, preferences: [], personalFacts: [], activeIntentions: [], domainsOfInterest: [], updatedAt: '' };
  }
  if (!res.ok) {
    throw new Error(`GET /profile → ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function main(): Promise<void> {
  log('config', {
    baseUrl: BASE_URL,
    devToken: DEV_TOKEN,
    founderZip: FOUNDER_ZIP,
    zipBytes: readFileSync(FOUNDER_ZIP).length,
  });

  // Phase 1: cost preview
  const phase1 = await postUpload(readFileSync(FOUNDER_ZIP), false);
  log('phase 1 — cost preview', {
    confirmed: phase1.confirmed,
    providers: phase1.providers?.map((p) => ({
      provider: p.provider,
      conversationCount: p.conversationCount,
      estimatedTokens: p.estimatedTokens,
      estimatedCostUsd: p.estimatedCostUsd,
    })),
    total: phase1.total,
  });

  // Phase 2: actual import (runs LLM extraction + Firestore write)
  const phase2 = await postUpload(readFileSync(FOUNDER_ZIP), true);
  log('phase 2 — import complete', {
    confirmed: phase2.confirmed,
    providers: phase2.providers?.map((p) => ({
      provider: p.provider,
      conversationCount: p.conversationCount,
      importId: p.importId,
      extractionCounts: p.extraction && {
        preferences: p.extraction.preferences.length,
        personalFacts: p.extraction.personalFacts.length,
        activeIntentions: p.extraction.activeIntentions.length,
        domainsOfInterest: p.extraction.domainsOfInterest.length,
      },
    })),
  });

  // Profile read
  const profile = await getProfile();
  log('profile read', {
    preferences: profile.preferences.length,
    personalFacts: profile.personalFacts.length,
    activeIntentions: profile.activeIntentions.length,
    domainsOfInterest: profile.domainsOfInterest.length,
    totalSignals:
      profile.preferences.length +
      profile.personalFacts.length +
      profile.activeIntentions.length +
      profile.domainsOfInterest.length,
    updatedAt: profile.updatedAt,
    samplePref: profile.preferences[0],
  });
}

main().catch((err: unknown) => {
  console.error('\nSMOKE FAILED:', err);
  process.exit(1);
});
