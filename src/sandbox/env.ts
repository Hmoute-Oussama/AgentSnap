/**
 * Environment allow-list for child processes.
 *
 * AgentSnap runs third-party CLIs with the user's full environment by default, which is a
 * needless exposure: a crashing or malicious agent process would see tokens unrelated to
 * the test. We therefore forward an explicit allow-list plus whatever the config opts in.
 */

export interface EnvPolicy {
  /** Variable names always forwarded when present. */
  base: readonly string[];
  /** Additional names forwarded because the adapter needs them. */
  inherit: readonly string[];
  /** Literal values added or overridden from config. */
  overrides: Record<string, string>;
  /** Names explicitly removed even if they would otherwise be inherited. */
  deny: readonly string[];
}

export const BASE_ENV_ALLOWLIST: readonly string[] = [
  // Process and temp dirs (required by most runtimes, mandatory on Windows).
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'TMPDIR',
  'TEMP',
  'TMP',
  // Executable resolution.
  'PATH',
  // Locale and time.
  'LANG',
  'LC_ALL',
  'TZ',
];

export const DEFAULT_DENY_LIST: readonly string[] = [
  // CI plumbing leaks runner tokens into agent processes.
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_RUNTIME_TOKEN',
  'NPM_TOKEN',
  // Interactive credentials.
  'SSH_AUTH_SOCK',
  'GPG_TKEY',
];

/**
 * Builds the child environment.
 *
 * Values in `overrides` may reference host variables with `${NAME}` so config files can
 * stay free of literal secrets.
 */
export function buildChildEnv(policy: EnvPolicy, host: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const deny = new Set(policy.deny);
  const env: NodeJS.ProcessEnv = {};

  for (const name of policy.base) {
    if (deny.has(name)) continue;
    const value = host[name];
    if (value !== undefined) env[name] = value;
  }
  for (const name of policy.inherit) {
    if (deny.has(name)) continue;
    const value = host[name];
    if (value !== undefined) env[name] = value;
  }

  for (const [name, value] of Object.entries(policy.overrides)) {
    if (deny.has(name)) continue;
    env[name] = expandEnvValue(value, host);
  }
  return env;
}

/** Resolves `${VAR}` and `$VAR` references inside a configured value. */
export function expandEnvValue(value: string, host: NodeJS.ProcessEnv = process.env): string {
  if (!value.includes('$')) return value;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced?: string, bare?: string) => {
    const name = (braced ?? bare) as string;
    return host[name] ?? '';
  });
}
