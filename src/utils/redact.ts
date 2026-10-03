/**
 * Secret redaction.
 *
 * Agent runs touch real environments: source trees with `.env` files, CI runners with
 * tokens in env vars, prompts pasted from tickets. AgentSnap records runs to disk and
 * prints them to terminals, so redaction happens at the boundary and again on write.
 *
 * Two complementary strategies:
 *   1. Known-value redaction: every current env-var value that looks secret is collected
 *      and replaced verbatim wherever it appears. Catches project-specific secrets the
 *      generic patterns below would miss.
 *   2. Pattern redaction: assignment-shaped text (`FOO_TOKEN=...`, `Authorization: ...`,
 *      `sk-ant-...`, JWTs, AWS keys) is masked even when the value is unknown.
 */

const PLACEHOLDER = '***redacted***';

const VALUE_PATTERNS = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bAKIA[0-9A-Z]{16}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
];

const ASSIGNMENT_PATTERNS = [
  /((?:api[_-]?key|apikey|secret|token|password|passwd|pwd|credential|auth)[_-]?\w*\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;&}]+)/gi,
];

const SECRET_NAME = /(?:^|_)(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_KEY|ACCESS_KEY|SESSION|COOKIE|AUTH)(?:$|_)/i;

/**
 * Variables whose values are locations, not secrets.
 *
 * Without this list the entropy heuristic below masks `%TEMP%`, `%USERPROFILE%` and similar
 * values, which then corrupt every path AgentSnap prints (`***redacted***\project\...`).
 */
const LOCATION_NAME =
  /^(?:APPDATA|CDPATH|COMPUTERNAME|COMSPEC|HOME|HOMEDRIVE|HOMEPATH|LANG|LOCALAPPDATA|LOGONSERVER|NUMBER_OF_PROCESSORS|OLDPWD|OS|PATH|PROGRAMDATA|PROGRAMFILES(?:\(X86\))?|PSModulePath|PUBLIC|PWD|SHELL|SHLVL|SystemDrive|SystemRoot|TEMP|TERMINFO|TMP|TMPDIR|USERNAME|USERDOMAIN|USERPROFILE|WINDIR)$/i;

/** A value long enough to be worth masking when it looks random (binary-ish). */
function looksLikeSecretValue(value: string): boolean {
  if (value.length < 8) return false;
  if (/\s/.test(value)) return false;
  return /[A-Za-z]/.test(value) && /[0-9]/.test(value);
}

export interface Redactor {
  /** Masks a single string. */
  text(value: string): string;
  /** Recursively masks strings inside JSON-ish structures, dropping binary payloads. */
  value(value: unknown, maxDepth?: number): unknown;
}

/**
 * Builds a redactor from the live process environment.
 *
 * @param env source of literal secret values to mask. Defaults to `process.env`.
 * @param extraSecrets additional literals (for example values read from a config file).
 */
export function createRedactor(env: NodeJS.ProcessEnv = process.env, extraSecrets: string[] = []): Redactor {
  const literals = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string' || value.length < 8) continue;
    if (SECRET_NAME.test(name)) {
      literals.add(value);
      continue;
    }
    if (LOCATION_NAME.test(name)) continue;
    if (looksLikeSecretValue(value)) literals.add(value);
  }
  for (const secret of extraSecrets) {
    if (typeof secret === 'string' && secret.length >= 6) literals.add(secret);
  }

  const text = (value: string): string => {
    let output = value;
    for (const literal of literals) {
      if (literal.length >= 8 && output.includes(literal)) {
        output = output.split(literal).join(PLACEHOLDER);
      }
    }
    for (const pattern of VALUE_PATTERNS) output = output.replace(pattern, PLACEHOLDER);
    for (const pattern of ASSIGNMENT_PATTERNS) output = output.replace(pattern, `$1${PLACEHOLDER}`);
    return output;
  };

  const value = (input: unknown, maxDepth = 6): unknown => {
    if (input === null || input === undefined) return input;
    if (typeof input === 'string') return text(input);
    if (typeof input === 'number' || typeof input === 'boolean') return input;
    if (typeof input === 'bigint') return input.toString();
    if (input instanceof Date) return input.toISOString();
    if (maxDepth <= 0) return '…';
    if (Array.isArray(input)) return input.slice(0, 500).map((item) => value(item, maxDepth - 1));
    if (Buffer.isBuffer(input)) return `<buffer ${input.byteLength} bytes>`;
    if (typeof input === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
        out[key] = SECRET_NAME.test(key) ? PLACEHOLDER : value(item, maxDepth - 1);
      }
      return out;
    }
    return String(input);
  };

  return { text, value };
}

/** Names of env vars whose values are treated as secret (used by `agentsnap doctor`). */
export function secretEnvNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env)
    .filter((name) => SECRET_NAME.test(name))
    .sort();
}

export { PLACEHOLDER as REDACTION_PLACEHOLDER };
