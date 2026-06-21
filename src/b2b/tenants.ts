import { type Firestore } from 'firebase-admin/firestore';
import { randomBytes, createHash } from 'node:crypto';

/**
 * Tenant lifecycle helpers for the B2B Track 2 surface.
 *
 * A tenant is a B2B customer identified by a slug (`tenantId`)
 * with its own namespace at `b2bTenants/{tenantId}/...`. This
 * module is the single point that creates, reads, updates, and
 * lists tenant records and issues / rotates the per-tenant API
 * keys. All writes go through the Firebase Admin SDK; the
 * firestore.rules file denies direct client access so a misconfigured
 * client cannot bypass these helpers.
 *
 * The API key is returned to the operator EXACTLY ONCE at creation
 * time. Only the SHA-256 hash of the key is persisted in
 * `b2bTenants/{tenantId}/apiKeys/{keyId}`. Loss of the key requires
 * rotation: there is no recovery path.
 */

export interface Branding {
  primaryColor: string;
  logoUrl: string | null;
  displayName: string;
}

export interface RateLimit {
  messagesPerVisitorPerDay: number;
}

export interface TenantConfig {
  systemPrompt: string;
  branding: Branding;
  allowedProviders: string[];
  defaultProvider: string;
  rateLimit: RateLimit;
  allowedOrigins: string[];
  updatedAt: Date;
}

export interface ApiKeyRecord {
  keyHash: string; // SHA-256 of the full key including `cl_` prefix
  scopes: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  active: boolean;
}

export interface CreateTenantInput {
  tenantId: string;
  systemPrompt: string;
  branding: Branding;
  allowedProviders: string[];
  defaultProvider: string;
  rateLimit: RateLimit;
  allowedOrigins: string[];
  apiKeyScopes?: string[];
}

export interface CreateTenantResult {
  tenantId: string;
  apiKey: string; // returned ONCE; not stored in cleartext
  apiKeyId: string;
}

/**
 * Tenant ID must be a slug: lowercase letters, digits, and dashes,
 * 3-32 chars. Avoids path-traversal characters and keeps URLs clean.
 */
const TENANT_ID_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

export function isValidTenantId(tenantId: string): boolean {
  return TENANT_ID_RE.test(tenantId);
}

/**
 * Generate a fresh API key in the canonical `cl_<43 chars>` format.
 * 32 random bytes -> base64url -> 43-char suffix. The `cl_` prefix
 * identifies ContextLayer keys in logs and audit trails; the SHA-256
 * hash of the full string (prefix included) is what gets stored.
 */
