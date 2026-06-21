#!/usr/bin/env tsx
/**
 * Read, set, or list B2B tenant config fields.
 *
 * Usage:
 *   pnpm tsx scripts/tenant-config.ts list
 *   pnpm tsx scripts/tenant-config.ts get <tenantId>
 *   pnpm tsx scripts/tenant-config.ts set <tenantId> <dotted.path> <value>
 *   pnpm tsx scripts/tenant-config.ts rotate-key <tenantId>
 *
 * Examples:
 *   tenant-config.ts set acme rateLimit.messagesPerVisitorPerDay 500
 *   tenant-config.ts set acme systemPrompt "You are AcmeBot v2."
 *   tenant-config.ts set acme allowedOrigins "https://acme.com,https://staging.acme.com"
 *
 * Note: `set` only writes to the `config` doc. To rotate the API key,
 * use `rotate-key` (it appends a new key record and marks the old one
 * inactive — the new key is printed once, same as bootstrap).
 */

import admin from 'firebase-admin';
import { randomBytes, createHash } from 'node:crypto';
import { getTenantConfig, listTenants, setTenantField, generateApiKey } from '../src/b2b/tenants';

function ensureFirebase(): admin.app.App {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccount) {
    console.error('FIREBASE_SERVICE_ACCOUNT env var is required');
    process.exit(2);
  }
  if (admin.apps.length === 0) {
    return admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(Buffer.from(serviceAccount, 'base64').toString('utf-8'))),
    });
  }
  return admin.apps[0]!;
}

async function cmdList(db: admin.firestore.Firestore): Promise<void> {
  const tenants = await listTenants(db);
  if (tenants.length === 0) {
    console.log('no tenants');
    return;
  }
  console.log(`${tenants.length} tenant(s):`);
  for (const t of tenants) {
    const cfg = await getTenantConfig(db, t);
    const rateLimit = cfg?.rateLimit.messagesPerVisitorPerDay ?? '?';
    const providers = cfg?.allowedProviders.join(',') ?? '?';
    console.log(`  ${t}  rate=${rateLimit}/day  providers=[${providers}]`);
  }
}

async function cmdGet(db: admin.firestore.Firestore, tenantId: string): Promise<void> {
  const cfg = await getTenantConfig(db, tenantId);
  if (!cfg) {
    console.error(`tenant "${tenantId}" not found`);
    process.exit(1);
  }
  console.log(JSON.stringify(cfg, null, 2));
}

function coerceValue(raw: string): unknown {
  // Booleans and numbers inline; otherwise string.
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (/^-?\d+\.\d+$/.test(raw)) return Number(raw);
  // Comma-separated list -> string[].
  if (raw.includes(',')) return raw.split(',').map((s) => s.trim());
  return raw;
}

async function cmdSet(
  db: admin.firestore.Firestore,
  tenantId: string,
  path: string,
  rawValue: string,
): Promise<void> {
  await setTenantField(db, tenantId, path, coerceValue(rawValue));
  console.log(`set ${tenantId}.${path}`);
}

async function cmdRotateKey(db: admin.firestore.Firestore, tenantId: string): Promise<void> {
  const existing = await getTenantConfig(db, tenantId);
  if (!existing) {
    console.error(`tenant "${tenantId}" not found`);
    process.exit(1);
  }

  const apiKeysSnap = await db.collection('b2bTenants').doc(tenantId).collection('apiKeys').get();
  const batch = db.batch();
  for (const d of apiKeysSnap.docs) {
    batch.update(d.ref, { active: false });
  }
  const { key, hash, keyId } = generateApiKey();
  batch.set(
    db.collection('b2bTenants').doc(tenantId).collection('apiKeys').doc(keyId),
    {
      keyHash: hash,
      scopes: ['widget:read', 'chat:write'],
      createdAt: new Date(),
      lastUsedAt: null,
      active: true,
    },
  );
  await batch.commit();

  console.log(`rotated API key for "${tenantId}". Old keys marked inactive.`);
  console.log('');
  console.log('New API key (SAVE THIS NOW — shown only once):');
  console.log(key);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  ensureFirebase();
  const db = admin.firestore();

  switch (cmd) {
    case 'list':
      await cmdList(db);
      break;
    case 'get':
      if (!argv[1]) throw new Error('usage: tenant-config.ts get <tenantId>');
      await cmdGet(db, argv[1]);
      break;
    case 'set':
      if (!argv[1] || !argv[2]) {
        throw new Error('usage: tenant-config.ts set <tenantId> <dotted.path> <value>');
      }
      await cmdSet(db, argv[1], argv[2], argv[3] ?? '');
      break;
    case 'rotate-key':
      if (!argv[1]) throw new Error('usage: tenant-config.ts rotate-key <tenantId>');
      await cmdRotateKey(db, argv[1]);
      break;
    default:
      console.error(`unknown command "${cmd}"`);
      console.error('usage: tenant-config.ts <list|get|set|rotate-key> ...');
      process.exit(2);
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
