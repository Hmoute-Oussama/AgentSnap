import { ExitCode } from './exit-codes.js';

/**
 * Every error surfaced to the user answers three questions:
 *   1. What happened?
 *   2. Why did it probably happen?
 *   3. How do I fix it?
 */
export interface ErrorContext {
  /** Actionable, specific instructions. */
  fixes?: string[];
  /** A single command worth trying, rendered verbatim. */
  hint?: string;
  /** Most likely root causes, ordered by likelihood. */
  causes?: string[];
}

export interface AgentSnapErrorOptions extends ErrorContext {
  cause?: unknown;
}

/** Base class for every error AgentSnap raises on purpose. */
export class AgentSnapError extends Error {
  readonly exitCode: number;
  readonly code: string;
  readonly causes: string[];
  readonly fixes: string[];
  readonly hint: string | undefined;

  constructor(code: string, exitCode: number, message: string, options: AgentSnapErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.exitCode = exitCode;
    this.causes = options.causes ?? [];
    this.fixes = options.fixes ?? [];
    this.hint = options.hint;
  }

  /** Renders the full actionable block used by the CLI and the JSON reporter. */
  format(): string {
    const lines: string[] = [this.message];
    if (this.causes.length > 0) {
      lines.push('', 'Possible causes:');
      for (const cause of this.causes) lines.push(`  - ${cause}`);
    }
    if (this.fixes.length > 0) {
      lines.push('', 'Try:', ...this.fixes.map((fix) => `  - ${fix}`));
    }
    if (this.hint) lines.push('', `Run \`${this.hint}\` for a full diagnostic.`);
    return lines.join('\n');
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      causes: this.causes,
      fixes: this.fixes,
      hint: this.hint,
    };
  }
}

/** Configuration is missing, malformed, or fails validation. */
export class ConfigError extends AgentSnapError {
  constructor(message: string, options: AgentSnapErrorOptions = {}) {
    super('E_CONFIG', ExitCode.ConfigError, message, options);
  }
}

/** Invalid CLI usage (unknown command, bad flag combination). */
export class UsageError extends AgentSnapError {
  constructor(message: string, options: AgentSnapErrorOptions = {}) {
    super('E_USAGE', ExitCode.ConfigError, message, options);
  }
}

/** Infrastructure failure: agent missing, spawn failed, sandbox broken. */
export class RuntimeError extends AgentSnapError {
  constructor(message: string, options: AgentSnapErrorOptions = {}) {
    super('E_RUNTIME', ExitCode.RuntimeError, message, options);
  }
}

/** A configured timeout was exceeded. */
export class TimeoutError extends AgentSnapError {
  constructor(message: string, options: AgentSnapErrorOptions = {}) {
    super('E_TIMEOUT', ExitCode.Timeout, message, options);
  }
}

/** Sandbox could not be created or violated its contract. */
export class SandboxError extends RuntimeError {
  constructor(message: string, options: AgentSnapErrorOptions = {}) {
    super(message, options);
    Object.defineProperty(this, 'code', { value: 'E_SANDBOX' });
  }
}

export function isAgentSnapError(value: unknown): value is AgentSnapError {
  return value instanceof AgentSnapError;
}

/** Best-effort message extraction for arbitrary thrown values. */
export function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
