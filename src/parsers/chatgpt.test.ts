import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChatGPTConversations } from './chatgpt';

const MAX_RAW_BYTES = 800 * 1024;

// --- helpers to build ChatGPT-shaped trees concisely ---

type Node = {
  id: string;
  parent: string | null;
  weight?: number;
  message?: { author: { role: string }; content: { parts: unknown[] } } | null;
};

function buildConversation(opts: {
  id: string;
  title: string;
  create_time: number;
  nodes: Node[];
  currentNode: string | null;
}) {
  const mapping: Record<string, Node> = {};
  for (const n of opts.nodes) mapping[n.id] = n;
  return {
    id: opts.id,
    title: opts.title,
    create_time: opts.create_time,
    current_node: opts.currentNode,
    mapping,
  };
}

function userNode(id: string, parent: string | null, text: string, weight = 1): Node {
  return {
    id,
    parent,
    weight,
    message: { author: { role: 'user' }, content: { parts: [text] } },
  };
}

function assistantNode(id: string, parent: string | null, text: string, weight = 1): Node {
  return {
    id,
    parent,
    weight,
    message: { author: { role: 'assistant' }, content: { parts: [text] } },
  };
}

function systemNode(id: string, parent: string | null, text: string): Node {
  return {
    id,
    parent,
    weight: 0,
    message: { author: { role: 'system' }, content: { parts: [text] } },
  };
}

function toolNode(id: string, parent: string | null, text: string): Node {
  return {
    id,
    parent,
    weight: 1,
    message: { author: { role: 'tool' }, content: { parts: [text] } },
  };
}

function nullMessageNode(id: string, parent: string | null, weight = 1): Node {
  return { id, parent, weight, message: null };
}

// --- tests ---

test('parseChatGPTConversations: linear (no branches) produces messages in chronological order', () => {
  const conv = buildConversation({
    id: 'c-1',
    title: 'Linear',
    create_time: 1717171717.5,
    currentNode: 'n3',
    nodes: [
      userNode('n1', null, 'hi'),
      assistantNode('n2', 'n1', 'hello there'),
      userNode('n3', 'n2', 'how are you?'),
    ],
  });
  const out = parseChatGPTConversations([conv]);
  assert.equal(out.length, 1);
  const rec = out[0];
  assert.equal(rec.provider, 'chatgpt');
  assert.equal(rec.providerId, 'c-1');
  assert.equal(rec.title, 'Linear');
  assert.equal(rec.messageCount, 3);
  assert.equal(
    rec.rawText,
    'user: hi\nassistant: hello there\nuser: how are you?\n',
  );
});

test('parseChatGPTConversations: inactive branch (weight:0) is excluded from rawText', () => {
  // Active branch: n1 (user) → n2 (assistant). n1b is an alternate
  // user response with weight 0; it should not appear.
  const conv = buildConversation({
    id: 'c-1',
    title: 'Branches',
    create_time: 1717171717.5,
    currentNode: 'n2',
    nodes: [
      userNode('n1', null, 'pick a number'),
      assistantNode('n2', 'n1', 'three'),
      { id: 'n1b', parent: null, weight: 0, message: { author: { role: 'user' }, content: { parts: ['unpicked alt'] } } },
    ],
  });
  const out = parseChatGPTConversations([conv]);
  assert.equal(out[0].messageCount, 2);
  assert.equal(out[0].rawText, 'user: pick a number\nassistant: three\n');
});

test('parseChatGPTConversations: create_time as Unix float converts to correct Date (epoch ms)', () => {
  // Avoid TZ-dependent toISOString() in the assertion — compare epoch ms.
  const conv = buildConversation({
    id: 'c-1',
    title: 'Date',
    create_time: 1717171717.5,
    currentNode: 'n1',
    nodes: [userNode('n1', null, 'a')],
  });
  const out = parseChatGPTConversations([conv]);
  assert.equal(out[0].date.getTime(), 1717171717500);
});

