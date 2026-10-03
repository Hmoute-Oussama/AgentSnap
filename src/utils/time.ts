import { setTimeout as delay } from 'node:timers/promises';

export function nowMs(): number {
  return Date.now();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return delay(ms, undefined, { signal });
}

/**
 * Buckets a duration into a coarse label so snapshots stay deterministic.
 *
 * Wall-clock durations are noisy by nature; recording the bucket instead of the exact
 * millisecond keeps snapshot diffs meaningful (no noise) while still catching
 * order-of-magnitude performance changes.
 */
export function durationBucket(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  if (ms < 1_000) return '<1s';
  if (ms < 10_000) return '1-10s';
  if (ms < 30_000) return '10-30s';
  if (ms < 60_000) return '30-60s';
  if (ms < 300_000) return '1-5m';
  return '>5m';
}

export interface Timer {
  /** Milliseconds since the timer was created. */
  elapsed(): number;
  /** Stable label of the elapsed time, for snapshots. */
  bucket(): string;
}

export function startTimer(): Timer {
  const start = nowMs();
  return {
    bucket: () => durationBucket(nowMs() - start),
    elapsed: () => nowMs() - start,
  };
}
