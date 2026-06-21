import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveVisitorId, tenantIdForVisitor } from './visitor-id';

test('deriveVisitorId: format vs_<12 chars base62>', () => {
  const v = deriveVisitorId('uid_alice', 'acme');
  assert.match(v, /^vs_[0-9A-Za-z]{12}$/);
});

test('deriveVisitorId: deterministic for same uid+tenantId', () => {
  const a = deriveVisitorId('uid_alice', 'acme');
  const b = deriveVisitorId('uid_alice', 'acme');
  assert.equal(a, b);
});

test('deriveVisitorId: cross-tenant unique for same uid', () => {
  const a = deriveVisitorId('uid_alice', 'acme');
  const b = deriveVisitorId('uid_alice', 'globex');
  assert.notEqual(a, b);
});

test('deriveVisitorId: cross-uid unique for same tenant', () => {
  const a = deriveVisitorId('uid_alice', 'acme');
  const b = deriveVisitorId('uid_bob', 'acme');
  assert.notEqual(a, b);
});

test('deriveVisitorId: high collision resistance across 1000 uids', () => {
  // Sanity check: with 12 base62 chars (62^12 ≈ 3.2e21) we should
  // never collide by chance for a realistic sample size.
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    const v = deriveVisitorId(`uid_${i}`, 'acme');
    assert.ok(!seen.has(v), `unexpected collision at i=${i}`);
    seen.add(v);
  }
});

test('tenantIdForVisitor: finds the tenantId that maps to a visitorId', () => {
  const v = deriveVisitorId('uid_alice', 'acme');
  assert.equal(tenantIdForVisitor(v, 'uid_alice', ['globex', 'acme', 'initech']), 'acme');
});

test('tenantIdForVisitor: returns null when no match', () => {
  const v = deriveVisitorId('uid_alice', 'acme');
  assert.equal(tenantIdForVisitor(v, 'uid_alice', ['globex', 'initech']), null);
});

test('tenantIdForVisitor: ignores wrong uid', () => {
  const v = deriveVisitorId('uid_alice', 'acme');
  assert.equal(tenantIdForVisitor(v, 'uid_bob', ['acme']), null);
});