test('parseChatGPTConversations: create_time integer seconds work', () => {
  const conv = buildConversation({
    id: 'c-1',
    title: 'Date',
    create_time: 1700000000,
    currentNode: 'n1',
    nodes: [userNode('n1', null, 'a')],
  });
  assert.equal(parseChatGPTConversations([conv])[0].date.getTime(), 1700000000000);
});

test('parseChatGPTConversations: content.parts with asset_pointer image is skipped; adjacent text included', () => {
  const conv = buildConversation({
    id: 'c-1',
    title: 'Image',
    create_time: 1717171717.5,
    currentNode: 'n2',
    nodes: [
      userNode('n1', null, 'look'),
      {
        id: 'n2',
        parent: 'n1',
        weight: 1,
        message: {
          author: { role: 'assistant' },
          content: {
            parts: [
              'Here it is: ',
              { asset_pointer: 'file-service://img-1', content_type: 'image/png' },
              ' — done.',
            ],
          },
        },
      },
    ],
  });
  const out = parseChatGPTConversations([conv]);
  assert.equal(out[0].messageCount, 2);
  assert.equal(out[0].rawText, 'user: look\nassistant: Here it is:  — done.\n');
});

test('parseChatGPTConversations: author.role:system is excluded', () => {
  const conv = buildConversation({
    id: 'c-1',
    title: 'Sys',
    create_time: 1717171717.5,
    currentNode: 'n2',
    nodes: [systemNode('n0', null, 'You are a helpful assistant.'), userNode('n1', 'n0', 'hi'), assistantNode('n2', 'n1', 'hello')],
  });
  const out = parseChatGPTConversations([conv]);
  assert.equal(out[0].messageCount, 2);
  assert.equal(out[0].rawText, 'user: hi\nassistant: hello\n');
});

test('parseChatGPTConversations: author.role:tool is excluded', () => {
  const conv = buildConversation({
    id: 'c-1',
    title: 'Tool',
    create_time: 1717171717.5,
    currentNode: 'n3',
    nodes: [
      userNode('n1', null, 'search'),
      toolNode('n2', 'n1', '{"results": [...]}'),
      assistantNode('n3', 'n2', 'found 3 results'),
    ],
  });
  const out = parseChatGPTConversations([conv]);
  assert.equal(out[0].messageCount, 2);
  assert.equal(out[0].rawText, 'user: search\nassistant: found 3 results\n');
});

test('parseChatGPTConversations: root with message:null is skipped without error', () => {
  // Some exports start with a null-message root before the first user
  // message — current_node may still be deep enough to find real text.
  const conv = buildConversation({
    id: 'c-1',
    title: 'NullRoot',
    create_time: 1717171717.5,
    currentNode: 'n2',
    nodes: [nullMessageNode('n0', null), userNode('n1', 'n0', 'hi'), assistantNode('n2', 'n1', 'hello')],
  });
  const out = parseChatGPTConversations([conv]);
  assert.equal(out[0].messageCount, 2);
  assert.equal(out[0].rawText, 'user: hi\nassistant: hello\n');
});

test('parseChatGPTConversations: current_node pointing at a missing id yields empty rawText, truncated:false', () => {
  const conv = {
    id: 'c-1',
    title: 'Broken',
    create_time: 1717171717.5,
    current_node: 'does-not-exist',
    mapping: {
      n1: { id: 'n1', parent: null, weight: 1, message: { author: { role: 'user' }, content: { parts: ['x'] } } },
    },
  };
  const out = parseChatGPTConversations([conv]);
  assert.equal(out[0].messageCount, 0);
  assert.equal(out[0].rawText, '');
  assert.equal(out[0].truncated, false);
});

test('parseChatGPTConversations: missing current_node yields empty rawText', () => {
  const conv = {
    id: 'c-1',
    title: 'NoLeaf',
    create_time: 1717171717.5,
    mapping: { n1: { id: 'n1', parent: null, weight: 1, message: { author: { role: 'user' }, content: { parts: ['x'] } } } },
  };
  const out = parseChatGPTConversations([conv]);
  assert.equal(out[0].messageCount, 0);
  assert.equal(out[0].rawText, '');
});

