import type { Readable } from 'node:stream';

/** Stderr is captured only to explain a non-zero exit; the tail is what matters. */
const STDERR_TAIL_LIMIT = 4000;

/**
 * Splits a byte stream into lines without buffering the whole stream.
 *
 * Used for NDJSON output (`--output-format stream-json`), where a partially-written line at
 * a chunk boundary must not be parsed as a record.
 */
export async function* readLines(stream: Readable | null): AsyncGenerator<string> {
  if (stream === null) return;
  stream.setEncoding('utf8');
  let buffer = '';
  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : String(chunk);
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.trim() !== '') yield line;
      index = buffer.indexOf('\n');
    }
  }
  const rest = buffer.trim();
  if (rest !== '') yield rest;
}

/** Keeps only the last {@link STDERR_TAIL_LIMIT} characters of a captured stderr buffer. */
export function stderrTail(captured: string): string {
  if (captured.length <= STDERR_TAIL_LIMIT) return captured.trim();
  return `…${captured.slice(-STDERR_TAIL_LIMIT).trim()}`;
}

/**
 * Parses a stdout line as a JSON record.
 *
 * Returns `undefined` instead of throwing: runtimes legitimately print non-JSON diagnostics
 * (progress bars, warnings) alongside their structured stream, and one unparsable line must
 * never abort a run.
 */
export function parseJsonLine(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}