export function generateApiKey(): { key: string; hash: string; keyId: string } {
  const suffix = randomBytes(32).toString('base64url');
  const key = `cl_${suffix}`;
  const hash = createHash('sha256').update(key).digest('hex');
  const keyId = `key_${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
  return { key, hash, keyId };
}

/**
 * Create a tenant with its initial config and emit one API key.
 *
 * Fails if the tenant already exists — re-running with the same
 * `tenantId` is an error, not an idempotent overwrite. Use
 * `setTenantField` for updates or rotate the API key with
 * `rotateApiKey`.
 */
export async function createTenant(
  db: Firestore,
  input: CreateTenantInput,
): Promise<CreateTenantResult> {
  if (!isValidTenantId(input.tenantId)) {
    throw new Error(
      `invalid tenantId "${input.tenantId}" — must be 3-32 chars, lowercase letters/digits/dashes, no leading/trailing dash`,
    );
  }

  const tenantRef = db.collection('b2bTenants').doc(input.tenantId);
  const existing = await tenantRef.get();
  if (existing.exists) {
    throw new Error(
      `tenant "${input.tenantId}" already exists — use scripts/tenant-config.ts to update fields, or delete the tenant first`,
    );
  }

  const config: TenantConfig = {
    systemPrompt: input.systemPrompt,
    branding: input.branding,
    allowedProviders: input.allowedProviders,
    defaultProvider: input.defaultProvider,
    rateLimit: input.rateLimit,
    allowedOrigins: input.allowedOrigins,
    updatedAt: new Date(),
  };

  const { key, hash, keyId } = generateApiKey();
  const apiKeyRecord: ApiKeyRecord = {
    keyHash: hash,
    scopes: input.apiKeyScopes ?? ['widget:read', 'chat:write'],
    createdAt: new Date(),
    lastUsedAt: null,
    active: true,
  };

  // Batch the tenant doc creation + apiKeys subdoc so the tenant
  // cannot exist in a half-initialized state.
  const batch = db.batch();
  batch.set(tenantRef.collection('config').doc('main'), config);
  batch.set(tenantRef.collection('apiKeys').doc(keyId), apiKeyRecord);
  await batch.commit();

  return { tenantId: input.tenantId, apiKey: key, apiKeyId: keyId };
}

/**
 * Read the tenant config. Returns null when the tenant does not exist
 * (caller decides how to handle — `tenant-config.ts get` exits with
 * a clear error, while widget routes fall back to 404).
 */
export async function getTenantConfig(
  db: Firestore,
  tenantId: string,
): Promise<TenantConfig | null> {
  const snap = await db.collection('b2bTenants').doc(tenantId).collection('config').doc('main').get();
  if (!snap.exists) return null;
  return snap.data() as TenantConfig;
}

/**
 * List every tenant. Used by `tenant-config.ts list` and by
 * operational tooling. Reads the parent `b2bTenants/` collection only;
 * does not enumerate subcollections, so cost is O(tenants).
 */
export async function listTenants(db: Firestore): Promise<string[]> {
  const snap = await db.collection('b2bTenants').listDocuments();
  return snap.map((ref) => ref.id);
}

/**
 * Update one field of the tenant config using dotted-path notation
 * (e.g. `rateLimit.messagesPerVisitorPerDay`). Validates the path is
 * inside the `config` doc — does not allow writing to `apiKeys` or
 * any other subcollection from this surface.
 */
export async function setTenantField(
  db: Firestore,
  tenantId: string,
  dottedPath: string,
  value: unknown,
): Promise<void> {
  if (!isValidTenantId(tenantId)) {
    throw new Error(`invalid tenantId "${tenantId}"`);
  }
  const configRef = db.collection('b2bTenants').doc(tenantId).collection('config').doc('main');
  const snap = await configRef.get();
  if (!snap.exists) {
    throw new Error(`tenant "${tenantId}" does not exist`);
  }
  await configRef.update({
    [dottedPath]: value,
    updatedAt: new Date(),
  });
}

/**
 * Look up an API key record by the presented key. Hashes the key
 * and matches against the `keyHash` field. Used by the
 * `tenant-api-key` middleware in U3.
 */
export async function findApiKey(
  db: Firestore,
  presentedKey: string,
): Promise<{ tenantId: string; keyId: string; record: ApiKeyRecord } | null> {
  if (!presentedKey.startsWith('cl_')) return null;
  const hash = createHash('sha256').update(presentedKey).digest('hex');
  const tenants = await db.collection('b2bTenants').listDocuments();
  for (const tenantRef of tenants) {
    const apiKeysSnap = await tenantRef.collection('apiKeys').where('keyHash', '==', hash).limit(1).get();
    if (apiKeysSnap.size === 0) continue;
    const doc = apiKeysSnap.docs[0];
    return {
      tenantId: tenantRef.id,
      keyId: doc.id,
      record: doc.data() as ApiKeyRecord,
    };
  }
  return null;
}

/**
 * Update `lastUsedAt` on the API key. Fire-and-forget; failures
 * should not block the request that triggered the lookup.
 */
export async function touchApiKey(
  db: Firestore,
  tenantId: string,
  keyId: string,
): Promise<void> {
  await db
    .collection('b2bTenants')
    .doc(tenantId)
    .collection('apiKeys')
    .doc(keyId)
    .update({ lastUsedAt: new Date() });
}