test('parseChatGPTConversations: empty input array returns []', () => {
  assert.deepEqual(parseChatGPTConversations([]), []);
});

test('parseChatGPTConversations: 900KB input truncates to ≤800KB with truncated:true', () => {
  // Same shape as the Claude truncation test — verify the cap works
  // on the linearized output.
  const lineText = 'x'.repeat(100 * 1024);
  const nodes: Node[] = [];
  for (let i = 0; i < 9; i++) {
    nodes.push({
      id: `n${i}`,
      parent: i === 0 ? null : `n${i - 1}`,
      weight: 1,
      message: {
        author: { role: i % 2 === 0 ? 'user' : 'assistant' },
        content: { parts: [lineText] },
      },
    });
  }
  const conv = buildConversation({
    id: 'big',
    title: 'Big',
    create_time: 1717171717.5,
    currentNode: 'n8',
    nodes,
  });
  const out = parseChatGPTConversations([conv]);
  const rec = out[0];
  assert.equal(rec.truncated, true);
  assert.ok(
    Buffer.byteLength(rec.rawText, 'utf8') <= MAX_RAW_BYTES,
    `rawText byte length ${Buffer.byteLength(rec.rawText, 'utf8')} must be <= ${MAX_RAW_BYTES}`,
  );
  assert.ok(rec.messageCount < 9, `expected messageCount < 9, got ${rec.messageCount}`);
  assert.ok(rec.messageCount > 0);
});

test('parseChatGPTConversations: falls back to conversation_id when id is missing', () => {
  const conv = {
    conversation_id: 'legacy-1',
    title: 'Legacy',
    create_time: 1717171717.5,
    current_node: 'n1',
    mapping: { n1: { id: 'n1', parent: null, weight: 1, message: { author: { role: 'user' }, content: { parts: ['hi'] } } } },
  };
  const out = parseChatGPTConversations([conv]);
  assert.equal(out[0].providerId, 'legacy-1');
});

test('parseChatGPTConversations: skips non-object conversation entries', () => {
  const out = parseChatGPTConversations([
    null,
    'not an object',
    buildConversation({
      id: 'a',
      title: 'real',
      create_time: 1717171717.5,
      currentNode: 'n1',
      nodes: [userNode('n1', null, 'hi')],
    }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].providerId, 'a');
});

test('parseChatGPTConversations: cycles in parent links are defended against', () => {
  // n1.parent = n2, n2.parent = n1 — pathological but possible in
  // hand-crafted exports. Should not loop forever.
  const conv = {
    id: 'c-1',
    title: 'Cycle',
    create_time: 1717171717.5,
    current_node: 'n1',
    mapping: {
      n1: { id: 'n1', parent: 'n2', weight: 1, message: { author: { role: 'user' }, content: { parts: ['a'] } } },
      n2: { id: 'n2', parent: 'n1', weight: 1, message: { author: { role: 'assistant' }, content: { parts: ['b'] } } },
    },
  };
  const out = parseChatGPTConversations([conv]);
  // Visits each node once, so messageCount is 2.
  assert.equal(out[0].messageCount, 2);
});

test('parseChatGPTConversations: parent pointing at missing id terminates the walk', () => {
  const conv = {
    id: 'c-1',
    title: 'BrokenParent',
    create_time: 1717171717.5,
    current_node: 'n2',
    mapping: {
      n1: { id: 'n1', parent: 'does-not-exist', weight: 1, message: { author: { role: 'user' }, content: { parts: ['a'] } } },
      n2: { id: 'n2', parent: 'n1', weight: 1, message: { author: { role: 'assistant' }, content: { parts: ['b'] } } },
    },
  };
  const out = parseChatGPTConversations([conv]);
  assert.equal(out[0].messageCount, 2);
  assert.equal(out[0].rawText, 'user: a\nassistant: b\n');
});
