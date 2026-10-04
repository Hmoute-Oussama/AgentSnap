/**
 * The adapter names AgentSnap ships with.
 *
 * This lives in its own leaf module so configuration validation can check `agent.provider`
 * without importing the adapter runtime: a config that names a provider we do not have must
 * fail during `agentsnap validate`, not halfway through a test run.
 *
 * `tests/unit/adapters.test.ts` asserts this list stays in sync with the registry.
 */
export const KNOWN_PROVIDERS = ['claude-code', 'fake'] as const;

export type KnownProvider = (typeof KNOWN_PROVIDERS)[number];

export function isKnownProvider(value: string): value is KnownProvider {
  return (KNOWN_PROVIDERS as readonly string[]).includes(value);
}