#!/usr/bin/env tsx
/**
 * Create a B2B tenant with its initial config and emit one API key.
 *
 * Usage:
 *   pnpm tsx scripts/tenant-bootstrap.ts create <tenantId> \
 *     --system-prompt "..." \
 *     --primary "#0066cc" \
 *     --display-name "Acme" \
 *     --providers openai,anthropic \
 *     --default-provider openai \
 *     --rate-limit 100 \
 *     --origins "https://acme.com,https://www.acme.com"
 *
 * The API key is printed ONCE to stdout. It is not stored in cleartext;
 * loss requires rotation via `scripts/tenant-config.ts rotate-key`.
 */

import admin from 'firebase-admin';
import { createTenant, isValidTenantId } from '../src/b2b/tenants';

interface CliArgs {
  cmd: 'create';
  tenantId: string;
  systemPrompt: string;
  primaryColor: string;
  displayName: string;
  logoUrl: string | null;
  providers: string[];
  defaultProvider: string;
  rateLimit: number;
  origins: string[];
}

function parseArgs(argv: string[]): CliArgs {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags.set(key, 'true');
      } else {
        flags.set(key, next);
        i++;
      }
    }
  }

  const cmd = positional[0];
  const tenantId = positional[1];
  if (cmd !== 'create') {
    throw new Error(`unknown command "${cmd}" — only "create" is supported`);
  }
  if (!tenantId) {
    throw new Error('usage: tenant-bootstrap.ts create <tenantId> [--system-prompt ...] [--primary ...] ...');
  }

  const required = ['system-prompt', 'primary', 'display-name'] as const;
  for (const r of required) {
    if (!flags.has(r)) {
      throw new Error(`missing required flag --${r}`);
    }
  }

  return {
    cmd: 'create',
    tenantId,
    systemPrompt: flags.get('system-prompt')!,
    primaryColor: flags.get('primary')!,
    displayName: flags.get('display-name')!,
    logoUrl: flags.get('logo-url') ?? null,
    providers: (flags.get('providers') ?? 'openai').split(',').map((s) => s.trim()),
    defaultProvider: flags.get('default-provider') ?? 'openai',
    rateLimit: Number(flags.get('rate-limit') ?? '100'),
    origins: (flags.get('origins') ?? 'http://localhost:3000').split(',').map((s) => s.trim()),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!isValidTenantId(args.tenantId)) {
    console.error(`invalid tenantId "${args.tenantId}"`);
    console.error('must be 3-32 chars, lowercase letters/digits/dashes, no leading/trailing dash');
    process.exit(2);
  }

  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccount) {
    console.error('FIREBASE_SERVICE_ACCOUNT env var is required');
    process.exit(2);
  }
  if (admin.apps.length === 0) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(Buffer.from(serviceAccount, 'base64').toString('utf-8'))),
    });
  }

  const db = admin.firestore();
  try {
    const result = await createTenant(db, {
      tenantId: args.tenantId,
      systemPrompt: args.systemPrompt,
      branding: {
        primaryColor: args.primaryColor,
        logoUrl: args.logoUrl,
        displayName: args.displayName,
      },
      allowedProviders: args.providers,
      defaultProvider: args.defaultProvider,
      rateLimit: { messagesPerVisitorPerDay: args.rateLimit },
      allowedOrigins: args.origins,
    });

    console.log(`tenant "${result.tenantId}" created.`);
    console.log('');
    console.log('API key (SAVE THIS NOW — shown only once):');
    console.log(result.apiKey);
    console.log('');
    console.log(`API key id: ${result.apiKeyId}`);
    console.log(`hash stored at: b2bTenants/${result.tenantId}/apiKeys/${result.apiKeyId}`);
  } catch (err) {
    console.error(`create tenant failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
