import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectProvider } from './detect';

test('detectProvider returns "claude" when first item has chat_messages', () => {
  const parsed = [
    {
      uuid: 'c-1',
      name: 'Trip planning',
      chat_messages: [{ sender: 'human', text: 'hi' }],
    },
  ];
  assert.equal(detectProvider(parsed), 'claude');
});

test('detectProvider returns "chatgpt" when first item has mapping', () => {
  const parsed = [
    {
      id: 'g-1',
      title: 'Cooking',
      mapping: { 'n-1': { id: 'n-1', message: null } },
    },
  ];
  assert.equal(detectProvider(parsed), 'chatgpt');
});

test('detectProvider returns null for an empty array', () => {
  assert.equal(detectProvider([]), null);
});

test('detectProvider returns null for a non-array input', () => {
  assert.equal(detectProvider({ chat_messages: [] }), null);
  assert.equal(detectProvider(null), null);
  assert.equal(detectProvider('not an array'), null);
});

test('detectProvider returns null when first item has neither marker', () => {
  assert.equal(detectProvider([{ id: 'x', title: 'mystery' }]), null);
  assert.equal(detectProvider([{ chat_messages: 'not-an-array' }]), null);
  assert.equal(detectProvider([{ mapping: 'not-an-object' }]), null);
});

test('detectProvider inspects only the first item', () => {
  // First item is Claude, second is ChatGPT-shaped — still claude.
  const parsed = [
    { chat_messages: [] },
    { mapping: {} },
  ];
  assert.equal(detectProvider(parsed), 'claude');
});
