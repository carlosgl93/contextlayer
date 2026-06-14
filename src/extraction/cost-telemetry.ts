import type { Provider } from '../types';

/**
 * Structured cost-telemetry logger for U5 (MiniMax M3 extraction).
 *
 * One event per LLM call: `provider`, `batchSize`, `inputTokens`,
 * `outputTokens`, `latencyMs`, plus optional `model` and `requestId`.
 * Each event is enriched with an ISO timestamp and handed to the
 * configured sink.
 *
 * Default sink: writes one JSON line per event to stdout. In dev this
 * keeps events greppable; in prod the sink can be swapped for the
 * Firebase Admin logger via `setCostSink()` so events flow into
 * Cloud Logging.
 */
export interface CostEvent {
  provider: Provider;
  batchSize: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  model?: string;
  requestId?: string;
}

export interface CostEventRecord extends CostEvent {
  timestamp: string;
}

export interface CostSink {
  write(event: CostEventRecord): void;
}

const stdoutSink: CostSink = {
  write(event) {
    process.stdout.write(JSON.stringify(event) + '\n');
  },
};

let activeSink: CostSink = stdoutSink;

/**
 * Replace the active sink. Pass a custom sink to redirect events to
 * the Firebase Admin logger or a test capture. Pass nothing to
 * restore the default stdout sink.
 */
export function setCostSink(sink?: CostSink): void {
  activeSink = sink ?? stdoutSink;
}

/**
 * Emit a single cost event to the active sink.
 */
export function logCostEvent(event: CostEvent): void {
  activeSink.write({ ...event, timestamp: new Date().toISOString() });
}
