import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  logCostEvent,
  setCostSink,
  type CostEvent,
  type CostSink,
} from './cost-telemetry';

// Capture sink: stores every event for assertion.
function makeCaptureSink(): { sink: CostSink; events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = [];
  return {
    events,
    sink: {
      write(event) {
        events.push(event);
      },
    },
  };
}

test('logCostEvent: writes a JSON-shaped record with all event fields + ISO timestamp', () => {
  const { sink, events } = makeCaptureSink();
  setCostSink(sink);
  const event: CostEvent = {
    provider: 'claude',
    batchSize: 20,
    inputTokens: 475000,
    outputTokens: 1200,
    latencyMs: 4500,
  };
  logCostEvent(event);
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.provider, 'claude');
  assert.equal(e.batchSize, 20);
  assert.equal(e.inputTokens, 475000);
  assert.equal(e.outputTokens, 1200);
  assert.equal(e.latencyMs, 4500);
  assert.match(e.timestamp as string, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('logCostEvent: multiple invocations write multiple records in order', () => {
  const { sink, events } = makeCaptureSink();
  setCostSink(sink);
  logCostEvent({ provider: 'claude', batchSize: 20, inputTokens: 100, outputTokens: 50, latencyMs: 100 });
  logCostEvent({ provider: 'chatgpt', batchSize: 10, inputTokens: 200, outputTokens: 80, latencyMs: 200 });
  assert.equal(events.length, 2);
  assert.equal(events[0].provider, 'claude');
  assert.equal(events[1].provider, 'chatgpt');
});

test('logCostEvent: optional model and requestId are passed through', () => {
  const { sink, events } = makeCaptureSink();
  setCostSink(sink);
  logCostEvent({
    provider: 'claude',
    batchSize: 20,
    inputTokens: 100,
    outputTokens: 50,
    latencyMs: 100,
    model: 'MiniMax-M3',
    requestId: 'req-abc-123',
  });
  assert.equal(events[0].model, 'MiniMax-M3');
  assert.equal(events[0].requestId, 'req-abc-123');
});

test('logCostEvent: sink can be swapped (prod uses firebase-admin logger)', () => {
  const { sink: a, events: aEvents } = makeCaptureSink();
  setCostSink(a);
  logCostEvent({ provider: 'claude', batchSize: 1, inputTokens: 1, outputTokens: 1, latencyMs: 1 });
  const { sink: b, events: bEvents } = makeCaptureSink();
  setCostSink(b);
  logCostEvent({ provider: 'chatgpt', batchSize: 1, inputTokens: 1, outputTokens: 1, latencyMs: 1 });
  assert.equal(aEvents.length, 1);
  assert.equal(bEvents.length, 1);
  assert.equal(aEvents[0].provider, 'claude');
  assert.equal(bEvents[0].provider, 'chatgpt');
});
